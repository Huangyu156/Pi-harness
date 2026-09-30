/**
 * 宿主导入扫描测试：宿主顺序与路径表、字段映射、占位符、Codex TOML 窄子集、只读约束。
 *
 * home / cwd / env / platform / agentDir 全部注入到 mkdtemp 的临时目录，不读开发者本机真实配置。
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 被测语义就是字面量 `${env:NAME}` / `${workspaceFolder}` 文本，这些字符串是断言数据而不是模板字符串误写

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpHostName, McpImportCandidate } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanHostConfigs } from "../src/mcp/import";

/** Codex fixture 目录（TOML 需要精确的换行/注释，放在 test/fixtures/mcp 下） */
const FIXTURES = join(import.meta.dirname, "fixtures", "mcp");

let home: string;
let cwd: string;
let agentDir: string;
let appData: string;
let vscodeUserDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mcp-import-home-"));
	cwd = mkdtempSync(join(tmpdir(), "mcp-import-cwd-"));
	agentDir = mkdtempSync(join(tmpdir(), "mcp-import-agent-"));
	appData = join(home, "AppData", "Roaming");
	vscodeUserDir = join(appData, "Code", "User");
	env = { APPDATA: appData, LOCALAPPDATA: join(home, "AppData", "Local") };
});

afterEach(() => {
	for (const dir of [home, cwd, agentDir]) rmSync(dir, { recursive: true, force: true });
});

/** 造一个宿主文件（父目录自动创建）；字符串按原文写（TOML），其它按 JSON 写 */
function writeHostFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
}

/** 复制 fixture 到临时 home 下（不修改 fixture 本体） */
function copyFixture(name: string, target: string): void {
	writeHostFile(target, readFileSync(join(FIXTURES, name), "utf8"));
}

/** 临时目录树的快照（验证「只读」用） */
function snapshotTrees(): string[] {
	const files: string[] = [];
	for (const dir of [home, cwd, agentDir]) {
		for (const entry of readdirSync(dir, { recursive: true })) files.push(`${dir}/${String(entry)}`);
	}
	return files.sort();
}

/** 扫描（默认 win32 + 注入的 agentDir，与其余用例共用） */
function scan(overrides: Partial<Parameters<typeof scanHostConfigs>[0]> = {}) {
	return scanHostConfigs({ cwd, env, home, platform: "win32", agentDir, ...overrides });
}

/** 按宿主取结果（同一宿主多文件时取第一份） */
function hostOf(candidates: McpImportCandidate[], host: McpHostName): McpImportCandidate | undefined {
	return candidates.find((candidate) => candidate.host === host);
}

describe("scanHostConfigs 路径表与固定顺序", () => {
	it("每个宿主一个 fixture：宿主顺序、路径与字段映射都正确", async () => {
		writeHostFile(join(home, ".agents", "mcp.json"), {
			mcpServers: { sh: { command: "shared-cmd", args: ["--x"] } },
		});
		writeHostFile(join(appData, "Claude", "claude_desktop_config.json"), {
			mcpServers: { cd: { command: "npx", args: ["-y", "cd"] } },
		});
		writeHostFile(join(home, ".claude.json"), {
			mcpServers: { cc: { url: "https://claude-code.test/mcp" } },
		});
		writeHostFile(join(home, ".cursor", "mcp.json"), {
			mcpServers: { cur: { command: "cursor-cmd" } },
		});
		writeHostFile(join(cwd, ".vscode", "mcp.json"), {
			servers: { vs: { type: "stdio", command: "vscode-cmd" } },
		});
		writeHostFile(
			join(vscodeUserDir, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
			{
				mcpServers: { cl: { command: "cline-cmd", env: { TOKEN: "${env:CLINE_TOKEN}" } } },
			},
		);
		writeHostFile(join(home, ".codeium", "windsurf", "mcp_config.json"), {
			mcpServers: { wd: { url: "https://windsurf.test/mcp" } },
		});
		copyFixture("codex-config.toml", join(home, ".codex", "config.toml"));
		writeHostFile(join(agentDir, "mcp-adapter.json"), {
			mcpServers: { ad: { command: "adapter-cmd" } },
		});

		const candidates = await scan();
		expect(candidates.map((candidate) => candidate.host)).toEqual([
			"shared",
			"claude-desktop",
			"claude-code",
			"cursor",
			"vscode",
			"cline",
			"windsurf",
			"codex",
			"adapter",
		]);
		expect(candidates.map((candidate) => candidate.path)).toEqual([
			join(home, ".agents", "mcp.json"),
			join(appData, "Claude", "claude_desktop_config.json"),
			join(home, ".claude.json"),
			join(home, ".cursor", "mcp.json"),
			join(cwd, ".vscode", "mcp.json"),
			join(vscodeUserDir, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
			join(home, ".codeium", "windsurf", "mcp_config.json"),
			join(home, ".codex", "config.toml"),
			join(agentDir, "mcp-adapter.json"),
		]);
		expect(hostOf(candidates, "shared")?.servers).toEqual([
			{
				name: "sh",
				config: { type: "stdio", command: "shared-cmd", args: ["--x"] },
				summary: "shared-cmd --x",
				conflict: false,
			},
		]);
		expect(hostOf(candidates, "claude-desktop")?.servers[0]?.config).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "cd"],
		});
		expect(hostOf(candidates, "claude-code")?.servers[0]?.summary).toBe("https://claude-code.test/mcp");
		expect(hostOf(candidates, "cline")?.servers[0]?.config).toEqual({
			type: "stdio",
			command: "cline-cmd",
			env: { TOKEN: "${env:CLINE_TOKEN}" },
		});
		expect(hostOf(candidates, "windsurf")?.servers[0]?.config).toEqual({
			type: "http",
			url: "https://windsurf.test/mcp",
		});
	});

	it("darwin / linux 的平台路径表", async () => {
		writeHostFile(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), {
			mcpServers: { darwin: { command: "mac-cmd" } },
		});
		writeHostFile(join(home, "Library", "Application Support", "Code", "User", "mcp.json"), {
			servers: { vs: { type: "stdio", command: "mac-code-cmd" } },
		});
		const darwin = await scan({ platform: "darwin" });
		expect(darwin.map((candidate) => candidate.path)).toEqual([
			join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
			join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
		]);

		rmSync(join(home, "Library"), { recursive: true, force: true });
		writeHostFile(join(home, ".config", "Claude", "claude_desktop_config.json"), {
			mcpServers: { linux: { command: "linux-cmd" } },
		});
		writeHostFile(join(home, ".config", "Code", "User", "mcp.json"), {
			servers: { vs: { type: "stdio", command: "linux-code-cmd" } },
		});
		const linux = await scan({ platform: "linux" });
		expect(linux.map((candidate) => candidate.path)).toEqual([
			join(home, ".config", "Claude", "claude_desktop_config.json"),
			join(home, ".config", "Code", "User", "mcp.json"),
		]);
	});

	it("不存在的文件不出现；文件存在但没有条目也不出现", async () => {
		writeHostFile(join(home, ".claude.json"), { mcpServers: { cc: { command: "cc" } } });
		writeHostFile(join(home, ".cursor", "mcp.json"), { mcpServers: {} });
		writeHostFile(join(home, ".agents", "mcp.json"), { settings: { unrelated: true } });
		const candidates = await scan();
		expect(candidates.map((candidate) => candidate.host)).toEqual(["claude-code"]);
	});

	it("agentDir 缺省时跳过 adapter 宿主", async () => {
		writeHostFile(join(agentDir, "mcp-adapter.json"), { mcpServers: { ad: { command: "x" } } });
		await expect(scan({ agentDir: undefined })).resolves.toEqual([]);
	});

	it("同一宿主的多份文件各自成为一条结果，组内按名字字典序", async () => {
		writeHostFile(join(home, ".config", "mcp", "mcp.json"), {
			mcpServers: { zeta: { command: "z" }, alpha: { command: "a" } },
		});
		writeHostFile(join(cwd, ".mcp.json"), { mcpServers: { proj: { command: "p" } } });
		const candidates = await scan();
		expect(candidates.map((candidate) => [candidate.host, candidate.path])).toEqual([
			["shared", join(home, ".config", "mcp", "mcp.json")],
			["shared", join(cwd, ".mcp.json")],
		]);
		expect(candidates[0]?.servers.map((server) => server.name)).toEqual(["alpha", "zeta"]);
	});

	it("只读：扫描不创建任何文件或目录", async () => {
		writeHostFile(join(home, ".claude.json"), { mcpServers: { cc: { command: "cc" } } });
		writeHostFile(join(home, ".config", "mcp", "mcp.json"), { mcpServers: { sh: { command: "sh" } } });
		copyFixture("codex-config.toml", join(home, ".codex", "config.toml"));
		const before = snapshotTrees();
		await scan();
		await scan({ platform: "linux" });
		expect(snapshotTrees()).toEqual(before);
	});
});

describe("VS Code servers 键与占位符", () => {
	it("servers + type 映射到本仓的 type", async () => {
		writeHostFile(join(cwd, ".vscode", "mcp.json"), {
			servers: {
				stdioServer: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { A: "1" } },
				httpServer: { type: "http", url: "https://http.test/mcp", headers: { Authorization: "Bearer x" } },
				sseServer: { type: "sse", url: "https://sse.test/sse" },
			},
		});
		const servers = hostOf(await scan(), "vscode")?.servers;
		expect(servers?.map((server) => [server.name, server.config.type])).toEqual([
			["httpServer", "http"],
			["sseServer", "sse"],
			["stdioServer", "stdio"],
		]);
		expect(servers?.[2]?.config).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "pkg"],
			env: { A: "1" },
		});
		expect(servers?.[0]?.config).toEqual({
			type: "http",
			url: "https://http.test/mcp",
			headers: { Authorization: "Bearer x" },
		});
	});

	it("用户级 VS Code 文件里的 mcpServers 键同样支持", async () => {
		writeHostFile(join(vscodeUserDir, "mcp.json"), {
			mcpServers: { legacy: { command: "legacy-cmd" } },
		});
		expect(hostOf(await scan(), "vscode")?.servers[0]?.name).toBe("legacy");
	});

	it("${workspaceFolder} 替换为 cwd，${env:} 原样保留，其它占位符整条跳过", async () => {
		writeHostFile(join(cwd, ".vscode", "mcp.json"), {
			servers: {
				ws: {
					type: "stdio",
					command: "${workspaceFolder}/bin/server",
					args: ["--root", "${workspaceFolder}"],
					cwd: "${workspaceFolder}/work",
					env: { TOKEN: "${env:WS_TOKEN}" },
				},
				plugin: { type: "stdio", command: "${CLAUDE_PLUGIN_ROOT}/server" },
				incomplete: { type: "stdio", args: ["x"] },
			},
		});
		const servers = hostOf(await scan(), "vscode")?.servers;
		expect(servers).toHaveLength(1);
		expect(servers?.[0]).toMatchObject({
			name: "ws",
			config: {
				type: "stdio",
				command: `${cwd}/bin/server`,
				args: ["--root", cwd],
				cwd: `${cwd}/work`,
				env: { TOKEN: "${env:WS_TOKEN}" },
			},
			conflict: false,
		});
		// 摘要由 describeServer 生成并按 80 字截断（临时目录路径较长）
		expect(servers?.[0]?.summary.startsWith(`${cwd}/bin/server`)).toBe(true);
	});

	it("existingNames 命中的条目 conflict=true", async () => {
		writeHostFile(join(home, ".claude.json"), {
			mcpServers: { known: { command: "a" }, fresh: { command: "b" } },
		});
		const servers = hostOf(await scan({ existingNames: ["known"] }), "claude-code")?.servers;
		expect(servers?.map((server) => [server.name, server.conflict])).toEqual([
			["fresh", false],
			["known", true],
		]);
	});

	it("非法 JSON / 根不是对象 → 该文件跳过", async () => {
		writeHostFile(join(home, ".claude.json"), "{ not json");
		writeHostFile(join(home, ".cursor", "mcp.json"), [1, 2, 3]);
		await expect(scan()).resolves.toEqual([]);
	});
});

describe("Codex TOML 窄子集", () => {
	it("解析 command / 跨行 args / 内联 env / env 子表 / cwd / url（忽略 startup_timeout_ms）", async () => {
		copyFixture("codex-config.toml", join(home, ".codex", "config.toml"));
		const servers = hostOf(await scan(), "codex")?.servers;
		expect(servers).toEqual([
			{
				name: "extra-env",
				config: { type: "stdio", command: "uvx", env: { EXTRA: "1", QUOTED: "two words" } },
				summary: "uvx",
				conflict: false,
			},
			{
				name: "fs",
				config: {
					type: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
					env: { API_KEY: "abc", "MY-VAR": "literal value" },
					cwd: "/work",
				},
				summary: "npx -y",
				conflict: false,
			},
			{
				name: "web tools",
				config: { type: "http", url: "https://example.test/mcp" },
				summary: "https://example.test/mcp",
				conflict: false,
			},
		]);
	});

	it("表内未知键 → 整份跳过该宿主（同一文件里的正常服务器也不导出）", async () => {
		copyFixture("codex-unsupported.toml", join(home, ".codex", "config.toml"));
		await expect(scan()).resolves.toEqual([]);
	});

	it("非字符串数组 / 未闭合数组 → 整份跳过", async () => {
		writeHostFile(join(home, ".codex", "config.toml"), '[mcp_servers.fs]\ncommand = "npx"\nargs = [1, 2]\n');
		await expect(scan()).resolves.toEqual([]);

		writeHostFile(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.fs]\ncommand = "npx"\nargs = [\n\t"-y",\n',
		);
		await expect(scan()).resolves.toEqual([]);
	});
});
