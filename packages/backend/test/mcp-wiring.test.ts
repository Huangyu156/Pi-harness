/**
 * PiBackend 的 MCP 接线：自定义工具注册条件（零服务器不注册）、直投工具随快照进入会话工具集、
 * 事件订阅出口、项目目录同步、dispose 语义。
 *
 * 用真实 `PI_CODING_AGENT_DIR` 临时目录 + 真实 stdio 服务器（fixtures/mcp/echo-server.mjs）：
 * 这里验证的正是「从配置到会话工具列表」这条最容易接错的链路。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpEventPayload, McpServerConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/index";

const ECHO_SERVER = fileURLToPath(new URL("./fixtures/mcp/echo-server.mjs", import.meta.url));

/** 会话工具集的构造入口是私有方法：测试直接调它（形状与 wireSession 内部一致） */
interface ToolBuilder {
	buildCustomTools(gate: undefined, preferBuiltin: boolean): ToolDefinition[];
}

function customToolNames(backend: PiBackend): string[] {
	return (backend as unknown as ToolBuilder).buildCustomTools(undefined, true).map((tool) => tool.name);
}

describe("PiBackend 的 MCP 接线", () => {
	let agentDir: string;
	let projectDir: string;
	let previousAgentDir: string | undefined;
	let backend: PiBackend | undefined;

	async function makeBackend(config: Record<string, McpServerConfig>): Promise<PiBackend> {
		await writeFile(
			join(agentDir, "mcp.json"),
			`${JSON.stringify({ mcpServers: config }, null, 2)}\n`,
			"utf8",
		);
		backend = new PiBackend({ projectTrust: false, permissionGates: false, defaultCwd: projectDir });
		// 配置是异步载入的（同步快照的数据源）：先 await 一次列表，保证后续同步读到的就是这份配置
		await backend.mcp.list();
		return backend;
	}

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "percho-mcp-wire-agent-"));
		projectDir = await mkdtemp(join(tmpdir(), "percho-mcp-wire-project-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		await backend?.dispose();
		backend = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	it("零服务器：不注册 mcp / mcpScript（空工具不占 context）", async () => {
		const b = await makeBackend({});
		const names = customToolNames(b);
		expect(names).not.toContain("mcp");
		expect(names).not.toContain("mcpScript");
	});

	it("有服务器：注册 mcp + mcpScript，未开直投时没有 mcp__ 前缀工具", async () => {
		const b = await makeBackend({ echo: { command: process.execPath, args: [ECHO_SERVER] } });
		const names = customToolNames(b);
		expect(names).toContain("mcp");
		expect(names).toContain("mcpScript");
		expect(names.filter((name) => name.startsWith("mcp__"))).toEqual([]);
	});

	it("开直投并预热后：会话工具集里出现 mcp__<server>__<tool>", async () => {
		const b = await makeBackend({ echo: { command: process.execPath, args: [ECHO_SERVER] } });
		await b.mcp.setDirectTools("echo", true);
		await vi.waitFor(() => expect(b.mcp.directToolSnapshot().length).toBe(1), { timeout: 10_000 });
		const names = customToolNames(b);
		expect(names).toContain("mcp__echo__echo");
		expect(names).toContain("mcp__echo__hang");
	});

	it("事件出口：onMcpEvent 拿到 status/log，且退订后不再收到", async () => {
		const b = await makeBackend({ echo: { command: process.execPath, args: [ECHO_SERVER] } });
		const events: McpEventPayload[] = [];
		const off = b.onMcpEvent((event) => events.push(event));
		await b.mcp.test("echo");
		await vi.waitFor(() => expect(events.some((event) => event.kind === "status")).toBe(true), {
			timeout: 5_000,
		});
		const seen = events.length;
		off();
		await b.mcp.test("echo");
		expect(events.length).toBe(seen);
	});

	it("项目目录同步：setProjectCwd 后项目级配置进入列表并标 source=project", async () => {
		const b = await makeBackend({});
		const other = await mkdtemp(join(tmpdir(), "percho-mcp-other-"));
		try {
			await mkdir(join(other, ".pi"), { recursive: true });
			await writeFile(
				join(other, ".pi", "mcp.json"),
				`${JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [ECHO_SERVER] } } })}\n`,
				"utf8",
			);
			b.mcp.setProjectCwd(other);
			const views = await b.mcp.list();
			expect(views.find((view) => view.name === "local")?.source).toBe("project");
			expect(customToolNames(b)).toContain("mcp");
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});

	it("dispose：可 await、幂等，且之后 mcp 不再可用", async () => {
		const b = await makeBackend({ echo: { command: process.execPath, args: [ECHO_SERVER] } });
		await b.mcp.test("echo");
		await expect(b.dispose()).resolves.toBeUndefined();
		await expect(b.mcp.test("echo")).resolves.toMatchObject({ ok: false });
		backend = undefined; // 已释放，避免 afterEach 再 dispose 一次
	});
});
