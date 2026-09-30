import type { McpPerchoConfig, McpServerConfig, McpServerView, McpTransportKind } from "@percho/shared";

/**
 * MCP 服务器表单状态 ↔ McpServerConfig 的纯转换层（与 React 无关，可单测）。
 *
 * 为什么单独一层：抽屉表单有 20+ 个字段（三套传输字段 + percho 扩展），
 * 直接散在 JSX 里做「文本 → 配置」的解析既测不到也容易漏字段。这里承担三件事：
 * 1. 文本态与配置态的相互映射（textarea 天然是字符串；数值留空 = 用后端默认）；
 * 2. 提交前的校验（错误只给错误码，文案由 i18n 给）；
 * 3. 凭据哨兵的原样往返（见下）。
 *
 * 反直觉点（务必保留）：`upsertServer` 是**整份写入**，所以编辑表单必须回填全部字段，
 * 否则没回填的字段会被真的清掉。凭据值的处理靠 `MCP_SECRET_MASK`：
 * `McpServerView.config` 里 env/headers 的值一律是哨兵 `***`，回填成 `KEY=***` 行后
 * **原样提交**——后端遇到哨兵就换回磁盘上的原值，用户改成别的值即覆盖、删行即删键。
 * 因此这里绝不能把哨兵「清洗」成空串或省略该字段（那等于删掉用户的密钥）。
 */
export interface McpServerFormState {
	name: string;
	transport: McpTransportKind;
	/** stdio：可执行文件（Windows 上支持 .cmd/.exe 解析） */
	command: string;
	/** stdio：每行一个参数 */
	argsText: string;
	/** stdio：KEY=VALUE 逐行（值支持 ${env:NAME}） */
	envText: string;
	cwd: string;
	inheritEnv: boolean;
	/** http/sse */
	url: string;
	/** http/sse：KEY=VALUE 逐行 */
	headersText: string;
	authKind: "none" | "header" | "oauth";
	caFile: string;
	rejectUnauthorized: boolean;
	/** percho 扩展 */
	lazy: boolean;
	directTools: boolean;
	/** 文本态：留空 = 后端默认（300000ms）；0 = 不断开 */
	idleTimeoutMsText: string;
	excludeText: string;
	askText: string;
	/**
	 * 停用标记：表单里没有对应控件（行内开关负责），但必须原样回传——
	 * upsertServer 是整份写入，漏掉它会把停用的服务器静默改成启用。
	 */
	disabled: boolean;
}

/** 新增表单初值（percho 默认值与后端 resolvePerchoConfig 对齐） */
export const EMPTY_MCP_FORM: McpServerFormState = {
	name: "",
	transport: "stdio",
	command: "",
	argsText: "",
	envText: "",
	cwd: "",
	inheritEnv: true,
	url: "",
	headersText: "",
	authKind: "none",
	caFile: "",
	rejectUnauthorized: true,
	lazy: true,
	directTools: false,
	idleTimeoutMsText: "",
	excludeText: "",
	askText: "",
	disabled: false,
};

/** 服务器名会进工具名（mcp__<server>__<tool>）与记忆键，限制在安全字符集，避免出现不可匹配的键 */
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const IDLE_RE = /^\d+$/;

export type McpFormError =
	| "nameRequired"
	| "nameInvalid"
	| "commandRequired"
	| "urlRequired"
	| "urlScheme"
	| "idleTimeoutInvalid"
	| "keyValueInvalid";

/** KEY=VALUE 逐行解析：空行忽略；无等号或空键的行记为 invalid（不静默丢成空值） */
export function keyValueLines(text: string): { entries: Record<string, string>; invalid: string[] } {
	const entries: Record<string, string> = {};
	const invalid: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const at = line.indexOf("=");
		// 0 与 -1 都非法：前者是空键，后者根本不是键值对
		if (at <= 0) {
			invalid.push(line);
			continue;
		}
		entries[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return { entries, invalid };
}

/** 列表类字段：逗号或换行分隔，去空去重（仓库既有「可粘贴逗号/换行列表」的手感） */
export function parseLineList(text: string): string[] {
	const seen = new Set<string>();
	for (const part of text.split(/[\n,]/)) {
		const item = part.trim();
		if (item) seen.add(item);
	}
	return [...seen];
}

/** 参数逐行解析：**只按换行**切分（args 里的逗号是参数的一部分，如 `--filter=a,b`，不能被当分隔符） */
function parseArgLines(text: string): string[] {
	const args: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const arg = raw.trim();
		if (arg) args.push(arg);
	}
	return args;
}

/** env/headers → `KEY=VALUE` 行（值已是哨兵；用户不改动 = 提交回哨兵 = 保持原值） */
export function formatKeyValueLines(entries: Record<string, string> | undefined): string {
	return Object.entries(entries ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** 编辑态回填：transport/percho 从视图取，其余字段从 `view.config`（凭据值是哨兵）取 */
export function formFromView(view: McpServerView): McpServerFormState {
	const config = view.config;
	const seeded: McpServerFormState = {
		...EMPTY_MCP_FORM,
		name: view.name,
		transport: view.transport,
		disabled: view.disabled,
		lazy: view.percho.lazy,
		directTools: view.percho.directTools,
		idleTimeoutMsText: String(view.percho.idleTimeoutMs),
		excludeText: view.percho.exclude.join("\n"),
		askText: view.percho.ask.join("\n"),
	};
	// 用「有没有 url」判别传输族（与后端同一套收窄方式）：`type` 在 stdio 上可缺省，
	// 靠 `type !== "http" && type !== "sse"` 的排除法在 TS 里收不窄联合类型
	if (!("url" in config)) {
		return {
			...seeded,
			command: config.command,
			argsText: (config.args ?? []).join("\n"),
			envText: formatKeyValueLines(config.env),
			cwd: config.cwd ?? "",
			// 缺省 true：只有显式 false 才是关闭
			inheritEnv: config.inheritEnv !== false,
		};
	}
	return {
		...seeded,
		url: config.url,
		headersText: formatKeyValueLines(config.headers),
		authKind: config.auth?.kind ?? "none",
		caFile: config.tls?.caFile ?? "",
		rejectUnauthorized: config.tls?.rejectUnauthorized !== false,
	};
}

/** 首个校验失败项（null = 可提交）；只返回错误码，文案在组件侧查 i18n */
export function formError(form: McpServerFormState): McpFormError | null {
	const name = form.name.trim();
	if (!name) return "nameRequired";
	if (!NAME_RE.test(name)) return "nameInvalid";
	if (form.transport === "stdio") {
		if (!form.command.trim()) return "commandRequired";
		if (keyValueLines(form.envText).invalid.length > 0) return "keyValueInvalid";
	} else {
		const url = form.url.trim();
		if (!url) return "urlRequired";
		// 只允许 http(s)：sse/http 传输都要走 HTTP 栈，其它协议（ws/file）后端会直接拒
		if (!/^https?:\/\//i.test(url)) return "urlScheme";
		if (keyValueLines(form.headersText).invalid.length > 0) return "keyValueInvalid";
	}
	const idle = form.idleTimeoutMsText.trim();
	if (idle && !IDLE_RE.test(idle)) return "idleTimeoutInvalid";
	return null;
}

/** percho 子键：显式下发归一化后的值（留空的数值字段不下发，交给后端默认） */
function toPerchoConfig(form: McpServerFormState): McpPerchoConfig {
	const idle = form.idleTimeoutMsText.trim();
	const exclude = parseLineList(form.excludeText);
	const ask = parseLineList(form.askText);
	return {
		lazy: form.lazy,
		directTools: form.directTools,
		...(idle ? { idleTimeoutMs: Number(idle) } : {}),
		...(exclude.length || ask.length
			? { tools: { ...(exclude.length ? { exclude } : {}), ...(ask.length ? { ask } : {}) } }
			: {}),
	};
}

/**
 * 表单 → 配置（调用前必须已通过 formError 校验，非法输入会产出空 command/url）。
 * env/headers **整份下发**：空对象 = 清空全部键，`KEY=***` 条目 = 后端保留原值
 * （省略该字段的语义由后端决定，不能依赖它表达「不动」）。其余可选字段空即省略 = 用后端默认。
 */
export function formToConfig(form: McpServerFormState): McpServerConfig {
	const percho = toPerchoConfig(form);
	const disabled = form.disabled ? { disabled: true as const } : {};
	if (form.transport === "stdio") {
		const cwd = form.cwd.trim();
		return {
			type: "stdio",
			command: form.command.trim(),
			args: parseArgLines(form.argsText),
			env: keyValueLines(form.envText).entries,
			...(cwd ? { cwd } : {}),
			// 默认 true：只在用户关掉时下发，避免把用户配置文件里的 inheritEnv 语义改成显式 true
			...(form.inheritEnv ? {} : { inheritEnv: false }),
			...disabled,
			percho,
		};
	}
	const caFile = form.caFile.trim();
	// TLS 整块是可选的：只有填了 CA 或关掉校验（偏离默认）才下发，避免写出一堆无意义默认值
	const tls =
		caFile || !form.rejectUnauthorized
			? { ...(caFile ? { caFile } : {}), rejectUnauthorized: form.rejectUnauthorized }
			: null;
	return {
		type: form.transport,
		url: form.url.trim(),
		headers: keyValueLines(form.headersText).entries,
		auth: { kind: form.authKind },
		...(tls ? { tls } : {}),
		...disabled,
		percho,
	};
}
