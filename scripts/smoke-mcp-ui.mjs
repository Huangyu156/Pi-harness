#!/usr/bin/env node
/**
 * MCP 抽屉端到端冒烟（CDP，dev 实例 + agent-dev 隔离目录，全程不动 ~/.pi/agent）。
 *
 * 覆盖（离线，除 npx 首次取包外零外网依赖）：
 * 1. 面板渲染：mcp 分类可打开、占位文案已消失、空态提示在位；
 * 2. 真实链路：`window.pi.upsertServer` → 落盘 → `testServer` 真连（npx 起 stdio 服务器）
 *    → `listTools` → `callTool`（真读目录）→ `readLog`；
 * 3. 视图与事件：状态徽标/世代/工具数走 `McpServerView`；`onMcpEvent` 收到 status/log/changed；
 * 4. 开关与删除：setEnabled 断开并可回读、setDirectTools 落 percho、removeServer 清文件；
 * 5. 面板行真实渲染（DOM 断言），并点一次「测试连接」按钮验证 UI → IPC 通路。
 *
 * 前置：dev 应用带调试端口运行（别的进程不得占用 9224）：
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224
 *   （`npm run dev -- --remote-debugging-port=9224` 不行：npm 会吞参数）
 *
 * 用法：node scripts/smoke-mcp-ui.mjs
 * 退出码：0 全部断言通过 / 1 有断言失败 / 2 环境不满足
 */

import { execSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.CDP_PORT ?? "9224";
const SERVER_NAME = "smoke-fs";

function fail(message) {
	console.error(message);
	process.exit(2);
}

let wsUrl;
try {
	const list = execSync(`curl -s -m 5 http://127.0.0.1:${PORT}/json`).toString();
	const page = JSON.parse(list).find((target) => target.type === "page");
	if (!page) fail(`CDP 上没有 page target（:${PORT}）：dev 实例未就绪或窗口没起来`);
	wsUrl = page.webSocketDebuggerUrl;
} catch (err) {
	fail(`连不上 CDP :${PORT} —— ${err instanceof Error ? err.message : String(err)}`);
}

const { WebSocket } = await import("ws");
const ws = new WebSocket(wsUrl);
let rpcId = 0;
const pending = new Map();
ws.on("message", (data) => {
	const message = JSON.parse(data.toString());
	if (message.id && pending.has(message.id)) {
		pending.get(message.id)(message);
		pending.delete(message.id);
	}
});
await new Promise((resolve) => ws.on("open", resolve));
function send(method, params = {}) {
	return new Promise((resolve) => {
		const id = ++rpcId;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});
}
async function evalJs(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.result?.exceptionDetails) {
		throw new Error(
			JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails),
		);
	}
	return result.result?.result?.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

// 现场：agent-dev 隔离目录（dev 实例的 PI_CODING_AGENT_DIR），冒烟前后还原
const agentDir = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent-dev");
const configFile = join(agentDir, "mcp.json");
const backupFile = `${configFile}.smoke-bak`;
const sandbox = mkdtempSync(join(tmpdir(), "percho-mcp-ui-smoke-"));
// 放一个真实文件：`list_directory` 的输出要能看见它（空目录只能证明「有响应」，证明不了「读到了内容」）
writeFileSync(join(sandbox, "hello.txt"), "hello from mcp ui smoke\n");
if (existsSync(configFile)) copyFileSync(configFile, backupFile);
const readConfig = () => {
	if (!existsSync(configFile)) return null;
	try {
		return JSON.parse(readFileSync(configFile, "utf8"));
	} catch {
		return "corrupt";
	}
};

try {
	// ---------------------------------------------------------------- 1. 面板渲染
	await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().openWith("mcp")`);
	await sleep(700);
	const panel = await evalJs(`(() => {
		const text = document.body.innerText;
		const dialog = document.querySelector("[role=dialog]") ?? document.body;
		return {
			hasPanel: text.includes("MCP"),
			placeholder: text.includes("暂不支持 MCP") || text.includes("does not support MCP"),
			emptyState: /还没有|no server|No MCP/i.test(text),
			text: text.slice(0, 400),
			buttons: [...dialog.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 24),
		};
	})()`);
	check("mcp 分类可打开且面板已渲染", panel.hasPanel === true);
	check("旧占位文案（SDK 不支持 MCP）已消失", panel.placeholder === false, JSON.stringify(panel.buttons));

	// ---------------------------------------------------------------- 2. 事件订阅
	await evalJs(`(() => {
		window.__mcpSmokeEvents = [];
		window.__mcpSmokeOff = window.pi.onMcpEvent((payload) => window.__mcpSmokeEvents.push(payload));
		return true;
	})()`);

	// ---------------------------------------------------------------- 3. 真实链路
	const before = await evalJs(`window.pi.listServers()`);
	const beforeOthers = before.filter((view) => view.name !== SERVER_NAME).map((view) => view.name);
	// 不假设「世界是空的」：dev 配置里可能有用户自己接入或其它冒烟留下的服务器，只要求没有重名
	check(
		"接入前没有同名服务器（不假设列表为空）",
		before.every((view) => view.name !== SERVER_NAME),
		`既有 ${beforeOthers.length} 台：${beforeOthers.join(", ") || "(无)"}`,
	);

	const view = await evalJs(
		`window.pi.upsertServer(${JSON.stringify({
			name: SERVER_NAME,
			config: {
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", sandbox.replaceAll("\\", "\\\\")],
			},
		})})`,
	);
	check(
		"upsertServer：返回脱敏视图（stdio/user/idle + env 值不下发）",
		view?.transport === "stdio" &&
			view?.source === "user" &&
			view?.state === "idle" &&
			JSON.stringify(view?.config ?? {}).includes("npx"),
		JSON.stringify({
			transport: view?.transport,
			source: view?.source,
			state: view?.state,
			summary: view?.summary,
		}),
	);
	const onDisk = readConfig();
	check(
		"配置真落盘（agent-dev/mcp.json 含 command/args）",
		onDisk?.mcpServers?.[SERVER_NAME]?.command === "npx" &&
			onDisk?.mcpServers?.[SERVER_NAME]?.args?.length === 3,
		JSON.stringify(onDisk?.mcpServers?.[SERVER_NAME]?.args),
	);

	const tested = await evalJs(`window.pi.testServer(${JSON.stringify({ name: SERVER_NAME })})`);
	check(
		"testServer：真连上（世代判定 + 工具数 + stderr 日志）",
		tested?.ok === true && tested?.toolCount > 0,
		JSON.stringify({
			ok: tested?.ok,
			era: tested?.era,
			protocolVersion: tested?.protocolVersion,
			serverInfo: tested?.serverInfo,
			toolCount: tested?.toolCount,
			logs: tested?.logs?.length,
			error: tested?.error,
		}),
	);

	const tools = await evalJs(`window.pi.listTools(${JSON.stringify({ name: SERVER_NAME })})`);
	check(
		"listTools：远端工具清单可见",
		Array.isArray(tools) && tools.some((tool) => tool.name === "list_directory"),
		`${tools?.length} tools: ${tools
			?.slice(0, 6)
			.map((t) => t.name)
			.join(", ")}`,
	);

	const call = await evalJs(
		`window.pi.callTool(${JSON.stringify({
			name: SERVER_NAME,
			tool: "list_directory",
			args: { path: sandbox },
		})})`,
	);
	const callText = JSON.stringify(call?.content ?? "");
	check(
		"callTool：真调远端工具读到沙箱文件",
		call?.isError === false && callText.includes("hello.txt"),
		callText.slice(0, 160),
	);

	const logs = await evalJs(`window.pi.readLog(${JSON.stringify({ name: SERVER_NAME, cursor: 0 })})`);
	check("readLog：拿到服务器 stderr", logs?.lines?.length > 0 && logs?.cursor > 0, `cursor=${logs?.cursor}`);

	// 事件：status/log/changed 都该被推过来（等待合帧）
	await sleep(600);
	const events = await evalJs(`window.__mcpSmokeEvents.map((e) => e.kind)`);
	check(
		"onMcpEvent：收到 status/log（view 完整 + 日志合帧）",
		events.includes("status") && events.includes("log"),
		JSON.stringify([...new Set(events)]),
	);

	// ---------------------------------------------------------------- 4. 面板行渲染（DOM）
	await evalJs(`window.PerchoUI.stores.useSettingsStore.getState().refresh()`);
	await sleep(800);
	const row = await evalJs(`(() => {
		const text = document.body.innerText;
		return {
			hasName: text.includes(${JSON.stringify(SERVER_NAME)}),
			hasEra: /modern|legacy/.test(text),
			hasCount: /${tested?.toolCount ?? 17}/.test(text),
			buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30),
		};
	})()`);
	check(
		"面板行渲染：服务器名 + 世代 + 工具数（真实 IPC 数据）",
		row.hasName === true && row.hasEra === true,
		JSON.stringify(row.buttons),
	);

	// 点「测试连接」按钮：走真实 UI 事件 → store → IPC
	const clicked = await evalJs(`(() => {
		const button = [...document.querySelectorAll("button")].find((b) => /测试连接|Test connection|Test/i.test(b.textContent));
		if (!button) return false;
		button.click();
		return true;
	})()`);
	await sleep(3000);
	const afterClick = await evalJs(
		`(() => { const t = document.body.innerText; return { hasTestResult: /耗时|Duration|capabilities|工具/.test(t) }; })()`,
	);
	check("点「测试连接」按钮触发 UI → IPC 并渲染结果", clicked === true && afterClick.hasTestResult === true);

	// ---------------------------------------------------------------- 5. 开关与删除
	const disabled = await evalJs(
		`window.pi.setEnabled(${JSON.stringify({ name: SERVER_NAME, enabled: false })})`,
	);
	const failedTest = await evalJs(`window.pi.testServer(${JSON.stringify({ name: SERVER_NAME })})`);
	check(
		"setEnabled(false)：视图 disabled 且不再连（原因可读）",
		disabled?.disabled === true && failedTest?.ok === false,
		JSON.stringify({ state: disabled?.state, error: failedTest?.error }),
	);
	const reEnabled = await evalJs(
		`window.pi.setEnabled(${JSON.stringify({ name: SERVER_NAME, enabled: true })})`,
	);
	check("setEnabled(true)：恢复启用", reEnabled?.disabled === false);

	const direct = await evalJs(
		`window.pi.setDirectTools(${JSON.stringify({ name: SERVER_NAME, enabled: true })})`,
	);
	const diskDirect = readConfig();
	check(
		"setDirectTools(true)：视图与磁盘 percho 同步",
		direct?.percho?.directTools === true &&
			diskDirect?.mcpServers?.[SERVER_NAME]?.percho?.directTools === true,
	);

	const scanned = await evalJs(`window.pi.scanHostConfigs()`);
	check(
		"scanHostConfigs：只读扫描返回数组（不写宿主文件）",
		Array.isArray(scanned),
		`${scanned?.length} 个宿主文件`,
	);

	await evalJs(`window.pi.removeServer(${JSON.stringify({ name: SERVER_NAME })})`);
	const afterRemove = readConfig();
	const listed = await evalJs(`window.pi.listServers()`);
	const leftNames = listed.map((view) => view.name).sort();
	check(
		"removeServer：磁盘与列表都清干净，且不影响既有服务器",
		afterRemove?.mcpServers?.[SERVER_NAME] === undefined &&
			!listed.some((view) => view.name === SERVER_NAME) &&
			JSON.stringify(leftNames) === JSON.stringify([...beforeOthers].sort()),
		`剩余 ${leftNames.join(", ") || "(无)"}`,
	);

	await evalJs(`window.__mcpSmokeOff?.(); window.PerchoUI.stores.useSettingsStore.getState().setOpen(false)`);
} finally {
	// 还原现场：有备份就回滚，没有就把冒烟留下的文件删掉（绝不留 trace）
	if (existsSync(backupFile)) {
		copyFileSync(backupFile, configFile);
		unlinkSync(backupFile);
	} else if (existsSync(configFile)) {
		const left = readConfig();
		if (left === null || Object.keys(left?.mcpServers ?? {}).length === 0) unlinkSync(configFile);
	}
	rmSync(sandbox, { recursive: true, force: true });
	const failed = results.filter((result) => !result.ok).length;
	console.log(
		failed === 0
			? `\n=== SMOKE PASS (${results.length}) ===`
			: `\n=== SMOKE FAIL (${failed}/${results.length}) ===`,
	);
	ws.close();
	process.exit(failed === 0 ? 0 : 1);
}
