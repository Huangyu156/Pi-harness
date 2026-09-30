/**
 * Streamable HTTP 传输绑定（规范 specification/2026-07-28/basic/transports/streamable-http）。
 *
 * 帧层要点（每条都对应一个真实踩过的坑）：
 * - 每个请求/通知一条独立 POST；响应可能是 `application/json`，也可能是 `text/event-stream`。
 * - **SSE 流不因「收到带 id 的响应」而中止**：`subscriptions/listen` 的响应是「先 ack、之后长期推通知」，
 *   读到一条响应就 break 会把订阅流掐断。所以读循环只以「流结束 / abort」为终止条件。
 * - **非 2xx 不抛**：现代服务器拒绝协议版本时回 `400` + JSON-RPC error（无此方法回 `404` + -32601），
 *   世代探测的判定输入就是「400 的 body 里有没有可识别的错误」，所以 body 必须原样投递给 client。
 *   只有 body 根本不是 JSON-RPC 时才走传输错误通道。
 * - 错误一律带 requestId：client 据此只结算出错的那一条请求，不误杀整条连接（见 client.handleTransportError）。
 * - 每个失败只走一条结算通道（请求 → onError；通知 → reject）：同一条失败报两次会让 client 把
 *   已经结算的 pending 再拒一次，产生悬空 rejection。
 */

import { createLogger } from "../../log";
import type { McpHttpResponse } from "../http";
import { mcpHttpRequest, parseSseStream } from "../http";
import { asRecord } from "../json";
import {
	isNotification,
	isRequest,
	type JsonRpcId,
	type JsonRpcMessage,
	type McpTransport,
	McpTransportError,
	type McpTransportOptions,
	type ServerMessage,
	type TransportDelivery,
} from "../transport";

const log = createLogger("mcp-streamable-http");

/** 建连 + 首字节超时；60s 是常见实现的取值（规范未规定）。注意 http.ts 的定时器挂在 socket 上，
 * 长活 SSE 流靠服务器按规范发 keep-alive 注释帧续命，不能靠这里放宽。 */
const REQUEST_TIMEOUT_MS = 60_000;

/** 非 2xx 的 body 进错误对象时截断：错误消息要能读，不要把整页 HTML 塞进日志 */
const ERROR_BODY_LIMIT = 2_000;

/**
 * 带 `mcp-name` 头的方法 → 从 params 取值的键（规范只定义这三个方法带具名目标）。
 * 用 Record 而不是 Set：这是「方法 → 取值键」的静态查表。
 */
const NAME_PARAM_KEY: Record<string, "name" | "uri"> = {
	"tools/call": "name",
	"resources/read": "uri",
	"prompts/get": "name",
};

/** 把 requestId 补进错误（McpTransportError 字段只读，只能重建一个：client 靠它只结算单条请求） */
function withRequestId(error: McpTransportError, requestId: JsonRpcId | undefined): McpTransportError {
	if (requestId === undefined || error.requestId !== undefined) return error;
	return new McpTransportError(error.message, {
		failure: error.failure,
		status: error.status,
		body: error.body,
		requestId,
		cause: error,
	});
}

/** 响应头取值（HTTP 头大小写不敏感；同名多值取首个） */
function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (Array.isArray(value)) return value[0] ?? null;
		return value ?? null;
	}
	return null;
}

/** body 文本 → JSON-RPC 消息；形状不对返回 null（调用方决定是投递、记日志还是报传输错误） */
function parseJsonRpcPayload(text: string): JsonRpcMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const record = asRecord(parsed);
	if (record === null || record.jsonrpc !== "2.0") return null;
	if (typeof record.method === "string") return parsed as JsonRpcMessage;
	if ("id" in record && ("result" in record || "error" in record)) return parsed as JsonRpcMessage;
	return null;
}

export function createStreamableHttpTransport(
	options: Extract<McpTransportOptions, { kind: "streamable-http" }>,
): McpTransport {
	const messageHandlers = new Set<(delivery: TransportDelivery) => void>();
	const errorHandlers = new Set<(error: McpTransportError) => void>();
	const logHandlers = new Set<(line: string) => void>();
	/** 在途请求：id → 该请求响应流的 abort 控制器（cancel 靠它关流，规范：关流即取消） */
	const inflight = new Map<JsonRpcId, AbortController>();
	/** 在途通知没有 id 可索引，单独存：close 时要一并 abort */
	const inflightNotifications = new Set<AbortController>();

	let protocolVersion: string | null = null;
	let authHeaders: Record<string, string> = {};
	let sessionIdValue: string | null = null;
	let started = false;
	let closed = false;

	const emitMessage = (delivery: TransportDelivery): void => {
		if (closed) return;
		for (const handler of [...messageHandlers]) handler(delivery);
	};
	const emitError = (error: McpTransportError): void => {
		if (closed) return;
		for (const handler of [...errorHandlers]) handler(error);
	};
	const emitLog = (line: string): void => {
		if (closed) return;
		for (const handler of [...logHandlers]) handler(line);
	};

	/**
	 * 投递一条线上消息；带 httpStatus 与本次 POST 的归属请求 id。
	 * 归属 id 必须由传输给出：服务器在错误响应里可能回 `id: null` 或自造的字符串 id
	 * （实测 deepwiki 回 `"id":"server-error"`、gitmcp 回 `id:null`），只靠 body 里的 id 关联
	 * 会让请求悬空到 60s 超时。
	 */
	const deliver = (message: JsonRpcMessage, httpStatus?: number, requestId?: JsonRpcId): void => {
		// 服务端反向请求（带 id 的 method）也照样投递：client 明确要拒绝这类消息（rejectServerRequest），
		// 只是 ServerMessage 类型描述的是常态方向，这里按协议事实原样交出。
		emitMessage({
			message: message as ServerMessage,
			...(httpStatus === undefined ? {} : { httpStatus }),
			...(requestId === undefined ? {} : { requestId }),
		});
	};

	/**
	 * 请求失败时的结算通道选择：
	 * - 请求（有 id）→ onError 带 requestId，client 只拒这一条；
	 * - 通知（无 id）→ 只能 reject 给调用方；若走 onError，client 会把它当整条连接的致命错误。
	 */
	const settleFailure = (error: McpTransportError, requestId: JsonRpcId | undefined): void => {
		if (requestId !== undefined) {
			emitError(error);
			return;
		}
		throw error;
	};

	/** 只记「首次出现」的 Mcp-Session-Id（legacy 用它做会话标识；modern 不回这个头，自然保持 null） */
	const captureSessionId = (headers: Record<string, string | string[] | undefined>): void => {
		if (sessionIdValue !== null) return;
		const value = readHeader(headers, "mcp-session-id");
		if (value === null || value === "") return;
		sessionIdValue = value;
		// 只记「拿到了」不记值：会话 id 是凭据级的，不进日志
		log.debug("captured MCP session id", { url: options.url });
	};

	/** 逐事件读 SSE：注释帧由 parseSseStream 丢弃，这里只处理 data；读到响应也不 break（见文件头） */
	const readEventStream = async (response: McpHttpResponse, requestId?: JsonRpcId): Promise<void> => {
		for await (const event of parseSseStream(response.stream)) {
			const payload = event.data.trim();
			if (payload === "") continue;
			const parsed = parseJsonRpcPayload(payload);
			if (parsed === null) {
				// 服务器自定义事件（非 JSON-RPC）不是畸形输入：记日志，不中断流
				log.warn("ignoring non JSON-RPC SSE event", {
					url: options.url,
					event: event.event ?? "",
					data: payload.slice(0, 200),
				});
				emitLog(`[sse] ${payload.slice(0, ERROR_BODY_LIMIT)}`);
				continue;
			}
			deliver(parsed, response.status, requestId);
		}
	};

	/**
	 * 消费一次 POST 的响应。失败一律 throw McpTransportError，由 send 的 catch 统一结算。
	 * 状态码语义：202 = 通知已被接受（不投递任何消息）；2xx 按 content-type 分流；非 2xx 先当 JSON-RPC 试。
	 */
	const consume = async (response: McpHttpResponse, requestId?: JsonRpcId): Promise<void> => {
		const contentType = readHeader(response.headers, "content-type") ?? "";
		if (response.status === 202) {
			log.debug("accepted without body (202)", { url: options.url });
			return;
		}
		if (response.status >= 200 && response.status < 300 && contentType.includes("text/event-stream")) {
			await readEventStream(response, requestId);
			return;
		}
		const text = await response.text();
		const parsed = text.trim() === "" ? null : parseJsonRpcPayload(text);
		if (parsed !== null) {
			deliver(parsed, response.status, requestId);
			return;
		}
		if (text.trim() === "" && response.status >= 200 && response.status < 300) return; // 204/空 body 的 2xx
		throw new McpTransportError(`MCP server responded with HTTP ${response.status} and a non JSON-RPC body`, {
			failure: response.status >= 200 && response.status < 300 ? "parse" : "http",
			status: response.status,
			body: text.slice(0, ERROR_BODY_LIMIT),
		});
	};

	/** 每个 POST 的请求头：协议头固定，配置头与动态认证头覆盖（OAuth token 会刷新，必须能盖掉静态值） */
	const buildHeaders = (message: JsonRpcMessage): Record<string, string> => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		// 客户端 → 服务器的响应（拒绝服务端请求）没有 method，规范也只要求请求/通知带这两个头
		if (isRequest(message) || isNotification(message)) {
			headers["mcp-method"] = message.method;
			const nameKey = NAME_PARAM_KEY[message.method];
			const nameValue = nameKey === undefined ? undefined : asRecord(message.params)?.[nameKey];
			if (typeof nameValue === "string" && nameValue !== "") headers["mcp-name"] = nameValue;
		}
		// 版本头只在自己已知版本时发（规范：握手前可以不带，服务器据此判定 legacy 客户端）
		if (protocolVersion !== null) headers["mcp-protocol-version"] = protocolVersion;
		if (sessionIdValue !== null) headers["mcp-session-id"] = sessionIdValue;
		return { ...headers, ...options.headers, ...authHeaders };
	};

	return {
		kind: "streamable-http",

		async start(): Promise<void> {
			if (closed) throw new Error("MCP streamable HTTP transport is closed");
			// Streamable HTTP 无握手、也无 GET 端点（2026-07-28 已删除 GET），可达性只能靠第一条消息试；
			// start 这里只做 URL 校验，绝不为「探活」多发一条协议消息。
			const target = new URL(options.url);
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error(`Unsupported MCP server URL protocol: ${target.protocol}`);
			}
			started = true;
		},

		async send(message: JsonRpcMessage): Promise<void> {
			if (closed) throw new Error("MCP streamable HTTP transport is closed");
			if (!started) throw new Error("MCP streamable HTTP transport is not started");
			// 只有「请求」才按 id 归属：客户端→服务器的响应（拒绝服务端请求）带的是**服务端**的 id，
			// 与 client.pending 的 id 空间不同，绝不能拿它去命中 onError 的 requestId 分支。
			const requestId = isRequest(message) ? message.id : undefined;
			const controller = new AbortController();
			if (requestId === undefined) inflightNotifications.add(controller);
			else inflight.set(requestId, controller);
			try {
				const response = await mcpHttpRequest({
					url: options.url,
					method: "POST",
					headers: buildHeaders(message),
					body: JSON.stringify(message),
					tls: options.tls,
					signal: controller.signal,
					timeoutMs: REQUEST_TIMEOUT_MS,
				});
				captureSessionId(response.headers);
				await consume(response, requestId);
			} catch (err) {
				if (controller.signal.aborted) {
					// cancel()/close() 主动关流：client 已经自己结算了那条请求，这里不重复报错
					log.debug("request aborted", { url: options.url, requestId: String(requestId ?? "") });
					return;
				}
				// socket 层/证书/TLS 失败 → "stream"；已有状态码的 body 解析失败保持原样（"http"/"parse"）
				const failure =
					err instanceof McpTransportError
						? err
						: new McpTransportError(`MCP request failed: ${(err as Error).message}`, {
								failure: "stream",
								cause: err,
							});
				if (failure.failure !== "http" && failure.failure !== "parse") {
					log.warn("streamable HTTP request failed", { url: options.url, message: failure.message });
				}
				settleFailure(withRequestId(failure, requestId), requestId);
			} finally {
				// 一次请求结束就出表：否则同一条 id 复用时会 cancel 到已经结束的请求（泄漏 + 误取消）
				if (requestId === undefined) inflightNotifications.delete(controller);
				else inflight.delete(requestId);
			}
		},

		async cancel(id: JsonRpcId): Promise<void> {
			const controller = inflight.get(id);
			if (controller === undefined) return; // 未知 id（已结束/从未发出）：静默
			controller.abort();
		},

		onMessage(handler: (delivery: TransportDelivery) => void): () => void {
			messageHandlers.add(handler);
			return () => messageHandlers.delete(handler);
		},

		onError(handler: (error: McpTransportError) => void): () => void {
			errorHandlers.add(handler);
			return () => errorHandlers.delete(handler);
		},

		onLog(handler: (line: string) => void): () => void {
			logHandlers.add(handler);
			return () => logHandlers.delete(handler);
		},

		setProtocolVersion(version: string): void {
			protocolVersion = version;
		},

		setAuthHeaders(headers: Record<string, string>): void {
			authHeaders = { ...headers };
		},

		sessionId(): string | null {
			return sessionIdValue;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			for (const controller of [...inflight.values()]) controller.abort();
			for (const controller of [...inflightNotifications]) controller.abort();
			inflight.clear();
			inflightNotifications.clear();
			// close 之后不允许再有投递（在途响应流的收尾回调也会看到 closed 直接返回）
			messageHandlers.clear();
			errorHandlers.clear();
			logHandlers.clear();
		},
	};
}
