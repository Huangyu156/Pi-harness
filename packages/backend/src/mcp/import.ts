/**
 * 宿主 MCP 配置的只读扫描（导入向导的数据源）。
 *
 * **只读是硬约束**：绝不写、绝不新建宿主文件或目录——那些文件属于别的应用，导入只是把数据读出来。
 * 也因此这里不用 `JsonStore`：它面向本仓自己的配置文件（原子写 + 归一化 + 损坏回退默认），
 * 而宿主文件是外部格式，读不懂就整份跳过，既不归一化也不落盘（读宿主文件用 `JsonStore.read`
 * 还会把损坏文件静默当成空文件，这里更需要「跳过并记日志」的明确语义）。
 *
 * **宁缺勿错**：任何「不知道该怎么解析」的形状（不可解析的 `${…}` 占位符、Codex TOML 子集之外的语法）
 * 一律跳过该条或该宿主，绝不猜一个值——导入一台语义错误的服务器（尤其带着 env 里的凭据）
 * 比漏掉它危险得多。
 *
 * 输出顺序固定：宿主按 `McpHostName` 声明序，同一宿主内部按文件「用户级 → 项目级」，组内按名字字典序。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpHostName, McpImportCandidate, McpImportServer, McpServerConfig } from "@percho/shared";
import { createLogger } from "../log";
import { describeServer, normalizeServerConfig } from "./config";
import { asRecord } from "./json";

const log = createLogger("mcp-import");

/** 扫描参数（env / home / platform / agentDir 均可注入：测试不依赖跑测试那台机器的真实配置） */
export interface HostScanOptions {
	/** 项目目录（会话 cwd）：<cwd>/.mcp.json、<cwd>/.cursor/mcp.json、<cwd>/.vscode/mcp.json 与 `${workspaceFolder}` 都用它 */
	cwd: string;
	/** 宿主环境变量（win32 用 APPDATA 定位宿主目录；缺省 process.env） */
	env?: NodeJS.ProcessEnv;
	/** home 目录（缺省 os.homedir()） */
	home?: string;
	/** 平台（缺省 process.platform；测试注入以便断言三平台路径表） */
	platform?: NodeJS.Platform;
	/** agentDir（adapter 宿主 = <agentDir>/mcp-adapter.json，由调用方传入；缺省则跳过该宿主） */
	agentDir?: string;
	/** 当前已存在的服务器名：命中的条目 conflict=true（导入时会被覆盖） */
	existingNames?: string[];
}

/** 一个宿主的配置文件规格 */
interface HostFileSpec {
	host: McpHostName;
	path: string;
	format: "json" | "toml";
	/** VS Code 用 `servers` 键（条目自带 `type`）；缺省优先 `mcpServers` */
	preferServers?: boolean;
}

/** 路径解析上下文 */
interface HostScanContext {
	home: string;
	cwd: string;
	/** Windows 漫游 AppData（%APPDATA%；环境变量缺失时退回 <home>/AppData/Roaming） */
	appData: string;
	platform: NodeJS.Platform;
	agentDir: string | undefined;
}

/**
 * 扫描本机各宿主的 MCP 配置。只读、按文件聚合、跳过不存在或读不懂的文件。
 * 文件存在但没有任何可导入条目时**不出现**在结果里（UI 上没有可操作内容，出现只会是噪音）。
 */
export async function scanHostConfigs(options: HostScanOptions): Promise<McpImportCandidate[]> {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const appData =
		env.APPDATA === undefined || env.APPDATA === "" ? join(home, "AppData", "Roaming") : env.APPDATA;
	const context: HostScanContext = {
		home,
		cwd: options.cwd,
		appData,
		platform: options.platform ?? process.platform,
		agentDir: options.agentDir,
	};
	const existing = new Set(options.existingNames ?? []);
	const candidates: McpImportCandidate[] = [];
	for (const spec of hostFileSpecs(context)) {
		const text = await readHostFile(spec.path);
		if (text === null) continue;
		const rawEntries =
			spec.format === "toml"
				? parseCodexToml(text, spec.path)
				: parseJsonHostFile(text, spec.path, spec.preferServers === true);
		if (rawEntries === null) continue;
		const servers: McpImportServer[] = [];
		for (const [name, raw] of rawEntries) {
			const config = mapHostEntry(name, raw, context.cwd, spec.path);
			if (config === null) continue;
			servers.push({ name, config, summary: describeServer(config), conflict: existing.has(name) });
		}
		if (servers.length === 0) continue;
		// 名字字典序（码位比较，不依赖 locale / ICU 数据）
		servers.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
		candidates.push({ host: spec.host, path: spec.path, servers });
	}
	log.debug("宿主 MCP 配置扫描完成", {
		candidates: candidates.length,
		hosts: candidates.map((candidate) => candidate.host),
	});
	return candidates;
}

/**
 * 宿主文件清单：顺序 = `McpHostName` 的声明序，同一宿主内「用户级 → 项目级」。
 * win32 走 `%APPDATA%`（VS Code / Claude Desktop / Cline 在 Windows 上的真实布局），
 * darwin / linux 走 home 下的惯例路径；`~/.config/mcp/mcp.json` 这类「跨工具约定」在三个平台
 * 都按家目录解析（那正是该约定本身的语义）。
 */
function hostFileSpecs(context: HostScanContext): HostFileSpec[] {
	const { home, cwd, appData, agentDir } = context;
	let vscodeUser: string;
	let claudeDesktop: string;
	if (context.platform === "win32") {
		vscodeUser = join(appData, "Code", "User");
		claudeDesktop = join(appData, "Claude", "claude_desktop_config.json");
	} else if (context.platform === "darwin") {
		vscodeUser = join(home, "Library", "Application Support", "Code", "User");
		claudeDesktop = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
	} else {
		vscodeUser = join(home, ".config", "Code", "User");
		claudeDesktop = join(home, ".config", "Claude", "claude_desktop_config.json");
	}
	const specs: HostFileSpec[] = [
		{ host: "shared", path: join(home, ".config", "mcp", "mcp.json"), format: "json" },
		{ host: "shared", path: join(home, ".agents", "mcp.json"), format: "json" },
		{ host: "shared", path: join(home, ".agents", "mcp", "mcp.json"), format: "json" },
		{ host: "shared", path: join(cwd, ".mcp.json"), format: "json" },
		{ host: "claude-desktop", path: claudeDesktop, format: "json" },
		{ host: "claude-code", path: join(home, ".claude.json"), format: "json" },
		{ host: "cursor", path: join(home, ".cursor", "mcp.json"), format: "json" },
		{ host: "cursor", path: join(cwd, ".cursor", "mcp.json"), format: "json" },
		{ host: "vscode", path: join(vscodeUser, "mcp.json"), format: "json", preferServers: true },
		{ host: "vscode", path: join(cwd, ".vscode", "mcp.json"), format: "json", preferServers: true },
		{
			host: "cline",
			// Cline 是 VS Code 扩展，配置在扩展的 globalStorage 里（与 VS Code 用户目录同源）
			path: join(
				vscodeUser,
				"globalStorage",
				"saoudrizwan.claude-dev",
				"settings",
				"cline_mcp_settings.json",
			),
			format: "json",
		},
		{ host: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), format: "json" },
		{ host: "codex", path: join(home, ".codex", "config.toml"), format: "toml" },
	];
	if (agentDir !== undefined) {
		specs.push({ host: "adapter", path: join(agentDir, "mcp-adapter.json"), format: "json" });
	}
	return specs;
}

/** 读宿主文件；不存在/读不了 → null（跳过）。ENOENT 是常态（大多数宿主没装），不记日志 */
async function readHostFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		const missing = typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
		if (!missing) {
			log.warn("宿主 MCP 配置读取失败，已跳过", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return null;
	}
}

/**
 * 解析宿主 JSON 文件为「服务器名 → 原始条目」。
 * 多数宿主用 `mcpServers`，VS Code 用 `servers`（条目自带 `type`），两种键都读；
 * 两个键并存时同名条目取先出现者（preferServers 决定先读哪个键）。
 * 文件不是合法 JSON、根不是对象 → 整份跳过（null）。
 */
function parseJsonHostFile(
	text: string,
	label: string,
	preferServers: boolean,
): Map<string, Record<string, unknown>> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		log.warn("宿主 MCP 配置不是合法 JSON，整份跳过", {
			path: label,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	const root = asRecord(parsed);
	if (root === null) {
		log.warn("宿主 MCP 配置的根不是对象，整份跳过", { path: label });
		return null;
	}
	const entries = new Map<string, Record<string, unknown>>();
	for (const key of preferServers ? ["servers", "mcpServers"] : ["mcpServers", "servers"]) {
		const raw = asRecord(root[key]);
		if (raw === null) continue;
		for (const [name, entry] of Object.entries(raw)) {
			const record = asRecord(entry);
			if (record === null || entries.has(name)) continue;
			entries.set(name, record);
		}
	}
	return entries;
}

/**
 * 映射一个宿主条目：只认 `command` / `args` / `env` / `cwd` / `url` / `headers`（同名直传），
 * 宿主专有字段（`autoApprove` / `alwaysAllow` / `disabled` / `envFile` / `oauth`…）有意丢弃——
 * Percho 的确认、直投、凭据各有自己的语义，把宿主的语义猜过来只会得到半对的行为。
 * 形状不完整或含不可解析占位符 → null（该条跳过）。
 */
function mapHostEntry(
	name: string,
	raw: Record<string, unknown>,
	cwd: string,
	label: string,
): McpServerConfig | null {
	const substituted = substituteEntry(raw, cwd);
	if (substituted === null) {
		log.debug("宿主条目含不可解析占位符，已跳过", { path: label, server: name });
		return null;
	}
	// 校验规则与配置文件载入路径共用（config.ts 的 normalizeServerConfig）；errors 丢弃：
	// 宿主文件不是我们写的，用户没有可修的东西，跳过即可。
	return normalizeServerConfig(name, substituted, label, []);
}

/** 对条目里的字符串字段做占位符处理；返回 null = 含不可解析占位符（该条跳过） */
function substituteEntry(raw: Record<string, unknown>, cwd: string): Record<string, unknown> | null {
	const out: Record<string, unknown> = { ...raw };
	for (const field of ["command", "url", "cwd", "type"] as const) {
		const mapped = substitutePlaceholders(raw[field], cwd);
		if (mapped === null) return null;
		if (mapped !== undefined) out[field] = mapped;
	}
	const args = substituteStringList(raw.args, cwd);
	if (args === null) return null;
	if (args !== undefined) out.args = args;
	const env = substituteStringMap(raw.env, cwd);
	if (env === null) return null;
	if (env !== undefined) out.env = env;
	const headers = substituteStringMap(raw.headers, cwd);
	if (headers === null) return null;
	if (headers !== undefined) out.headers = headers;
	return out;
}

/** `${workspaceFolder}` 按 VS Code 语义替换成项目目录；本仓的 `${env:NAME}` 原样保留（由 config.ts 的展开器处理） */
const WORKSPACE_FOLDER_REF = /\$\{workspaceFolder\}/g;
/** 判定「还有没有我们解析不了的占位符」时，先把只属于本仓展开器的 env 引用摘掉 */
const ENV_REF = /\$\{env:[^}]*\}/g;

/**
 * 替换已知占位符；返回 null = 含无法解析的 `${…}`（如 `${CLAUDE_PLUGIN_ROOT}` / `${input:…}`），
 * 该条 server 整条跳过——猜错的值可能把服务器指到别的地方去，宁缺勿错。
 * 注意 `$${env:X}` 不算无法解析：`$$` 是转义，展开器会把结果解码成字面 `${env:X}`。
 */
function substitutePlaceholders(value: unknown, cwd: string): string | null | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const replaced = value.replace(WORKSPACE_FOLDER_REF, cwd);
	const probe = replaced.replace(ENV_REF, "");
	return probe.includes("${") ? null : replaced;
}

/** 逐个元素做占位符替换（用于 args）；null = 不可解析或含非字符串项 */
function substituteStringList(value: unknown, cwd: string): string[] | null | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		const mapped = substitutePlaceholders(item, cwd);
		if (mapped === null || mapped === undefined) return null;
		out.push(mapped);
	}
	return out;
}

/** 逐个值做占位符替换（用于 env / headers）；null = 不可解析或含非字符串值 */
function substituteStringMap(value: unknown, cwd: string): Record<string, string> | null | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (record === null) return null;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(record)) {
		const mapped = substitutePlaceholders(item, cwd);
		if (mapped === null || mapped === undefined) return null;
		out[key] = mapped;
	}
	return out;
}

/**
 * Codex `~/.codex/config.toml` 的**窄子集**解析。
 *
 * 只认 `[mcp_servers.<name>]` 与 `[mcp_servers.<name>.env]` 两类表，表内键只认
 * `command`（字符串）、`args`（字符串数组，可跨行）、`env`（内联表 `{ KEY = "v" }` 或子表）、
 * `cwd`（字符串）、`url`（字符串）、`startup_timeout_ms`（整数，认得但有意忽略——连接超时由 Percho 自己定）。
 *
 * 为什么这么窄：完整 TOML 有大量语法（多行字符串、字面量串、日期、数字下划线、点号键、
 * 异构数组、更多转义…），手写「够用」的解析器迟早会在某种输入上给出**语义错误的**配置，
 * 而导入一台错的服务器（尤其带着 env 里的凭据）比漏掉它危险得多，为此不引 TOML 依赖（仓库硬约束）。
 * 故：任何落在子集之外的形状（表内未知键、多行字符串、非字符串值、重复定义、更深的嵌套表、
 * 顶层把 `mcp_servers` 写成点号键）一律**整份跳过该宿主**，宁缺勿错。
 * 代价要说清楚：Codex 配置里只要有一处用了我们没有建模的写法（例如新版加的 `bearer_token_env_var`），
 * 整个 `config.toml` 都不会出现在导入向导里——用户仍可手工在 Percho 里添加这台服务器。
 */
function parseCodexToml(text: string, label: string): Map<string, Record<string, unknown>> | null {
	const servers = new Map<string, Record<string, unknown>>();
	/** `[mcp_servers.<name>.env]` 子表收集到的键值（与内联表形式互斥，见下） */
	const envSubtables = new Map<string, Record<string, string>>();
	/** 当前所在表；null = 顶层或我们不关心的表（其内容直接忽略） */
	let current: { kind: "server"; name: string } | { kind: "env"; name: string } | { kind: "root" } | null =
		null;
	/** 跨行数组：所属服务器 + 已累积的原文 */
	let pendingArray: { name: string; text: string } | null = null;
	/** 多行字符串定界符（`"""` / `'''`）：在它闭合前，行内容不参与解析 */
	let multiline: string | null = null;

	const abort = (reason: string): null => {
		log.warn("Codex TOML 出现子集之外的形状，整份跳过", { path: label, reason });
		return null;
	};

	for (const rawLine of text.split(/\r?\n/)) {
		if (multiline !== null) {
			if (rawLine.includes(multiline)) multiline = null;
			// 多行字符串里出现「像表头」的行 → 我们对外层结构的判断已不可靠
			if (/^\s*\[/.test(rawLine)) return abort("table header inside a multi-line string");
			continue;
		}
		const line = stripTomlComment(rawLine);
		if (line.trim() === "") continue;
		const marker = line.includes('"""') ? '"""' : line.includes("'''") ? "'''" : null;
		if (marker !== null) {
			if (current !== null || pendingArray !== null) return abort("multi-line string inside mcp_servers");
			// 定界符出现奇数次 = 字符串跨到后续行；偶数次（如 `"""x"""`）同一行内自闭合
			if (line.split(marker).length % 2 === 0) multiline = marker;
			continue;
		}
		if (/^\s*\[\[/.test(line)) {
			if (/^\s*\[\[\s*mcp_servers/.test(line)) return abort("array of tables for mcp_servers");
			current = null;
			continue;
		}
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header !== null) {
			if (pendingArray !== null) return abort("table header inside a multi-line array");
			const parsed = parseTomlHeader(header[1] ?? "");
			if (parsed === null) return abort(`unsupported table ${JSON.stringify(header[1])}`);
			if (parsed.kind === "other") {
				current = null;
				continue;
			}
			if (parsed.kind === "root") {
				current = { kind: "root" };
				continue;
			}
			const existingRecord = servers.get(parsed.name);
			if (parsed.kind === "server") {
				if (existingRecord !== undefined) return abort(`duplicate table for server "${parsed.name}"`);
				servers.set(parsed.name, {});
				current = { kind: "server", name: parsed.name };
				continue;
			}
			// env 子表：TOML 允许隐式创建父表，但内联表形式与环境子表形式不能混用
			if (existingRecord === undefined) servers.set(parsed.name, {});
			if ("env" in (existingRecord ?? {}) || envSubtables.has(parsed.name)) {
				return abort(`env defined twice for server "${parsed.name}"`);
			}
			envSubtables.set(parsed.name, {});
			current = { kind: "env", name: parsed.name };
			continue;
		}
		if (current === null) {
			// 顶层/别的表里的键值一概不解析，但「顶层直接把 mcp_servers 写成点号键」是另一种定义方式
			const topKey = /^\s*([^\s=]+)\s*=/.exec(line)?.[1] ?? "";
			if (/^["']?mcp_servers["']?(\s*\.|$)/.test(topKey)) return abort("mcp_servers as a dotted key");
			continue;
		}
		if (pendingArray !== null) {
			pendingArray.text += `\n${line}`;
			if (!line.includes("]")) continue;
			const value = parseTomlStringArray(pendingArray.text);
			if (value === null) return abort(`unparsable multi-line args for "${pendingArray.name}"`);
			const record = servers.get(pendingArray.name);
			if (record === undefined) return abort("multi-line array outside any server table");
			record.args = value;
			pendingArray = null;
			continue;
		}
		const assignment = /^\s*([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
		if (assignment === null) return abort(`unparsable line ${JSON.stringify(line.trim())}`);
		const keyPath = splitTomlPath(assignment[1] ?? "");
		if (keyPath === null || keyPath.length !== 1) {
			return abort(`unsupported key ${JSON.stringify(assignment[1])}`);
		}
		const key = keyPath[0] ?? "";
		const valueText = assignment[2] ?? "";
		if (current.kind === "root") return abort(`unsupported key ${JSON.stringify(key)} in [mcp_servers]`);
		const record = servers.get(current.name);
		if (record === undefined) return abort(`key outside any server table`);
		if (current.kind === "env") {
			const envTable = envSubtables.get(current.name);
			if (envTable === undefined) return abort(`env key outside a server env table`);
			if (key in envTable) return abort(`duplicate env key ${JSON.stringify(key)}`);
			const value = parseTomlString(valueText);
			if (value === null) return abort(`non-string env value for ${JSON.stringify(key)}`);
			envTable[key] = value;
			continue;
		}
		if (key === "startup_timeout_ms") {
			// 认得但有意忽略；值仍要能解析成整数，否则说明这份配置的形状与我们的假设不符
			if (!/^[+-]?\d(_?\d)*$/.test(valueText.trim())) {
				return abort(`non-integer value for "startup_timeout_ms"`);
			}
			continue;
		}
		if (key === "args") {
			if ("args" in record) return abort(`duplicate key "args"`);
			const value = parseTomlStringArray(valueText);
			if (value !== null) {
				record.args = value;
				continue;
			}
			if (!valueText.trim().startsWith("[") || valueText.includes("]")) {
				return abort(`unparsable args for server "${current.name}"`);
			}
			pendingArray = { name: current.name, text: valueText };
			continue;
		}
		if (key === "env") {
			if ("env" in record || envSubtables.has(current.name)) {
				return abort(`env defined twice for server "${current.name}"`);
			}
			const value = parseTomlInlineTable(valueText);
			if (value === null) return abort(`unparsable env table for server "${current.name}"`);
			record.env = value;
			continue;
		}
		if (key === "command" || key === "cwd" || key === "url") {
			if (key in record) return abort(`duplicate key ${JSON.stringify(key)}`);
			const value = parseTomlString(valueText);
			if (value === null) return abort(`non-string value for ${JSON.stringify(key)}`);
			record[key] = value;
			continue;
		}
		return abort(`unsupported key ${JSON.stringify(key)}`);
	}
	if (multiline !== null || pendingArray !== null) return abort("file ends inside a string or array");
	// env 子表在解析完再合并（空子表不留 env 键，好让校验看到的是「没写 env」）
	for (const [name, env] of envSubtables) {
		const record = servers.get(name);
		if (record === undefined || Object.keys(env).length === 0) continue;
		record.env = env;
	}
	return servers;
}

/** Codex 表头分类；null = 前缀像 `mcp_servers` 但形状不在子集内（调用方整份跳过） */
function parseTomlHeader(
	header: string,
):
	| { kind: "server"; name: string }
	| { kind: "env"; name: string }
	| { kind: "root" }
	| { kind: "other" }
	| null {
	if (!header.startsWith("mcp_servers")) return { kind: "other" };
	const rest = header.slice("mcp_servers".length);
	if (rest === "") return { kind: "root" };
	if (!rest.startsWith(".")) return null;
	const [name, second, ...deeper] = splitTomlPath(rest.slice(1)) ?? [];
	if (name === undefined) return null;
	if (second === undefined && deeper.length === 0) return { kind: "server", name };
	if (second === "env" && deeper.length === 0) return { kind: "env", name };
	return null;
}

/** 按 TOML 点号路径拆分（引号键名支持，引号内的点号不是分隔符）；任何不确定的形状 → null */
function splitTomlPath(text: string): string[] | null {
	const parts: string[] = [];
	let index = 0;
	let current = "";
	let quote: string | null = null;
	while (index < text.length) {
		const char = text.charAt(index);
		index += 1;
		if (quote !== null) {
			if (quote === '"' && char === "\\") {
				current += char + text.charAt(index);
				index += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			if (current !== "") return null;
			quote = char;
			continue;
		}
		if (char === ".") {
			if (current === "") return null;
			parts.push(current);
			current = "";
			continue;
		}
		if (!/[A-Za-z0-9_-]/.test(char)) return null;
		current += char;
	}
	if (quote !== null || current === "") return null;
	parts.push(current);
	return parts;
}

/** 去掉行内 `#` 注释（引号内的 `#` 不是注释）；多行字符串由调用方另行处理 */
function stripTomlComment(line: string): string {
	let quote: string | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line.charAt(index);
		if (quote !== null) {
			if (quote === '"' && char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "#") return line.slice(0, index);
	}
	return line;
}

/** 解析一个 TOML 字符串字面量（基本字符串支持短转义、字面量字符串原样）；非字符串 → null */
function parseTomlString(text: string): string | null {
	const trimmed = text.trim();
	const quote = trimmed.charAt(0);
	if (quote !== '"' && quote !== "'") return null;
	const end = findClosingQuote(trimmed, 1, quote);
	if (end === -1) return null;
	if (trimmed.slice(end + 1).trim() !== "") return null;
	const body = trimmed.slice(1, end);
	return quote === '"' ? unescapeTomlBasic(body) : body;
}

/** 解析字符串数组（允许跨行与尾随逗号）；出现非字符串项或语法不完整 → null */
function parseTomlStringArray(text: string): string[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	const body = trimmed.slice(1, -1);
	const items: string[] = [];
	let index = 0;
	while (index < body.length) {
		while (index < body.length && TOML_SEPARATOR.test(body.charAt(index))) index += 1;
		if (index >= body.length) break;
		const quote = body.charAt(index);
		if (quote !== '"' && quote !== "'") return null;
		const end = findClosingQuote(body, index + 1, quote);
		if (end === -1) return null;
		const raw = body.slice(index + 1, end);
		const item = quote === '"' ? unescapeTomlBasic(raw) : raw;
		if (item === null) return null;
		items.push(item);
		index = end + 1;
	}
	return items;
}

/** 解析 `{ KEY = "v", … }` 内联表（值必须是字符串；空表与尾随逗号合法）；其它形状 → null */
function parseTomlInlineTable(text: string): Record<string, string> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	const body = trimmed.slice(1, -1);
	const out: Record<string, string> = {};
	let index = 0;
	while (index < body.length) {
		while (index < body.length && TOML_SEPARATOR.test(body.charAt(index))) index += 1;
		if (index >= body.length) break;
		const equals = body.indexOf("=", index);
		if (equals === -1) return null;
		const [key, ...extra] = splitTomlPath(body.slice(index, equals).trim()) ?? [];
		if (key === undefined || extra.length > 0) return null;
		let valueIndex = equals + 1;
		while (valueIndex < body.length && TOML_WHITESPACE.test(body.charAt(valueIndex))) valueIndex += 1;
		const quote = body.charAt(valueIndex);
		if (quote !== '"' && quote !== "'") return null;
		const end = findClosingQuote(body, valueIndex + 1, quote);
		if (end === -1) return null;
		const raw = body.slice(valueIndex + 1, end);
		const value = quote === '"' ? unescapeTomlBasic(raw) : raw;
		if (value === null || key in out) return null;
		out[key] = value;
		index = end + 1;
	}
	return out;
}

/** 找配对引号（基本字符串里 `\` 转义下一个字符）；找不到返回 -1 */
function findClosingQuote(text: string, start: number, quote: string): number {
	let index = start;
	while (index < text.length) {
		const char = text.charAt(index);
		if (quote === '"' && char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) return index;
		index += 1;
	}
	return -1;
}

/**
 * 基本字符串的转义：只认单值短转义表；`\uXXXX` / `\UXXXXXXXX` 等未覆盖的转义返回 null（不猜）。
 * 少解析一种转义最多是漏掉一条服务器，猜错却可能让服务器收到错误的参数。
 */
function unescapeTomlBasic(body: string): string | null {
	if (!body.includes("\\")) return body;
	let out = "";
	for (let index = 0; index < body.length; index += 1) {
		const char = body.charAt(index);
		if (char !== "\\") {
			out += char;
			continue;
		}
		const mapped = TOML_ESCAPES[body.charAt(index + 1)];
		if (mapped === undefined) return null;
		out += mapped;
		index += 1;
	}
	return out;
}

/** TOML 基本字符串的短转义（静态表） */
const TOML_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
};
/** 数组 / 内联表里的分隔符与空白（TOML 允许跨行与尾随逗号） */
const TOML_SEPARATOR = /[,\s]/;
const TOML_WHITESPACE = /\s/;
