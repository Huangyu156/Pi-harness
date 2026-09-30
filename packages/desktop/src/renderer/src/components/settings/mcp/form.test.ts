import { MCP_SECRET_MASK, type McpServerView } from "@percho/shared";
import { describe, expect, it } from "vitest";
import {
	EMPTY_MCP_FORM,
	formatKeyValueLines,
	formError,
	formFromView,
	formToConfig,
	keyValueLines,
	type McpServerFormState,
	parseLineList,
} from "./form";

/** 造一个视图：只给被断言用到的字段，其余按最省事的默认值 */
function viewOf(overrides: Partial<McpServerView>): McpServerView {
	return {
		name: "fs",
		transport: "stdio",
		summary: "npx -y @modelcontextprotocol/server-filesystem",
		disabled: false,
		config: { type: "stdio", command: "npx", args: ["-y"] },
		percho: { lazy: true, directTools: false, idleTimeoutMs: 300000, exclude: [], ask: [] },
		secretKeys: [],
		authKind: "none",
		state: "idle",
		era: null,
		protocolVersion: null,
		serverInfo: null,
		toolCount: null,
		lastError: null,
		source: "user",
		hasOAuthToken: false,
		...overrides,
	};
}

function formOf(overrides: Partial<McpServerFormState>): McpServerFormState {
	return { ...EMPTY_MCP_FORM, ...overrides };
}

describe("keyValueLines（env / headers 的 KEY=VALUE 解析）", () => {
	it("按行解析并去掉首尾空白，值里的 = 原样保留", () => {
		expect(keyValueLines("A=1\n B = two=three \n\n").entries).toEqual({ A: "1", B: "two=three" });
	});

	it("无等号与空键的行不计入 entries，而是进 invalid（不静默变空值）", () => {
		const parsed = keyValueLines("A=1\nnonsense\n=orphan");
		expect(parsed.entries).toEqual({ A: "1" });
		expect(parsed.invalid).toEqual(["nonsense", "=orphan"]);
	});

	it("空文本 = 空表（清空全部键的语义靠它表达）", () => {
		expect(keyValueLines("").entries).toEqual({});
	});
});

describe("parseLineList（args / exclude / ask 的列表解析）", () => {
	it("逗号与换行混用、去重且保持首次出现顺序", () => {
		expect(parseLineList("-y,\n@scope/pkg\n-y\n, ")).toEqual(["-y", "@scope/pkg"]);
	});
});

describe("parseLineList 与 keyValueLines 的边界", () => {
	it("formatKeyValueLines 与 keyValueLines 往返一致（哨兵值原样出来）", () => {
		expect(formatKeyValueLines({ API_KEY: MCP_SECRET_MASK, B: "2" })).toBe(`API_KEY=${MCP_SECRET_MASK}\nB=2`);
		expect(keyValueLines(formatKeyValueLines({ API_KEY: MCP_SECRET_MASK })).entries).toEqual({
			API_KEY: MCP_SECRET_MASK,
		});
	});
});

describe("formError（提交前校验只给错误码）", () => {
	it("stdio 缺命令 / http 缺地址 / 非法协议各自报错", () => {
		expect(formError(formOf({ name: "x", transport: "stdio", command: "  " }))).toBe("commandRequired");
		expect(formError(formOf({ name: "x", transport: "http", url: "" }))).toBe("urlRequired");
		expect(formError(formOf({ name: "x", transport: "sse", url: "ftp://host/mcp" }))).toBe("urlScheme");
	});

	it("名字必须非空且落在安全字符集（会进 mcp__<server>__<tool> 与记忆键）", () => {
		expect(formError(formOf({ name: "   ", command: "npx" }))).toBe("nameRequired");
		expect(formError(formOf({ name: "bad name", command: "npx" }))).toBe("nameInvalid");
		expect(formError(formOf({ name: "ok.name-1_2", command: "npx" }))).toBeNull();
	});

	it("空闲断开只接受非负整数；KEY=VALUE 行格式不合法要拦住", () => {
		expect(formError(formOf({ name: "x", command: "npx", idleTimeoutMsText: "-1" }))).toBe(
			"idleTimeoutInvalid",
		);
		expect(formError(formOf({ name: "x", command: "npx", idleTimeoutMsText: "12a" }))).toBe(
			"idleTimeoutInvalid",
		);
		expect(formError(formOf({ name: "x", command: "npx", envText: "NO_EQUALS" }))).toBe("keyValueInvalid");
		expect(formError(formOf({ name: "x", transport: "http", url: "https://h/m", headersText: "x" }))).toBe(
			"keyValueInvalid",
		);
	});
});

describe("formToConfig（stdio）", () => {
	it("逐字段落到配置：args 按行、env/headers 整份下发、cwd/tls 空即省略", () => {
		const config = formToConfig(
			formOf({
				name: "fs",
				transport: "stdio",
				command: " npx ",
				argsText: "-y\n@modelcontextprotocol/server-filesystem",
				envText: `API_KEY=${MCP_SECRET_MASK}\nROOT=/tmp`,
				cwd: " /tmp ",
				inheritEnv: true,
				lazy: false,
				directTools: true,
				idleTimeoutMsText: "60000",
				excludeText: "delete_*,rm",
				askText: "write_file",
			}),
		);
		expect(config).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem"],
			env: { API_KEY: MCP_SECRET_MASK, ROOT: "/tmp" },
			cwd: "/tmp",
			percho: {
				lazy: false,
				directTools: true,
				idleTimeoutMs: 60000,
				tools: { exclude: ["delete_*", "rm"], ask: ["write_file"] },
			},
		});
	});

	it("关掉继承环境 / 停用状态 / 空 idle 都要如实表达", () => {
		const config = formToConfig(
			formOf({ name: "fs", command: "npx", inheritEnv: false, disabled: true, idleTimeoutMsText: "" }),
		);
		expect(config).toMatchObject({ inheritEnv: false, disabled: true, env: {}, percho: { lazy: true } });
		expect(config.percho && "idleTimeoutMs" in config.percho).toBe(false);
	});
});

describe("formToConfig（http / sse）", () => {
	it("认证方式与 TLS 偏离默认才下发；headers 整份下发", () => {
		const config = formToConfig(
			formOf({
				name: "remote",
				transport: "http",
				url: " https://example.com/mcp ",
				headersText: `Authorization=Bearer ${MCP_SECRET_MASK}`,
				authKind: "oauth",
				caFile: " /etc/ca.pem ",
				rejectUnauthorized: false,
			}),
		);
		expect(config).toEqual({
			type: "http",
			url: "https://example.com/mcp",
			headers: { Authorization: `Bearer ${MCP_SECRET_MASK}` },
			auth: { kind: "oauth" },
			tls: { caFile: "/etc/ca.pem", rejectUnauthorized: false },
			percho: { lazy: true, directTools: false },
		});
	});

	it("默认校验开启且没有 CA 文件时不下发 tls（避免写出一堆无意义默认值）", () => {
		const config = formToConfig(formOf({ name: "remote", transport: "sse", url: "https://example.com/sse" }));
		expect(config).not.toHaveProperty("tls");
		expect(config).toMatchObject({ headers: {}, auth: { kind: "none" } });
	});
});

describe("formFromView（整份回填）", () => {
	it("stdio：command/args/env/cwd/inheritEnv 全部回填，凭据值是哨兵", () => {
		const form = formFromView(
			viewOf({
				config: {
					type: "stdio",
					command: "uvx",
					args: ["mcp-server-git", "--repo", "/x"],
					env: { TOKEN: MCP_SECRET_MASK },
					cwd: "~/work",
					inheritEnv: false,
					disabled: true,
					percho: { lazy: false, directTools: true, idleTimeoutMs: 1000, tools: { exclude: ["a"] } },
				},
				disabled: true,
				percho: { lazy: false, directTools: true, idleTimeoutMs: 1000, exclude: ["a"], ask: [] },
			}),
		);
		expect(form).toMatchObject({
			name: "fs",
			transport: "stdio",
			command: "uvx",
			argsText: "mcp-server-git\n--repo\n/x",
			envText: `TOKEN=${MCP_SECRET_MASK}`,
			cwd: "~/work",
			inheritEnv: false,
			disabled: true,
			lazy: false,
			directTools: true,
			idleTimeoutMsText: "1000",
			excludeText: "a",
		});
	});

	it("http：type 缺省不影响收窄，url/headers/auth/tls 全量回填", () => {
		const form = formFromView(
			viewOf({
				name: "remote",
				transport: "http",
				authKind: "header",
				config: {
					type: "http",
					url: "https://example.com/mcp?x=1",
					headers: { Authorization: MCP_SECRET_MASK },
					auth: { kind: "header" },
					tls: { rejectUnauthorized: false },
				},
			}),
		);
		expect(form).toMatchObject({
			transport: "http",
			url: "https://example.com/mcp?x=1",
			headersText: `Authorization=${MCP_SECRET_MASK}`,
			authKind: "header",
			rejectUnauthorized: false,
			caFile: "",
			command: "",
		});
	});

	it("往返：view → form → config 后凭据条目原样回到配置（哨兵不被清洗）", () => {
		const view = viewOf({
			config: {
				type: "stdio",
				command: "npx",
				args: ["-y", "pkg"],
				env: { A: MCP_SECRET_MASK },
			},
		});
		const config = formToConfig(formFromView(view));
		expect(config).toMatchObject({ env: { A: MCP_SECRET_MASK }, command: "npx", args: ["-y", "pkg"] });
	});
});
