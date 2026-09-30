/**
 * MCP 服务层 + 工具层的集成测试：**真实子进程 MCP 服务器**（fixtures/mcp/echo-server.mjs）跑通
 * 「配置 → registry → transport → client → 工具层」整条链路，另覆盖脱敏回填、启停、删除、
 * 直投快照与权限规则的交叉一致性。
 *
 * 这里不 mock MCP 协议：`mcpService` 的每一次 connect/call 都真的 spawn 子进程并走 stdio JSON-RPC。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { MCP_SECRET_MASK, type McpEventPayload, type McpServerConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpService, parseToolPath } from "../src/mcp/service";
import { makeMcpTool } from "../src/mcp/tools";
import { DEFAULT_PERMISSION_CONFIG, evaluateRules, matchTextFor } from "../src/permissions";

const ECHO_SERVER = fileURLToPath(new URL("./fixtures/mcp/echo-server.mjs", import.meta.url));

/** 工具结果的文本投影（窄化而不是断言形状：结果不是文本块时立刻失败，避免静默读到 undefined） */
function firstText(content: AgentToolResult<unknown>["content"]): string {
	const block = content[0];
	if (block === undefined) throw new Error("工具结果没有内容块");
	if (block.type !== "text") throw new Error(`期望文本块，实际是 ${block.type}`);
	return block.text;
}

/** stdio 配置的 env（按联合类型判别收窄，不用断言） */
function stdioEnv(config: McpServerConfig): Record<string, string> | undefined {
	return "url" in config ? undefined : config.env;
}

/** http 配置的 headers（同上） */
function httpHeaders(config: McpServerConfig): Record<string, string> | undefined {
	return "url" in config ? config.headers : undefined;
}

interface Harness {
	service: McpService;
	agentDir: string;
	projectDir: string;
	events: McpEventPayload[];
}

async function makeHarness(prepare?: (paths: { agentDir: string; projectDir: string }) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "percho-mcp-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "percho-mcp-project-"));
	const events: McpEventPayload[] = [];
	if (prepare) await prepare({ agentDir, projectDir });
	// 配置必须在构造前落盘：McpService 构造时会异步读一次（同步快照的数据源）
	const service = new McpService({
		agentDir,
		cwd: () => projectDir,
		env: {},
		send: (event) => events.push(event),
	});
	return { service, agentDir, projectDir, events };
}

/** 标准用户级配置：一个真实 stdio 服务器（echo）+ 一个不可达 http 服务器（remote） */
function defaultConfig(): Record<string, McpServerConfig> {
	return {
		echo: {
			command: process.execPath,
			args: [ECHO_SERVER],
			env: { MCP_MARKER: "secret-value" },
		},
		remote: {
			type: "http",
			url: "http://127.0.0.1:9/mcp",
			headers: { Authorization: "Bearer tok" },
			auth: { kind: "header" },
		},
	};
}

// 故意缺 url 的非法 http 条目：断言绕过静态校验，测的是运行时逐条校验（config.ts 的归一化 + errors）
const invalidHttpConfig = { type: "http" } as McpServerConfig;

async function writeUserConfig(agentDir: string, config: Record<string, McpServerConfig>): Promise<void> {
	await writeFile(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: config }, null, 2)}\n`, "utf8");
}

describe("McpService（真实 stdio 服务器集成）", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness(({ agentDir }) => writeUserConfig(agentDir, defaultConfig()));
	});

	afterEach(async () => {
		await harness.service.dispose();
		await rm(harness.agentDir, { recursive: true, force: true });
		await rm(harness.projectDir, { recursive: true, force: true });
	});

	it("list：两者都在，凭据只出掩码，配置字段可完整回填", async () => {
		const views = await harness.service.list();
		const echo = views.find((view) => view.name === "echo");
		const remote = views.find((view) => view.name === "remote");
		if (echo === undefined || remote === undefined) throw new Error("配置里的两个服务器都该出现在列表里");
		expect(echo).toMatchObject({
			transport: "stdio",
			authKind: "none",
			disabled: false,
			source: "user",
			state: "idle",
			hasOAuthToken: false,
		});
		expect(echo?.secretKeys).toEqual(["MCP_MARKER"]);
		expect(echo?.config).toMatchObject({ command: process.execPath });
		expect(stdioEnv(echo.config)?.MCP_MARKER).toBe(MCP_SECRET_MASK);
		// summary 语义 = command + args[0]（config.ts 的 describeServer，超 80 字截断）：长路径下断言前缀
		expect(echo?.summary.startsWith(process.execPath)).toBe(true);

		expect(remote).toMatchObject({ transport: "http", authKind: "header" });
		expect(remote?.secretKeys).toEqual(["Authorization"]);
		expect(httpHeaders(remote.config)?.Authorization).toBe(MCP_SECRET_MASK);
	});

	it("test：真实握手拿到 modern 世代、服务自述与工具数，stderr 进日志", async () => {
		const result = await harness.service.test("echo");
		expect(result.ok).toBe(true);
		expect(result.era).toBe("modern");
		expect(result.protocolVersion).toBe("2026-07-28");
		expect(result.serverInfo).toMatchObject({ name: "echo", version: "1.0.0" });
		expect(result.toolCount).toBe(2);
		expect(result.capabilities).toContain("tools");
		expect(result.error).toBeNull();
		expect(result.logs.some((line) => line.includes("echo-server ready"))).toBe(true);
	});

	it("listTools / describeTool：远端工具与 schema 可见，找不到的工具报可读错误", async () => {
		const tools = await harness.service.listTools("echo");
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "hang"]);
		const described = await harness.service.describeTool("echo__echo");
		expect(described).toMatchObject({ server: "echo", name: "echo", description: "echo back" });
		expect(described.inputSchema).toMatchObject({ type: "object" });
		await expect(harness.service.describeTool("echo__nope")).rejects.toThrow(/not found/);
	});

	it("callRemoteTool：真调远端工具并把回显内容带回来", async () => {
		const result = await harness.service.callRemoteTool("echo", "echo", { hello: "世界" });
		expect(result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = firstText(result.content);
		expect(text).toContain('"hello":"世界"');
	});

	it("searchTools：连得上的服务器出工具，连不上的如实报 failed（不静默少给）", async () => {
		const found = await harness.service.searchTools("echo");
		expect(found.tools.map((tool) => `${tool.server}__${tool.name}`)).toEqual(["echo__echo"]);
		expect(found.failed.map((entry) => entry.server)).toEqual(["remote"]);
		expect(found.failed[0]?.error.length).toBeGreaterThan(0);
	});

	it("upsert：掩码原样回传 = 保持磁盘原值，新键照写，真实值覆盖生效", async () => {
		const echo = (await harness.service.list()).find((view) => view.name === "echo");
		await harness.service.upsert("echo", {
			...echo.config,
			env: { MCP_MARKER: MCP_SECRET_MASK, ADDED: "new" },
		});
		let file = JSON.parse(await readFile(join(harness.agentDir, "mcp.json"), "utf8"));
		expect(file.mcpServers.echo.env).toEqual({ MCP_MARKER: "secret-value", ADDED: "new" });

		await harness.service.upsert("echo", { ...echo.config, env: { MCP_MARKER: "rotated" } });
		file = JSON.parse(await readFile(join(harness.agentDir, "mcp.json"), "utf8"));
		expect(file.mcpServers.echo.env).toEqual({ MCP_MARKER: "rotated" });
	});

	it("setEnabled：停用后配置保留但不再连（测试连接给出可读原因），重新启用即恢复", async () => {
		const disabled = await harness.service.setEnabled("echo", false);
		expect(disabled).toMatchObject({ disabled: true, state: "disabled" });
		const file = JSON.parse(await readFile(join(harness.agentDir, "mcp.json"), "utf8"));
		expect(file.mcpServers.echo.disabled).toBe(true);
		const failed = await harness.service.test("echo");
		expect(failed.ok).toBe(false);
		expect(failed.error).toContain("disabled");
		expect(harness.service.enabledServerCount()).toBe(1); // 只剩 remote

		const enabled = await harness.service.setEnabled("echo", true);
		expect(enabled.disabled).toBe(false);
		expect((await harness.service.test("echo")).ok).toBe(true);
	});

	it("setDirectTools：开关落到 percho，且预热后同步快照能给出直投工具", async () => {
		await harness.service.setDirectTools("echo", true);
		const view = (await harness.service.list()).find((server) => server.name === "echo");
		expect(view?.percho.directTools).toBe(true);
		const file = JSON.parse(await readFile(join(harness.agentDir, "mcp.json"), "utf8"));
		expect(file.mcpServers.echo.percho.directTools).toBe(true);

		await vi.waitFor(() => expect(harness.service.directToolSnapshot().length).toBe(1), { timeout: 10_000 });
		expect(harness.service.directToolSnapshot()[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "hang"]);
	});

	it("remove：同名同时存在于用户级与项目级时两处都删（不留会冒头的幽灵配置）", async () => {
		// 项目级文件必须在服务构造前落盘：构造时的配置快照带 2s TTL，构造后写入不会被这份实例看到
		const scoped = await makeHarness(async ({ agentDir, projectDir }) => {
			await writeUserConfig(agentDir, defaultConfig());
			await mkdir(join(projectDir, ".pi"), { recursive: true });
			await writeFile(
				join(projectDir, ".pi", "mcp.json"),
				`${JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER] } } }, null, 2)}\n`,
				"utf8",
			);
		});
		try {
			// 项目级覆盖用户级
			const before = await scoped.service.list();
			expect(before.find((view) => view.name === "echo")?.source).toBe("project");

			await scoped.service.remove("echo");
			const userFile = JSON.parse(await readFile(join(scoped.agentDir, "mcp.json"), "utf8"));
			const projectFile = JSON.parse(await readFile(join(scoped.projectDir, ".pi", "mcp.json"), "utf8"));
			expect(userFile.mcpServers.echo).toBeUndefined();
			expect(projectFile.mcpServers.echo).toBeUndefined();
			expect((await scoped.service.list()).map((view) => view.name)).toEqual(["remote"]);
		} finally {
			await scoped.service.dispose();
			await rm(scoped.agentDir, { recursive: true, force: true });
			await rm(scoped.projectDir, { recursive: true, force: true });
		}
	});

	it("readLog：分页游标单调递增，服务端 stderr 可见", async () => {
		await harness.service.test("echo");
		const first = harness.service.readLog("echo", 0);
		expect(first.cursor).toBeGreaterThan(0);
		expect(first.lines.some((line) => line.includes("echo-server ready"))).toBe(true);
		const second = harness.service.readLog("echo", first.cursor);
		expect(second.cursor).toBeGreaterThanOrEqual(first.cursor);
	});

	it("状态事件带完整视图（不是半成品载荷）", async () => {
		await harness.service.test("echo");
		const status = harness.events.find((event) => event.kind === "status");
		expect(status).toBeDefined();
		if (status?.kind !== "status") throw new Error("unreachable");
		expect(status.server).toMatchObject({ name: "echo", transport: "stdio" });
		expect(status.server.secretKeys).toEqual(["MCP_MARKER"]);
		// 日志事件按 200ms 合帧推送（防日志放大），所以这里等事件而不是立即断言
		await vi.waitFor(() => expect(harness.events.some((event) => event.kind === "log")).toBe(true), {
			timeout: 5_000,
		});
	});

	it("非法配置条目：跳过 + 发 notice（用户不会「服务器莫名消失」）", async () => {
		const broken = await makeHarness(({ agentDir }) => writeUserConfig(agentDir, { bad: invalidHttpConfig }));
		try {
			await vi.waitFor(() => expect(broken.events.some((event) => event.kind === "notice")).toBe(true), {
				timeout: 5_000,
			});
			expect(await broken.service.list()).toEqual([]);
			const notice = broken.events.find((event) => event.kind === "notice");
			expect(notice?.kind === "notice" && notice.message).toMatch(/mcp\.json.*url/);
		} finally {
			await broken.service.dispose();
			await rm(broken.agentDir, { recursive: true, force: true });
			await rm(broken.projectDir, { recursive: true, force: true });
		}
	});

	it("能力面缺失时给可读错误（真服务器实测：只声明 tools 的服务器收到 resources/list 回 -32601）", async () => {
		// echo fixture 只声明 tools：列资源/提示必须说清「它没有这个能力」，而不是把裸 -32601 抛给 UI
		await expect(harness.service.listResources("echo")).rejects.toThrow(
			/does not declare the "resources" capability/,
		);
		await expect(harness.service.listPrompts("echo")).rejects.toThrow(
			/does not declare the "prompts" capability/,
		);
		// tools 能力在：正常工作
		expect((await harness.service.listTools("echo")).length).toBe(2);
	});

	it("dispose：幂等且不抛（宿主退出路径）", async () => {
		await harness.service.test("echo");
		await harness.service.dispose();
		await expect(harness.service.dispose()).resolves.toBeUndefined();
	});
});

describe("mcp 工具（代理工具 + 直投工具）", () => {
	it("代理工具的 server/tool 参数能落进权限主体，默认规则给 ask（权限后门回归）", async () => {
		// 交叉一致性：权限层靠 matchTextFor("mcp", input) 取主体，工具层的参数名必须与它一致
		const subject = matchTextFor("mcp", { server: "echo", tool: "echo" });
		expect(subject).toBe("echo__echo");
		expect(evaluateRules(DEFAULT_PERMISSION_CONFIG.rules, "mcp", subject)).toBe("ask");
		expect(evaluateRules(DEFAULT_PERMISSION_CONFIG.rules, "mcp", matchTextFor("mcp", { search: "x" }))).toBe(
			"allow",
		);
		expect(
			evaluateRules(DEFAULT_PERMISSION_CONFIG.rules, "mcp", matchTextFor("mcp", { describe: "a__b" })),
		).toBe("allow");
		expect(
			evaluateRules(DEFAULT_PERMISSION_CONFIG.rules, "mcp__echo__echo", matchTextFor("mcp__echo__echo", {})),
		).toBe("ask");
	});

	it("代理工具真调远端：search / describe / call 三个动作都走通", async () => {
		const harness = await makeHarness(({ agentDir }) => writeUserConfig(agentDir, defaultConfig()));
		try {
			const tool = makeMcpTool(harness.service);
			const execute = tool.execute;
			if (execute === undefined) throw new Error("mcp 工具缺少 execute");
			// 工具执行上下文：mcp 只经 service 取数据，不用 ctx（不碰 cwd/文件），给最小壳即可
			const ctx = {} as Parameters<typeof execute>[4];
			const search = await execute("call-1", { search: "echo" }, undefined, undefined, ctx);
			expect(firstText(search.content)).toContain("echo__echo");

			const described = await execute("call-2", { describe: "echo__echo" }, undefined, undefined, ctx);
			expect(firstText(described.content)).toContain("echo back");

			const called = await execute(
				"call-3",
				{ server: "echo", tool: "echo", args: { ping: 1 } },
				undefined,
				undefined,
				ctx,
			);
			expect(firstText(called.content)).toContain('"ping":1');

			const status = await execute("call-4", {}, undefined, undefined, ctx);
			expect(firstText(status.content)).toContain("echo [stdio/");
		} finally {
			await harness.service.dispose();
			await rm(harness.agentDir, { recursive: true, force: true });
			await rm(harness.projectDir, { recursive: true, force: true });
		}
	});
});

describe("parseToolPath", () => {
	it("按首个下划线对切分；缺失/空段一律报可读错误", () => {
		expect(parseToolPath("fs__read_file")).toEqual({ server: "fs", tool: "read_file" });
		expect(parseToolPath("my-server__do_it")).toEqual({ server: "my-server", tool: "do_it" });
		expect(() => parseToolPath("nohyphen")).toThrow(/expected "<server>__<tool>"/);
		expect(() => parseToolPath("__tool")).toThrow();
		expect(() => parseToolPath("server__")).toThrow();
	});
});
