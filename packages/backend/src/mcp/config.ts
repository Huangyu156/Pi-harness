/**
 * MCP 配置读写（用户级 + 项目级合并）、值展开与传输参数投影。
 *
 * 为什么分两级：用户级 `<agentDir>/mcp.json` 是个人常用服务器，项目级 `<cwd>/.pi/mcp.json`
 * 随仓库走（可提交、团队共享）；同名时项目级胜——具体项目的需求覆盖个人偏好，与 settings 的层级语义一致。
 *
 * 展开时机：载入时**保留原始文本**（`${env:NAME}` 与 `~` 都不动），只在 `toTransportOptions` 落地。
 * 这样 UI 展示的是用户写下的原文，宿主环境变量改动后重连即生效，不必回头改写配置文件。
 *
 * 安全：`secretKeysOf` 只返回键名，env / headers 的**值**（凭据）绝不出现在返回值与日志里。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	McpConfigSource,
	McpHttpServerConfig,
	McpPerchoConfig,
	McpPerchoConfigResolved,
	McpServerConfig,
	McpStdioServerConfig,
	McpTransportKind,
} from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";
import { asRecord } from "./json";
import type { McpTransportOptions } from "./transport";

const log = createLogger("mcp-config");

/** percho 空闲回收缺省（ms） */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** 摘要截断长度（字符）：设置页一行放不下更长的内容 */
const SUMMARY_MAX_CHARS = 80;
/** 两级配置的固定处理顺序：先用户级后项目级，后者覆盖前者 */
const CONFIG_SOURCES: readonly McpConfigSource[] = ["user", "project"];
/** errors 文案里的文件标签：两个文件都叫 mcp.json，用相对路径区分 */
const SOURCE_LABEL: Record<McpConfigSource, string> = { user: "mcp.json", project: ".pi/mcp.json" };

/** 读写上下文（registry / service 每次操作现取，保证改配置后立即生效） */
export interface McpConfigContext {
	/** 用户级配置目录（pi 的 agentDir）：<agentDir>/mcp.json */
	agentDir: string;
	/** 项目目录（会话 cwd）：项目级配置在 <cwd>/.pi/mcp.json */
	cwd: string;
	/** 宿主环境变量来源（缺省 process.env；测试注入） */
	env?: NodeJS.ProcessEnv;
}

/** 合并后的服务器条目：配置本体 + 来源层级 + 归一化 percho + 展开后的传输参数 */
export interface ResolvedMcpServer {
	name: string;
	/** 归一化后的配置（`type` 已补齐；`${env:NAME}` 与 `~` 仍是原文，见文件头「展开时机」） */
	config: McpServerConfig;
	source: McpConfigSource;
	percho: McpPerchoConfigResolved;
	transportOptions: McpTransportOptions;
}

/** mcp.json 的顶层形状：除 mcpServers 外的键（imports / settings / 未来字段）原样保留 */
interface McpConfigFile {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

/** 配置文件路径（用户级 / 项目级） */
export function mcpConfigPath(ctx: McpConfigContext, source: McpConfigSource): string {
	return source === "project" ? join(ctx.cwd, ".pi", "mcp.json") : join(ctx.agentDir, "mcp.json");
}

/**
 * 读取并合并两级配置：项目级覆盖用户级同名项，结果按名字排序（UI 顺序稳定）。
 *
 * 非法条目跳过并回报 errors（英文文案，形如 `mcp.json: server "x" is missing "command"`），
 * 绝不因单条坏配置抛错——一份配置里有十台服务器，坏一台不该让另外九台也消失。
 */
export async function loadMcpConfig(
	ctx: McpConfigContext,
): Promise<{ servers: ResolvedMcpServer[]; errors: string[] }> {
	const env = ctx.env ?? process.env;
	const errors: string[] = [];
	const byName = new Map<string, ResolvedMcpServer>();
	for (const source of CONFIG_SOURCES) {
		const label = SOURCE_LABEL[source];
		let parseFailed = false;
		const file = await configStore(ctx, source, () => {
			parseFailed = true;
		}).read();
		if (parseFailed) {
			errors.push(`${label}: file is not valid JSON`);
			continue;
		}
		const rawServers = asRecord(file.mcpServers);
		if (file.mcpServers !== undefined && rawServers === null) {
			errors.push(`${label}: "mcpServers" must be an object`);
			continue;
		}
		if (rawServers === null) continue;
		for (const [name, raw] of Object.entries(rawServers)) {
			const config = normalizeServerConfig(name, raw, label, errors);
			if (config === null) continue;
			const kind: McpTransportKind = isHttpServerConfig(config) ? config.type : "stdio";
			byName.set(name, {
				name,
				config,
				source,
				percho: resolvePerchoConfig(config.percho, kind),
				transportOptions: toTransportOptions(config, env),
			});
		}
	}
	// 名字字典序（用码位比较而非 localeCompare：不依赖 ICU 数据，各平台输出一致）
	const servers = [...byName.values()].sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
	return { servers, errors };
}

/**
 * 写入（新增或覆盖）一台服务器：只改 `mcpServers` 键，其它顶层键原样保留。
 *
 * 与载入路径相反，这里的非法配置是调用方 bug（IPC 载荷 / UI 表单），就地抛错而不是记 errors——
 * 静默丢弃会让用户以为「保存成功了」。文案与载入校验同源，避免「能写进去却读不出来」。
 */
export async function writeMcpServer(
	ctx: McpConfigContext,
	name: string,
	config: McpServerConfig,
	source: McpConfigSource,
): Promise<void> {
	if (name.trim() === "") throw new Error("MCP server name must be a non-empty string");
	const errors: string[] = [];
	const normalized = normalizeServerConfig(name, config, SOURCE_LABEL[source], errors);
	if (normalized === null) throw new Error(errors[0] ?? `Invalid MCP server config for "${name}"`);
	await configStore(ctx, source).update((draft) => {
		// mcpServers 值形状非法时直接换成空表：能走到这里说明文件可解析，脏表没有保留价值
		const servers = asRecord(draft.mcpServers) ?? {};
		servers[name] = normalized;
		draft.mcpServers = servers;
	});
	log.info("mcp 服务器已写入配置", { name, source, type: normalized.type });
}

/**
 * 删除一台服务器（只改 `mcpServers` 键，其它顶层键原样保留）。
 * 目标文件不存在时是空操作——「删一个不存在的条目」不该凭空造出一份配置文件。
 */
export async function removeMcpServer(
	ctx: McpConfigContext,
	name: string,
	source: McpConfigSource,
): Promise<void> {
	const path = mcpConfigPath(ctx, source);
	if (!existsSync(path)) return;
	await configStore(ctx, source).update((draft) => {
		const servers = asRecord(draft.mcpServers);
		if (servers === null || !(name in servers)) return;
		delete servers[name];
		draft.mcpServers = servers;
	});
	log.info("mcp 服务器已从配置移除", { name, source });
}

/**
 * 归一化 percho 子键：缺省 lazy=true / directTools=false / idleTimeoutMs=300000 / exclude=[] / ask=[]。
 *
 * 参数放宽到 `Record<string, unknown>`：调用方（配置载入、IPC 载荷）拿到的常常是脏对象，
 * 这里逐字段 fail-soft 回默认并在日志里报出脏字段——percho 是我们自己的扩展，
 * 一个写错的布尔值不该让整台服务器从列表里消失。
 * kind 只进日志（当前三种绑定默认值一致），保留参数是为了后续按绑定分化时有统一的落点。
 */
export function resolvePerchoConfig(
	raw: McpPerchoConfig | Record<string, unknown> | undefined,
	kind: McpTransportKind | McpTransportOptions["kind"],
): McpPerchoConfigResolved {
	const source = asRecord(raw);
	const dirty: string[] = [];
	const lazy = readOptionalBoolean(source?.lazy, "lazy", dirty) ?? true;
	const directTools = readOptionalBoolean(source?.directTools, "directTools", dirty) ?? false;
	const idleTimeoutMs =
		readOptionalDuration(source?.idleTimeoutMs, "idleTimeoutMs", dirty) ?? DEFAULT_IDLE_TIMEOUT_MS;
	const tools = asRecord(source?.tools);
	if (source !== null && source.tools !== undefined && tools === null) dirty.push("tools");
	const exclude = readOptionalStringList(tools?.exclude, "tools.exclude", dirty) ?? [];
	const ask = readOptionalStringList(tools?.ask, "tools.ask", dirty) ?? [];
	if (dirty.length > 0) log.warn("mcp percho 配置有脏值，已回退默认", { kind, fields: dirty });
	return { lazy, directTools, idleTimeoutMs, exclude, ask };
}

/**
 * HTTP 族配置判定（判别键是 `type`）。
 * 必须写成「不是 stdio 就是 http 族」：stdio 允许省略 `type`，
 * 而 TS 对「可选判别键 === undefined」的否定分支不做穷尽收窄，直接读 `url`/`headers` 会报错。
 */
function isHttpServerConfig(config: McpServerConfig): config is McpHttpServerConfig {
	return config.type === "http" || config.type === "sse";
}

/**
 * 一行摘要（同一台服务器在两个界面上文案一致）：stdio = `command args[0]`；http/sse = URL 的 origin + pathname。
 * 超长截断（含省略号共 SUMMARY_MAX_CHARS 字符），查询串与 hash 有意丢掉——里面可能带 token。
 */
export function describeServer(config: McpServerConfig): string {
	if (!isHttpServerConfig(config)) {
		const [firstArg] = config.args ?? [];
		return truncateSummary(firstArg === undefined ? config.command : `${config.command} ${firstArg}`);
	}
	try {
		const target = new URL(config.url);
		return truncateSummary(`${target.origin}${target.pathname}`);
	} catch {
		// 非法 URL 在载入校验已拦下；导入路径也可能送进来，摘要退化为原文——展示函数不该成为故障点
		return truncateSummary(config.url);
	}
}

/** env / headers 的键名（排序稳定）；**永不返回值**——值就是凭据 */
export function secretKeysOf(config: McpServerConfig): string[] {
	const source = isHttpServerConfig(config) ? config.headers : config.env;
	return Object.keys(source ?? {}).sort();
}

/** 环境变量引用语法：`${env:NAME}`；NAME 必须像合法环境变量名，否则整段按原文保留（不猜） */
const ENV_REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 展开 `${env:NAME}` 引用。
 * - 缺失变量替换为空串并记 warn：让服务器自己报「配置缺失」比我们伪造一个值更容易定位问题；
 * - `$${env:NAME}` 是转义：`$$` 消费成一个字面 `$`，其后文本不再展开（结果是字面 `${env:NAME}`），
 *   供「把占位符原样交给下游 shell / 进程自己展开」的用法；
 * - `${env:}` 这类名字非法的引用原样保留，方便用户看出自己写错了。
 *
 * 单遍扫描（正则替一次到底）：替换结果不再参与匹配，避免「展开出来的 `$` 又被当引用」的递归陷阱。
 */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
	if (!value.includes("$")) return value;
	return value.replace(/\$(\$|\{env:([^}]*)\})/g, (match: string, escaped: string, name?: string) => {
		if (escaped === "$") return "$";
		if (name === undefined || !ENV_REF_NAME.test(name)) return match;
		const resolved = env[name];
		if (resolved === undefined) {
			log.warn("环境变量引用缺失，替换为空串", { name });
			return "";
		}
		return resolved;
	});
}

/**
 * `~` 前缀展开（语义与 mcp/http.ts 里的同名实现一致：只认 `~` / `~/x` / `~\x`，`~user` 不展开）。
 * home 可注入：测试要断言「展开到哪个目录」，不能依赖跑测试那台机器的真实 home。
 */
export function expandHomePath(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(home, path.slice(2));
	return path;
}

/**
 * 投影成传输构造参数（见 transport.ts），并在这里把 `${env:NAME}` 与 `~` 落地：
 * - stdio 的 command / args / cwd 是路径或命令行片段，两种展开都做；env 的**值**只展开 `${env:NAME}`
 *   （值不是路径，`~` 留在值里才是对的）；
 * - http/sse 只展开 header 的值（契约承诺的就是这一处）；URL 原样——把 URL 里的 `~` 展开只会得到非法地址；
 * - tls 原样带上：caFile 的 `~` 由 mcp/http.ts 读取时展开，两处都展开会造出「谁先谁后」的隐式约定。
 */
export function toTransportOptions(config: McpServerConfig, env: NodeJS.ProcessEnv): McpTransportOptions {
	if (!isHttpServerConfig(config)) {
		return {
			kind: "stdio",
			command: expandCommandPart(config.command, env),
			args: (config.args ?? []).map((arg) => expandCommandPart(arg, env)),
			env: expandValues(config.env, env),
			cwd: config.cwd === undefined ? undefined : expandCommandPart(config.cwd, env),
			inheritEnv: config.inheritEnv ?? true,
		};
	}
	return {
		kind: config.type === "sse" ? "http-sse" : "streamable-http",
		url: config.url,
		headers: expandValues(config.headers, env),
		tls: config.tls,
	};
}

/**
 * 配置文件站点（两级共用一套构造参数）。
 * onParseError 只有载入路径传：`JsonStore.read` 有意把损坏文件回退成默认值（坏文件不阻塞启动），
 * 但那样「整份文件非法」对用户完全不可见，故用 parse 钩子侧记一次（钩子抛错语义不变，仍由 JsonStore 记 warn 并回退）。
 */
function configStore(
	ctx: McpConfigContext,
	source: McpConfigSource,
	onParseError?: () => void,
): JsonStore<McpConfigFile> {
	return new JsonStore<McpConfigFile>({
		path: mcpConfigPath(ctx, source),
		defaultValue: () => ({ mcpServers: {} }),
		parse: (raw) => {
			try {
				return JSON.parse(raw) as McpConfigFile;
			} catch (err) {
				onParseError?.();
				throw err;
			}
		},
	});
}

/** 字段校验结果：ok=false 的 reason 是英文短句，直接拼进 errors */
type FieldOutcome<T> = { ok: true; value: T | undefined } | { ok: false; reason: string };

/**
 * 校验并归一化一条服务器配置；非法返回 null 并追加一条 errors（英文文案，形如
 * `mcp.json: server "x" is missing "command"`）。
 *
 * 三个调用点共用同一套规则与文案，避免「能写进去却读不出来」/「导入进来的配置比手写的更容易坏」：
 * 配置载入（errors 回报给 UI）、`writeMcpServer`（把 errors[0] 抛出去）、宿主导入（丢弃 errors 静默跳过）。
 */
export function normalizeServerConfig(
	name: string,
	raw: unknown,
	label: string,
	errors: string[],
): McpServerConfig | null {
	const fail = (reason: string): null => {
		errors.push(`${label}: server "${name}" ${reason}`);
		return null;
	};
	const record = asRecord(raw);
	if (record === null) return fail("must be a JSON object");

	const declared = record.type;
	if (declared !== undefined && declared !== "stdio" && declared !== "http" && declared !== "sse") {
		return fail(`has invalid "type" ${JSON.stringify(declared)} (expected "stdio", "http" or "sse")`);
	}
	const disabled = readBooleanField(record, "disabled");
	if (!disabled.ok) return fail(disabled.reason);
	// 边界断言：percho 子键这里只判定「是对象」——字段级脏值留给 resolvePerchoConfig 归一化，
	// 写坏的 percho 不该让整台服务器从列表里消失，故有意不在这里逐字段校验。
	const perchoRaw = asRecord(record.percho);
	const percho = perchoRaw === null ? undefined : (perchoRaw as McpPerchoConfig);
	// type 缺省推断：给了 url 就当 http（sse 必须显式声明，否则无法与 http 区分）
	const url = record.url;
	const type = declared ?? (typeof url === "string" && url !== "" ? "http" : "stdio");
	if (type === "stdio") {
		const command = readStringField(record, "command");
		if (!command.ok) return fail(command.reason);
		if (command.value === undefined || command.value.trim() === "") return fail(`is missing "command"`);
		const args = readStringListField(record, "args");
		if (!args.ok) return fail(args.reason);
		const env = readStringMapField(record, "env");
		if (!env.ok) return fail(env.reason);
		const cwd = readStringField(record, "cwd");
		if (!cwd.ok) return fail(cwd.reason);
		const inheritEnv = readBooleanField(record, "inheritEnv");
		if (!inheritEnv.ok) return fail(inheritEnv.reason);
		const config: McpStdioServerConfig = { type: "stdio", command: command.value };
		if (args.value !== undefined) config.args = args.value;
		if (env.value !== undefined) config.env = env.value;
		if (cwd.value !== undefined) config.cwd = cwd.value;
		if (inheritEnv.value !== undefined) config.inheritEnv = inheritEnv.value;
		if (disabled.value !== undefined) config.disabled = disabled.value;
		if (percho !== undefined) config.percho = percho;
		return config;
	}
	const urlField = readStringField(record, "url");
	if (!urlField.ok) return fail(urlField.reason);
	if (urlField.value === undefined || urlField.value.trim() === "") return fail(`is missing "url"`);
	if (!isHttpUrl(urlField.value)) {
		return fail(`has invalid "url" ${JSON.stringify(urlField.value)} (expected http or https)`);
	}
	const headers = readStringMapField(record, "headers");
	if (!headers.ok) return fail(headers.reason);
	const auth = readAuthField(record, "auth");
	if (!auth.ok) return fail(auth.reason);
	const tls = readTlsField(record, "tls");
	if (!tls.ok) return fail(tls.reason);
	const config: McpHttpServerConfig = { type, url: urlField.value };
	if (headers.value !== undefined) config.headers = headers.value;
	if (auth.value !== undefined) config.auth = auth.value;
	if (tls.value !== undefined) config.tls = tls.value;
	if (disabled.value !== undefined) config.disabled = disabled.value;
	if (percho !== undefined) config.percho = percho;
	return config;
}

/** HTTP 传输只能走 http(s)；file:/ws: 之类在传输层必然失败，早拦早报 */
function isHttpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function readStringField(record: Record<string, unknown>, key: string): FieldOutcome<string> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string") return { ok: false, reason: `has non-string "${key}"` };
	return { ok: true, value };
}

function readBooleanField(record: Record<string, unknown>, key: string): FieldOutcome<boolean> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "boolean") return { ok: false, reason: `has non-boolean "${key}"` };
	return { ok: true, value };
}

function readStringListField(record: Record<string, unknown>, key: string): FieldOutcome<string[]> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(value)) return { ok: false, reason: `has non-array "${key}"` };
	const items = value.filter((item): item is string => typeof item === "string");
	if (items.length !== value.length) return { ok: false, reason: `has non-string item in "${key}"` };
	return { ok: true, value: items };
}

function readStringMapField(
	record: Record<string, unknown>,
	key: string,
): FieldOutcome<Record<string, string>> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	const raw = asRecord(value);
	if (raw === null) return { ok: false, reason: `has non-object "${key}"` };
	const out: Record<string, string> = {};
	for (const [entryKey, entryValue] of Object.entries(raw)) {
		if (typeof entryValue !== "string") {
			return { ok: false, reason: `has non-string value for "${key}.${entryKey}"` };
		}
		out[entryKey] = entryValue;
	}
	return { ok: true, value: out };
}

function readAuthField(
	record: Record<string, unknown>,
	key: string,
): FieldOutcome<McpHttpServerConfig["auth"]> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	const raw = asRecord(value);
	if (raw === null) return { ok: false, reason: `has non-object "${key}"` };
	const kind = raw.kind;
	if (kind !== "none" && kind !== "header" && kind !== "oauth") {
		return { ok: false, reason: `has invalid "${key}.kind" (expected "none", "header" or "oauth")` };
	}
	return { ok: true, value: { kind } };
}

function readTlsField(
	record: Record<string, unknown>,
	key: string,
): FieldOutcome<McpHttpServerConfig["tls"]> {
	const value = record[key];
	if (value === undefined) return { ok: true, value: undefined };
	const raw = asRecord(value);
	if (raw === null) return { ok: false, reason: `has non-object "${key}"` };
	const tls: NonNullable<McpHttpServerConfig["tls"]> = {};
	const caFile = readStringField(raw, "caFile");
	if (!caFile.ok) return { ok: false, reason: `has non-string "${key}.caFile"` };
	if (caFile.value !== undefined) tls.caFile = caFile.value;
	const rejectUnauthorized = readBooleanField(raw, "rejectUnauthorized");
	if (!rejectUnauthorized.ok) return { ok: false, reason: `has non-boolean "${key}.rejectUnauthorized"` };
	if (rejectUnauthorized.value !== undefined) tls.rejectUnauthorized = rejectUnauthorized.value;
	return { ok: true, value: tls };
}

/** 先展开 `${env:NAME}` 再展开 `~`：`${env:DIR}/bin` 与 `~/bin` 两种写法都能落到真实路径上 */
function expandCommandPart(value: string, env: NodeJS.ProcessEnv): string {
	return expandHomePath(expandEnvRefs(value, env));
}

/** 逐值展开（不改键名：键名是用户写的名字，不是引用） */
function expandValues(
	source: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source ?? {})) out[key] = expandEnvRefs(value, env);
	return out;
}

function truncateSummary(text: string): string {
	if (text.length <= SUMMARY_MAX_CHARS) return text;
	return `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function readOptionalBoolean(value: unknown, field: string, dirty: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		dirty.push(field);
		return undefined;
	}
	return value;
}

function readOptionalDuration(value: unknown, field: string, dirty: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		dirty.push(field);
		return undefined;
	}
	return value;
}

function readOptionalStringList(value: unknown, field: string, dirty: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		dirty.push(field);
		return undefined;
	}
	const items = value.filter((item): item is string => typeof item === "string");
	if (items.length !== value.length) {
		dirty.push(field);
		return undefined;
	}
	return items;
}
