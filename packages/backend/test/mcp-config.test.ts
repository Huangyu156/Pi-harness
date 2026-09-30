/**
 * MCP 配置读写测试：两级合并、非法条目 fail-soft、写入只动 mcpServers、值展开、传输参数投影。
 *
 * 全部在 mkdtemp 的临时目录里造文件（agentDir / cwd / env 都是注入的），不读开发者本机真实配置。
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 被测语义就是字面量 `${env:NAME}` 文本，这些字符串是断言数据而不是模板字符串误写

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStoreCorruptedError } from "../src/json-store";
import {
	describeServer,
	expandEnvRefs,
	expandHomePath,
	loadMcpConfig,
	type McpConfigContext,
	mcpConfigPath,
	removeMcpServer,
	resolvePerchoConfig,
	secretKeysOf,
	toTransportOptions,
	writeMcpServer,
} from "../src/mcp/config";
import { asRecord } from "../src/mcp/json";

let root: string;
let agentDir: string;
let projectDir: string;
let userPath: string;
let projectPath: string;
let ctx: McpConfigContext;

const ENV: NodeJS.ProcessEnv = { SECRET_TOKEN: "s3cret-token", BIN_DIR: "" };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mcp-config-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(projectDir, { recursive: true });
	userPath = join(agentDir, "mcp.json");
	projectPath = join(projectDir, ".pi", "mcp.json");
	ctx = { agentDir, cwd: projectDir, env: { ...ENV, BIN_DIR: join(root, "bin") } };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 写出用户级配置文件（agentDir 可能还不存在） */
function seedUserFile(value: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(userPath, JSON.stringify(value, null, 2), "utf8");
}

/** 写出项目级配置文件（.pi 目录可能还不存在） */
function seedProjectFile(value: unknown): void {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(projectPath, JSON.stringify(value, null, 2), "utf8");
}

/** 读回文件原始 JSON（断言「只改了 mcpServers」用） */
function readConfigFile(path: string): Record<string, unknown> {
	const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
	if (raw === null) throw new Error(`config file ${path} is not a JSON object`);
	return raw;
}

describe("mcpConfigPath", () => {
	it("用户级在 agentDir 下，项目级在 cwd/.pi 下", () => {
		expect(mcpConfigPath(ctx, "user")).toBe(join(agentDir, "mcp.json"));
		expect(mcpConfigPath(ctx, "project")).toBe(join(projectDir, ".pi", "mcp.json"));
	});
});

describe("loadMcpConfig", () => {
	it("两级文件都不存在时返回空列表且不报错", async () => {
		await expect(loadMcpConfig(ctx)).resolves.toEqual({ servers: [], errors: [] });
	});

	it("项目级同名覆盖用户级，结果按名字排序", async () => {
		seedUserFile({
			mcpServers: {
				beta: { command: "user-beta" },
				alpha: { command: "user-alpha" },
			},
		});
		seedProjectFile({
			mcpServers: {
				gamma: { command: "proj-gamma" },
				beta: { command: "proj-beta" },
			},
		});
		const { servers, errors } = await loadMcpConfig(ctx);
		expect(errors).toEqual([]);
		expect(servers.map((server) => [server.name, server.source])).toEqual([
			["alpha", "user"],
			["beta", "project"],
			["gamma", "project"],
		]);
		expect(servers[1]?.config).toEqual({ type: "stdio", command: "proj-beta" });
	});

	it("非法条目进 errors 并跳过，合法条目照常加载", async () => {
		seedUserFile({
			mcpServers: {
				good: { command: "npx", args: ["-y", "pkg"] },
				"no-command": { args: ["x"] },
				"empty-command": { command: "   " },
				"bad-type": { type: "websocket", url: "https://example.test/mcp" },
				"bad-url": { type: "http", url: "ftp://example.test/mcp" },
				"missing-url": { type: "sse" },
				"bad-args": { command: "npx", args: ["ok", 5] },
				"bad-env": { command: "npx", env: { TOKEN: 1 } },
				"not-object": "nope",
			},
		});
		const { servers, errors } = await loadMcpConfig(ctx);
		expect(servers.map((server) => server.name)).toEqual(["good"]);
		expect(errors).toEqual([
			'mcp.json: server "no-command" is missing "command"',
			'mcp.json: server "empty-command" is missing "command"',
			'mcp.json: server "bad-type" has invalid "type" "websocket" (expected "stdio", "http" or "sse")',
			'mcp.json: server "bad-url" has invalid "url" "ftp://example.test/mcp" (expected http or https)',
			'mcp.json: server "missing-url" is missing "url"',
			'mcp.json: server "bad-args" has non-string item in "args"',
			'mcp.json: server "bad-env" has non-string value for "env.TOKEN"',
			'mcp.json: server "not-object" must be a JSON object',
		]);
	});

	it("整个文件非法 JSON → 一条 error，另一级照常加载", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(userPath, "{ not json", "utf8");
		seedProjectFile({ mcpServers: { p: { url: "https://example.test/mcp" } } });
		const { servers, errors } = await loadMcpConfig(ctx);
		expect(errors).toEqual(["mcp.json: file is not valid JSON"]);
		expect(servers.map((server) => server.name)).toEqual(["p"]);
	});

	it("mcpServers 不是对象 → 一条 error", async () => {
		seedUserFile({ mcpServers: ["nope"] });
		const { servers, errors } = await loadMcpConfig(ctx);
		expect(servers).toEqual([]);
		expect(errors).toEqual(['mcp.json: "mcpServers" must be an object']);
	});

	it("type 缺省推断：有 url → http，有 command → stdio", async () => {
		seedUserFile({
			mcpServers: {
				byUrl: { url: "https://example.test/mcp" },
				byCommand: { command: "npx" },
			},
		});
		const { servers } = await loadMcpConfig(ctx);
		expect(servers.map((server) => [server.name, server.config.type])).toEqual([
			["byCommand", "stdio"],
			["byUrl", "http"],
		]);
	});

	it("配置保留 ${env:} 原文，transportOptions 才落地展开", async () => {
		const binDir = join(root, "bin");
		seedUserFile({
			mcpServers: {
				envRef: {
					command: "${env:BIN_DIR}/npx",
					args: ["--token", "${env:SECRET_TOKEN}"],
					cwd: "${env:BIN_DIR}",
					env: { API_KEY: "${env:SECRET_TOKEN}" },
					percho: { lazy: false, directTools: true },
				},
			},
		});
		const { servers } = await loadMcpConfig(ctx);
		const server = servers[0];
		expect(server?.config).toMatchObject({ command: "${env:BIN_DIR}/npx" });
		expect(server?.percho.lazy).toBe(false);
		// 展开是纯文本替换（不做路径归一化），故断言用拼串而不是 join
		expect(server?.transportOptions).toEqual({
			kind: "stdio",
			command: `${binDir}/npx`,
			args: ["--token", "s3cret-token"],
			env: { API_KEY: "s3cret-token" },
			cwd: binDir,
			inheritEnv: true,
		});
	});
});

describe("writeMcpServer / removeMcpServer", () => {
	it("写入只动 mcpServers，其它顶层键原样保留", async () => {
		seedUserFile({
			imports: { from: "claude-desktop" },
			settings: { autoConnect: true },
			futureField: [1, 2, 3],
			mcpServers: { existing: { command: "old" } },
		});
		await writeMcpServer(ctx, "added", { command: "npx", args: ["-y", "pkg"] }, "user");
		const raw = readConfigFile(userPath);
		const servers = asRecord(raw.mcpServers);
		expect(raw.imports).toEqual({ from: "claude-desktop" });
		expect(raw.settings).toEqual({ autoConnect: true });
		expect(raw.futureField).toEqual([1, 2, 3]);
		expect(Object.keys(servers ?? {})).toEqual(["existing", "added"]);
		expect(servers?.added).toEqual({ type: "stdio", command: "npx", args: ["-y", "pkg"] });
	});

	it("写入项目级落到 cwd/.pi/mcp.json，并可被 loadMcpConfig 读回", async () => {
		await writeMcpServer(ctx, "proj", { url: "https://example.test/mcp" }, "project");
		expect(existsSync(projectPath)).toBe(true);
		const { servers } = await loadMcpConfig(ctx);
		expect(servers.map((server) => [server.name, server.source])).toEqual([["proj", "project"]]);
	});

	it("非法配置与空名字就地抛错（英文文案）", async () => {
		await expect(writeMcpServer(ctx, " ", { command: "npx" }, "user")).rejects.toThrow(
			"MCP server name must be a non-empty string",
		);
		const badUrl = { type: "http", url: "ftp://example.test/mcp" } as McpServerConfig;
		await expect(writeMcpServer(ctx, "x", badUrl, "user")).rejects.toThrow(
			'mcp.json: server "x" has invalid "url" "ftp://example.test/mcp" (expected http or https)',
		);
	});

	it("损坏文件时写入抛 JsonStoreCorruptedError 且不覆盖原文件", async () => {
		seedUserFile({ broken: true });
		writeFileSync(userPath, "{ broken json", "utf8");
		await expect(writeMcpServer(ctx, "x", { command: "npx" }, "user")).rejects.toBeInstanceOf(
			JsonStoreCorruptedError,
		);
		await expect(removeMcpServer(ctx, "x", "user")).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		expect(readFileSync(userPath, "utf8")).toBe("{ broken json");
	});

	it("删除只移除目标条目并保留其它键；文件不存在时是空操作", async () => {
		seedUserFile({
			settings: { keep: true },
			mcpServers: { a: { command: "a" }, b: { command: "b" } },
		});
		await removeMcpServer(ctx, "a", "user");
		const raw = readConfigFile(userPath);
		expect(raw.settings).toEqual({ keep: true });
		expect(raw.mcpServers).toEqual({ b: { command: "b" } });
		await removeMcpServer(ctx, "b", "project");
		expect(existsSync(projectPath)).toBe(false);
	});
});

describe("expandEnvRefs", () => {
	it("展开单个与多个引用", () => {
		expect(expandEnvRefs("${env:SECRET_TOKEN}", ENV)).toBe("s3cret-token");
		expect(expandEnvRefs("a${env:SECRET_TOKEN}b${env:SECRET_TOKEN}", ENV)).toBe("as3cret-tokenbs3cret-token");
	});

	it("缺失变量替换为空串", () => {
		expect(expandEnvRefs("x${env:NOT_SET}y", ENV)).toBe("xy");
	});

	it("$${env:X} 是转义：$ 字面保留且不再展开", () => {
		expect(expandEnvRefs("$${env:SECRET_TOKEN}", ENV)).toBe("${env:SECRET_TOKEN}");
		expect(expandEnvRefs("arg=$${env:NOT_SET}", ENV)).toBe("arg=${env:NOT_SET}");
	});

	it("非引用文本与非法引用名原样保留", () => {
		expect(expandEnvRefs("no refs here", ENV)).toBe("no refs here");
		expect(expandEnvRefs("cost $5 $$", ENV)).toBe("cost $5 $");
		expect(expandEnvRefs("${env:}", ENV)).toBe("${env:}");
		expect(expandEnvRefs("${env:1BAD}", ENV)).toBe("${env:1BAD}");
	});
});

describe("expandHomePath", () => {
	const home = join(tmpdir(), "fake-home");

	it("展开 ~ / ~\\ 前缀", () => {
		expect(expandHomePath("~", home)).toBe(home);
		expect(expandHomePath("~/bin/npx", home)).toBe(join(home, "bin", "npx"));
		expect(expandHomePath("~\\bin\\npx", home)).toBe(join(home, "bin", "npx"));
	});

	it("只认前缀：~user、路径中段的 ~、其它绝对路径都不动", () => {
		expect(expandHomePath("~user/bin", home)).toBe("~user/bin");
		expect(expandHomePath("/opt/~/bin", home)).toBe("/opt/~/bin");
		expect(expandHomePath("npx", home)).toBe("npx");
	});
});

describe("secretKeysOf", () => {
	it("stdio 取 env 键名、http 取 headers 键名，且永不返回值", () => {
		const stdio: McpServerConfig = {
			type: "stdio",
			command: "npx",
			env: { API_KEY: "s3cret-token", REGION: "us-east-1" },
		};
		const http: McpServerConfig = {
			type: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer s3cret-token" },
		};
		expect(secretKeysOf(stdio)).toEqual(["API_KEY", "REGION"]);
		expect(secretKeysOf(http)).toEqual(["Authorization"]);
		expect(JSON.stringify([secretKeysOf(stdio), secretKeysOf(http)])).not.toContain("s3cret-token");
		expect(secretKeysOf({ type: "stdio", command: "npx" })).toEqual([]);
	});
});

describe("describeServer", () => {
	it("stdio 用 command + args 首项，缺 args 时只有 command", () => {
		expect(describeServer({ type: "stdio", command: "npx", args: ["-y", "pkg"] })).toBe("npx -y");
		expect(describeServer({ command: "npx" })).toBe("npx");
	});

	it("超长摘要截断到 80 字（含省略号）", () => {
		const summary = describeServer({ type: "stdio", command: "x".repeat(200) });
		expect(summary).toHaveLength(80);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("http/sse 用 origin + pathname，丢掉查询串", () => {
		expect(describeServer({ type: "http", url: "https://example.test/mcp?token=abc#frag" })).toBe(
			"https://example.test/mcp",
		);
		expect(describeServer({ type: "sse", url: "http://127.0.0.1:3000/sse" })).toBe(
			"http://127.0.0.1:3000/sse",
		);
	});
});

describe("toTransportOptions", () => {
	it("stdio：command/args/cwd 做 env 展开，env 值只做 env 展开，inheritEnv 缺省 true", () => {
		const binDir = join(root, "bin");
		const options = toTransportOptions(
			{
				type: "stdio",
				command: "${env:BIN_DIR}/npx",
				args: ["-y", "${env:SECRET_TOKEN}"],
				cwd: "${env:BIN_DIR}/sub",
				env: { API_KEY: "${env:SECRET_TOKEN}", RAW: "~keep" },
			},
			ctx.env ?? {},
		);
		expect(options).toEqual({
			kind: "stdio",
			command: `${binDir}/npx`,
			args: ["-y", "s3cret-token"],
			env: { API_KEY: "s3cret-token", RAW: "~keep" },
			cwd: `${binDir}/sub`,
			inheritEnv: true,
		});
	});

	it("stdio：inheritEnv=false 与缺省 args/env 原样投影", () => {
		expect(toTransportOptions({ type: "stdio", command: "npx", inheritEnv: false }, {})).toEqual({
			kind: "stdio",
			command: "npx",
			args: [],
			env: {},
			cwd: undefined,
			inheritEnv: false,
		});
	});

	it("stdio：cwd 的 ~ 前缀在投影时已展开（不再带 ~，尾段保留）", () => {
		const options = toTransportOptions({ type: "stdio", command: "npx", cwd: "~/percho-probe" }, {});
		const cwd = options.kind === "stdio" ? options.cwd : undefined;
		expect(cwd?.endsWith("percho-probe")).toBe(true);
		expect(cwd).not.toContain("~");
	});

	it("http/sse：URL 原样、headers 值展开、tls 原样带上", () => {
		const tls = { caFile: "~/corp-ca.pem", rejectUnauthorized: false };
		const http = toTransportOptions(
			{
				type: "http",
				url: "https://example.test/mcp?k=~v",
				headers: { Authorization: "Bearer ${env:SECRET_TOKEN}" },
				tls,
			},
			ctx.env ?? {},
		);
		expect(http).toEqual({
			kind: "streamable-http",
			url: "https://example.test/mcp?k=~v",
			headers: { Authorization: "Bearer s3cret-token" },
			tls,
		});
		expect(http.kind === "streamable-http" ? http.tls : undefined).toBe(tls);
		expect(toTransportOptions({ type: "sse", url: "https://example.test/sse" }, {}).kind).toBe("http-sse");
	});
});

describe("resolvePerchoConfig", () => {
	it("缺省值：lazy / directTools / idleTimeoutMs / exclude / ask", () => {
		expect(resolvePerchoConfig(undefined, "stdio")).toEqual({
			lazy: true,
			directTools: false,
			idleTimeoutMs: 300_000,
			exclude: [],
			ask: [],
		});
	});

	it("部分字段按用户值，其余回默认", () => {
		expect(resolvePerchoConfig({ lazy: false, tools: { ask: ["delete_*"] } }, "http")).toEqual({
			lazy: false,
			directTools: false,
			idleTimeoutMs: 300_000,
			exclude: [],
			ask: ["delete_*"],
		});
	});

	it("脏值 fail-soft 回默认（非布尔 / 负数 / 非数组 / 数组含非字符串）", () => {
		const resolved = resolvePerchoConfig(
			{
				lazy: "yes",
				directTools: 1,
				idleTimeoutMs: -5,
				tools: { exclude: "read_*", ask: [1, "ok"] },
			} as Record<string, unknown>,
			"stdio",
		);
		expect(resolved).toEqual({
			lazy: true,
			directTools: false,
			idleTimeoutMs: 300_000,
			exclude: [],
			ask: [],
		});
	});

	it("idleTimeoutMs=0 合法（0 = 不断开）", () => {
		expect(resolvePerchoConfig({ idleTimeoutMs: 0 }, "stdio").idleTimeoutMs).toBe(0);
	});
});
