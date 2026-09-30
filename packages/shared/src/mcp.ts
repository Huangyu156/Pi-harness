/**
 * MCP（Model Context Protocol）域跨进程类型。
 *
 * 安全约定（硬性）：任何下发到 renderer 的结构都不含凭据——`env` / `headers` 只以键名形式出现
 * （McpServerView.secretKeys），OAuth token 只以 hasOAuthToken 布尔暴露。凭据读取只发生在 backend。
 *
 * 合规依据：MCP 规范 2026-07-28（modern）与 ≤2025-11-25（legacy）两个世代并存，见 basic/versioning。
 */

import type { LoginAuthEvent, LoginAuthPrompt } from "./settings";

/** 传输绑定种类（配置 type 字段）：stdio = 子进程；http = Streamable HTTP；sse = 已弃用的 HTTP+SSE */
export type McpTransportKind = "stdio" | "http" | "sse";

/** 协议世代：modern = ≥2026-07-28（无握手、每请求 _meta）；legacy = ≤2025-11-25（initialize 握手） */
export type McpEra = "modern" | "legacy";

/** Percho 专有扩展字段（收在同一子键下，避免与 MCP 通用字段/未来 Pi 内置 MCP 冲突） */
export interface McpPerchoConfig {
	/** 懒连接：不使用不拉起（stdio 默认 true，http 无意义但保留一致性） */
	lazy?: boolean;
	/** 逐工具直投：把远端工具注册为 mcp__<server>__<tool>，默认 false（走 mcp 代理工具省 context） */
	directTools?: boolean;
	/** 空闲断开（ms；0 = 不断开） */
	idleTimeoutMs?: number;
	tools?: {
		/** 不注册的远端工具名（通配） */
		exclude?: string[];
		/** 强制走确认的远端工具名（通配；为空则按全局 mcp 规则） */
		ask?: string[];
	};
}

/** stdio 服务器配置（MCP 通用字段 + percho 子键） */
export interface McpStdioServerConfig {
	type?: "stdio";
	command: string;
	args?: string[];
	/** 追加环境变量；值支持 ${env:NAME} 引用宿主环境 */
	env?: Record<string, string>;
	/** 工作目录；支持 ~ / ~\ 前缀展开 */
	cwd?: string;
	/** 是否继承宿主环境（默认 true）；false 时只带 env 与最小必要变量 */
	inheritEnv?: boolean;
	disabled?: boolean;
	percho?: McpPerchoConfig;
}

/** HTTP 族服务器配置（Streamable HTTP 与已弃用的 HTTP+SSE 共用形状） */
export interface McpHttpServerConfig {
	type: "http" | "sse";
	url: string;
	/** 自定义请求头；值支持 ${env:NAME} 引用宿主环境 */
	headers?: Record<string, string>;
	/** 认证方式：header = 靠 headers 里的静态凭据；oauth = 走 OAuth 2.1 流程 */
	auth?: { kind: "none" | "header" | "oauth" };
	/** TLS 选项（企业自签 CA） */
	tls?: { caFile?: string; rejectUnauthorized?: boolean };
	disabled?: boolean;
	percho?: McpPerchoConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** 归一化后的 percho 配置（下发给 UI 的形态，全字段必填） */
export interface McpPerchoConfigResolved {
	lazy: boolean;
	directTools: boolean;
	idleTimeoutMs: number;
	exclude: string[];
	ask: string[];
}

/** 连接状态（UI 徽标数据源） */
export type McpConnectionState = "disabled" | "idle" | "connecting" | "ready" | "error";

/** 配置来源层级（user = <agentDir>/mcp.json；project = <cwd>/.pi/mcp.json） */
export type McpConfigSource = "user" | "project";

/**
 * 凭据掩码：`McpServerView.config` 里 env/headers 的**值**一律是它。
 * 写入时原样回传该哨兵 = 保持磁盘上的原值（键名保留、值不下发的唯一出路）。
 */
export const MCP_SECRET_MASK = "***";

/** 单个服务器的 UI 视图（凭据已脱敏） */
export interface McpServerView {
	name: string;
	transport: McpTransportKind;
	/** 一行摘要：stdio = command + args 首项；http/sse = URL 的 origin + path */
	summary: string;
	/**
	 * 脱敏后的配置快照（编辑表单回填**全部**字段用）：env/headers 的值一律为 MCP_SECRET_MASK
	 * （键名保留），其余字段（command/args/cwd/inheritEnv/url/auth/tls/disabled/percho）都是真值。
	 */
	config: McpServerConfig;
	disabled: boolean;
	percho: McpPerchoConfigResolved;
	/** env / headers 的键名（值永不下发） */
	secretKeys: string[];
	authKind: "none" | "header" | "oauth";
	state: McpConnectionState;
	/** 世代探测结果（未连接过为 null） */
	era: McpEra | null;
	protocolVersion: string | null;
	serverInfo: McpServerInfo | null;
	/** 已缓存工具数（未连接过为 null） */
	toolCount: number | null;
	lastError: string | null;
	source: McpConfigSource;
	/** 是否已存有 OAuth token（值不下发） */
	hasOAuthToken: boolean;
}

export interface McpServerInfo {
	name: string;
	version: string;
	title?: string;
}

/** 远端工具元信息（抽屉工具列表 + 代理工具搜索共用） */
export interface McpToolInfo {
	server: string;
	name: string;
	title?: string;
	description?: string;
	/** JSON Schema（原样透传；模型侧按需注入） */
	inputSchema?: unknown;
}

/** 远端资源元信息 */
export interface McpResourceInfo {
	server: string;
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

/** 远端提示（prompt）元信息 */
export interface McpPromptInfo {
	server: string;
	name: string;
	title?: string;
	description?: string;
	arguments?: unknown;
}

/** 内容块（规范 server/resources 的 content 形状；未知类型原样保留 type 字段） */
export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource_link"; uri: string; name?: string; mimeType?: string }
	| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
	| { type: string; [key: string]: unknown };

/** 工具调用结果（规范 tools/call 的 result 投影） */
export interface McpCallResult {
	isError: boolean;
	content: McpContentBlock[];
	/** 结构化输出（tools/call 的 structuredContent，modern 规范允许任意 JSON） */
	structured?: unknown;
	/** 服务器索要的额外输入（MRTR）；非空时调用方补齐后必须重放原请求 */
	inputRequests?: McpInputRequest[];
	/** MRTR 的不透明状态：必须原样回传，客户端不得解析/修改（规范硬要求） */
	requestState?: string;
}

/**
 * MRTR 输入请求（规范 patterns/mrtr 的 InputRequests **映射表**的一项）。
 * 注意是映射而非数组：key 是服务器分配的标识，重试时作为 inputResponses 的同名键。
 */
export interface McpInputRequest {
	/** 服务器分配的键（InputRequests map key） */
	id: string;
	/** 请求方法：elicitation/create | sampling/createMessage | roots/list */
	method: string;
	/** 请求参数（elicitation 的 message/requestedSchema 等） */
	params: Record<string, unknown>;
}

/** 连接自检结果（抽屉「测试连接」按钮） */
export interface McpTestResult {
	ok: boolean;
	era: McpEra | null;
	protocolVersion: string | null;
	serverInfo: McpServerInfo | null;
	toolCount: number;
	resourceCount: number;
	promptCount: number;
	/** 人类可读的能力名清单（tools/resources/prompts/…） */
	capabilities: string[];
	durationMs: number;
	/** 失败原因（ok=false 时非空） */
	error: string | null;
	/** stderr / HTTP 诊断尾部若干行 */
	logs: string[];
}

/** 日志分页读取（cursor 为单调递增行号） */
export interface McpLogPage {
	lines: string[];
	cursor: number;
}

/** 宿主配置来源（全平台导入向导） */
export type McpHostName =
	| "shared"
	| "claude-desktop"
	| "claude-code"
	| "cursor"
	| "vscode"
	| "cline"
	| "windsurf"
	| "codex"
	| "adapter";

/** 一个宿主配置文件里发现的一个服务器 */
export interface McpImportServer {
	name: string;
	config: McpServerConfig;
	/** 一行摘要（预览用） */
	summary: string;
	/** 与当前 Percho 配置同名（导入时会覆盖） */
	conflict: boolean;
}

/** 宿主配置扫描结果（按文件聚合；path 不存在时该宿主不出现在结果里） */
export interface McpImportCandidate {
	host: McpHostName;
	path: string;
	servers: McpImportServer[];
}

/** 导入选择（host + path + 服务器名） */
export interface McpImportPick {
	host: McpHostName;
	path: string;
	names: string[];
}

/** OAuth 流程事件（复用 settings 域登录提示形状，renderer 侧可共用输入组件） */
export type McpAuthEventPayload = { flowId: string } & (
	| { kind: "event"; event: LoginAuthEvent }
	| { kind: "prompt"; promptId: string; prompt: LoginAuthPrompt }
	| { kind: "prompt-cancel"; promptId: string }
);

/** OAuth 流程最终结果（取消不算错误） */
export interface McpAuthResult {
	ok: boolean;
	cancelled: boolean;
	error: string | null;
}

/** main → renderer 单向事件（MCP_EVENT 通道载荷） */
export type McpEventPayload =
	| { kind: "status"; server: McpServerView }
	| { kind: "log"; server: string; line: string }
	| { kind: "auth"; payload: McpAuthEventPayload }
	/** 配置层提示（mcp.json 里被跳过的非法条目、导入扫描失败）；renderer 就地面板提示，不静默 */
	| { kind: "notice"; level: "warn" | "error"; message: string }
	/** 配置发生变化（增删改/导入/启停），renderer 需重取列表 */
	| { kind: "changed" };
