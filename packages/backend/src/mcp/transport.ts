/**
 * MCP 传输层契约：stdio / Streamable HTTP / HTTP+SSE 三个绑定共用的最小面。
 *
 * 设计要点（对齐 2026-07-28 规范 basic/transports）：
 * - 传输只负责「帧」：消息投递、绑定层请求元数据（HTTP 头）、取消、终止。协议语义（世代、
 *   capabilities、resultType）全在 client.ts，传输不解析。
 * - 取消是绑定自己的事：stdio 由 client 发 notifications/cancelled；HTTP 关闭该请求的响应流
 *   （规范：关闭流即取消，服务端不得再为该请求发任何消息）。故 cancel 由传输实现。
 * - 每请求一个响应（HTTP）与共享双向流（stdio）的差异全部吸收在实现里，client 只看见 onMessage。
 */

/** JSON-RPC 请求 id（规范：字符串或整数，禁止 null） */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcErrorShape {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResultResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	/** 请求体不可解析时规范允许缺 id */
	id?: JsonRpcId;
	error: JsonRpcErrorShape;
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

/** 双向线上的任意一条消息 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 服务器 → 客户端方向的消息（传输只会把这两类交给 onMessage） */
export type ServerMessage = JsonRpcNotification | JsonRpcResponse;

/**
 * 一次投递：消息本体 + 绑定层元数据。
 * HTTP 系必须带上 httpStatus —— 世代探测的判定输入是「400 的 body 里有没有可识别的 modern 错误」，
 * 只拿到 JSON-RPC error 无法区分「modern 服务器拒绝版本」与「legacy 服务器不认这个方法」。
 */
export interface TransportDelivery {
	message: ServerMessage;
	httpStatus?: number;
	/**
	 * 绑定层认定的归属请求 id（HTTP 系填：它知道自己这次 POST 发的是哪条请求）。
	 * client 关联响应时优先用它——真服务器在 400 上会回 `id: null` 或自己造的字符串 id
	 * （实测 deepwiki 回 `"id":"server-error"`、gitmcp 回 `id:null`），只认 body 里的 id
	 * 会把这类响应丢进「未知 id」分支，请求一直挂到 60s 超时。
	 */
	requestId?: JsonRpcId;
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return !("method" in message);
}

/** 传输绑定种类（配置里的 type 字段；stdio / http = Streamable HTTP / sse = 已弃用的 HTTP+SSE） */
export type McpTransportKind = "stdio" | "streamable-http" | "http-sse";

/** TLS 选项（HTTP 系传输与 OAuth 交换共用；定义在此以避免 transport ↔ http 循环依赖） */
export interface McpTlsOptions {
	/** PEM 文件路径（支持 ~ 前缀）；内容读入后作为 `ca` 传给 https */
	caFile?: string;
	/** false = 跳过证书校验（自签环境的逃生舱；默认 true） */
	rejectUnauthorized?: boolean;
}

/**
 * 传输构造参数：已完成 `${env:NAME}` 引用展开与 `~` 路径展开（展开是 config.ts 的职责，
 * 传输只消费结果——这样传输可脱离配置文件单独测试）。
 */
export type McpTransportOptions =
	| {
			kind: "stdio";
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
			/** false = 不继承宿主环境，只带最小必要变量 + env */
			inheritEnv: boolean;
	  }
	| {
			kind: "streamable-http";
			url: string;
			headers: Record<string, string>;
			tls?: McpTlsOptions;
	  }
	| {
			kind: "http-sse";
			url: string;
			headers: Record<string, string>;
			tls?: McpTlsOptions;
	  };

/** 传输层失败类别：http = 有状态码可判世代；process = 子进程退出；stream = 流中断；parse = 线上数据不合法 */
export type McpTransportFailure = "http" | "process" | "stream" | "parse";

/**
 * 传输层错误。HTTP 系带 status + 解析后的 body —— 世代判定依赖它：
 * 规范要求 modern 客户端「先发一个 modern 请求，400 时读 body 再决定是否回退 initialize」，
 * 所以 body 必须原样带上，不能被压成一句话。
 */
export class McpTransportError extends Error {
	readonly status: number | undefined;
	readonly body: unknown;
	readonly failure: McpTransportFailure;
	/**
	 * 归属的 JSON-RPC 请求 id（HTTP 系在单个请求失败时填；进程退出/流中断这类整体故障留空）。
	 * 客户端据此把「某个请求 401 / 400」与「整条连接死了」区分开，避免误杀健康连接。
	 */
	readonly requestId: JsonRpcId | undefined;

	constructor(
		message: string,
		options: {
			failure: McpTransportFailure;
			status?: number;
			body?: unknown;
			requestId?: JsonRpcId;
			cause?: unknown;
		},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "McpTransportError";
		this.failure = options.failure;
		this.status = options.status;
		this.body = options.body;
		this.requestId = options.requestId;
	}
}

/**
 * 传输绑定。实现见 transports/ 三个文件；生命周期由 client 驱动（start → send/cancel → close）。
 * 所有订阅返回退订函数；close 幂等且必须解除全部订阅者的后续投递。
 */
export interface McpTransport {
	readonly kind: McpTransportKind;

	/** 建立连接：stdio = spawn 子进程并挂好管道；http/sse = 校验 endpoint 可达（不发协议消息） */
	start(): Promise<void>;

	/**
	 * 发送一条消息。请求的响应不在此返回（经 onMessage 投递），HTTP 侧会在响应流结束时自然收尾。
	 * 发送失败必须 reject（调用方据此判定连接状态），而不是只发 onError。
	 */
	send(message: JsonRpcMessage): Promise<void>;

	/** 取消在途请求（未知 id 静默忽略）：stdio 发 notifications/cancelled；HTTP 关流 */
	cancel(id: JsonRpcId): Promise<void>;

	onMessage(handler: (delivery: TransportDelivery) => void): () => void;

	/**
	 * 传输层致命错误（子进程退出、流中断、线上数据不合法）。传输不自行重连——
	 * 重连策略在 registry.ts，避免两处各有一套退避。
	 */
	onError(handler: (error: McpTransportError) => void): () => void;

	/** 结构化旁路日志（stdio 的 stderr、HTTP 的状态码与重试），供设置页日志面板展示 */
	onLog(handler: (line: string) => void): () => void;

	/** 当前协议版本（HTTP 传输据此发 MCP-Protocol-Version 头；stdio 忽略）。旧版本头缺失有向后兼容语义 */
	setProtocolVersion(version: string): void;

	/**
	 * 覆盖动态认证头（HTTP 传输合并进每次请求；stdio 无意义、实现为 no-op）。
	 * 由 client 在每次请求前用最新凭据调用（OAuth token 会刷新，不能在构造期固定）。
	 */
	setAuthHeaders(headers: Record<string, string>): void;

	/** 绑定层会话标识（legacy Streamable HTTP 的 Mcp-Session-Id / HTTP+SSE 的 endpoint），诊断展示用 */
	sessionId(): string | null;

	/** 主动关闭并释放（幂等；stdio 需杀进程树） */
	close(): Promise<void>;
}
