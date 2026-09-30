/**
 * HTTP+SSE 传输绑定（2024-11-05 已弃用的 basic/transports/http-sse）。
 *
 * 形态与 Streamable HTTP 完全不同，不要混：
 * - 顶端的 GET 是**下行信道**：第一个 `event: endpoint` 给出上行消息端点（带 sessionId query），
 *   之后这条流只承载 `event: message`（JSON-RPC 消息）与 `event: ping`（忽略）。
 * - POST 只走上行：规范约定响应是 `202`，服务器把真正的响应推回 GET 流。
 * - **这个绑定没有取消信号**（规范原文如此）：cancel() 只能尽力发一条 notifications/cancelled。
 *
 * start() 必须等到 endpoint 事件才算就绪（否则 send 不知道该 POST 到哪）；等不到就是启动失败。
 * 实现上手工持有 SSE 迭代器：`start()` 只消费到 endpoint 事件，之后同一条流交给后台继续泵，
 * 这样既能「等就绪」又不需要手搓 promise 执行器（本仓 lib 是 ES2023，没有 `Promise.withResolvers`）。
 */

import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../../log";
import type { McpHttpResponse, SseEvent } from "../http";
import { mcpHttpRequest, parseSseStream } from "../http";
import { asRecord } from "../json";
import {
	isRequest,
	type JsonRpcId,
	type JsonRpcMessage,
	type McpTransport,
	McpTransportError,
	type McpTransportOptions,
	type ServerMessage,
	type TransportDelivery,
} from "../transport";

const log = createLogger("mcp-http-sse");

/** 等 endpoint 事件的超时：规范设想的时序是一个往返内就该到，15s 已很宽松 */
const ENDPOINT_TIMEOUT_MS = 15_000;

/** GET/POST 的建连 + 首字节超时 */
const REQUEST_TIMEOUT_MS = 60_000;

/** 非 2xx 的 body 进错误对象时截断 */
const ERROR_BODY_LIMIT = 2_000;

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

/** 把 requestId 补进错误（字段只读，只能重建：client 靠它只结算单条请求） */
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

/** 把任意异常归一到传输错误（网络层/证书失败都算 stream 级） */
function toTransportError(err: unknown, context: string): McpTransportError {
	if (err instanceof McpTransportError) return err;
	return new McpTransportError(`${context}: ${(err as Error).message}`, { failure: "stream", cause: err });
}

export function createHttpSseTransport(
	options: Extract<McpTransportOptions, { kind: "http-sse" }>,
): McpTransport {
	const messageHandlers = new Set<(delivery: TransportDelivery) => void>();
	const errorHandlers = new Set<(error: McpTransportError) => void>();
	const logHandlers = new Set<(line: string) => void>();
	/** 在途 POST：close 时要一并 abort */
	const inflightPosts = new Set<AbortController>();

	let channelAbort: AbortController | null = null;
	/** 上行消息端点（由 GET 流的 endpoint 事件给出；相对路径已按 options.url 解析） */
	let messageEndpoint: string | null = null;
	let sessionIdValue: string | null = null;
	let authHeaders: Record<string, string> = {};
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

	/** 投递一条线上消息；HTTP+SSE 没有「响应状态码即消息元数据」的语义，故不带 httpStatus */
	const deliver = (message: JsonRpcMessage): void => {
		// 服务端反向请求也会投递：client 要拒绝这类消息（rejectServerRequest），见 client.ts
		emitMessage({ message: message as ServerMessage });
	};

	/** 失败通道：请求（有 id）→ onError 让 client 只结算这一条；通知 → reject 给调用方 */
	const settleFailure = (error: McpTransportError, requestId: JsonRpcId | undefined): void => {
		if (requestId !== undefined) {
			emitError(error);
			return;
		}
		throw error;
	};

	const buildHeaders = (extra: Record<string, string>): Record<string, string> => ({
		...extra,
		...options.headers,
		...authHeaders,
	});

	/** `event: message` 的载荷 → 投递；形状不对只记日志（非 JSON-RPC 事件不该拖垮整条连接） */
	const handleMessageEvent = (event: SseEvent): void => {
		const payload = event.data.trim();
		if (payload === "") return;
		const parsed = parseJsonRpcPayload(payload);
		if (parsed === null) {
			log.warn("ignoring non JSON-RPC message event", { url: options.url, data: payload.slice(0, 200) });
			emitLog(`[sse] ${payload.slice(0, ERROR_BODY_LIMIT)}`);
			return;
		}
		deliver(parsed);
	};

	/**
	 * 打开下行信道并读到第一个 endpoint 事件：
	 * 返回同一条流的迭代器（已消费到 endpoint 之后），由调用方接着泵 message 事件。
	 */
	const openChannel = async (
		controller: AbortController,
	): Promise<{ endpoint: URL; events: AsyncIterator<SseEvent> }> => {
		const response = await mcpHttpRequest({
			url: options.url,
			method: "GET",
			headers: buildHeaders({ accept: "text/event-stream" }),
			tls: options.tls,
			signal: controller.signal,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		if (response.status < 200 || response.status >= 300) {
			const body = await response.text().catch(() => "");
			throw new McpTransportError(`MCP SSE endpoint responded with HTTP ${response.status}`, {
				failure: "http",
				status: response.status,
				body: body.slice(0, ERROR_BODY_LIMIT),
			});
		}
		// 手工持迭代器而不是 for await：for-await 提前 return 会调用迭代器的 return() 关掉生成器，
		// 之后就没法接着泵同一条流了（endpoint 事件之后必须继续读 message 事件）
		const events = parseSseStream(response.stream)[Symbol.asyncIterator]();
		for (;;) {
			const next = await events.next();
			if (next.done === true) {
				throw new McpTransportError("MCP SSE channel closed before the endpoint event", {
					failure: "stream",
				});
			}
			if (next.value.event === "endpoint") {
				// 规范：data 是消息端点的 URI（可能是相对路径），以 options.url 为基准解析
				return { endpoint: new URL(next.value.data.trim(), options.url), events };
			}
			// endpoint 之前就来的 message 事件（规范不允许但服务器可能抢跑）：先投递，别丢
			if (next.value.event === "message") handleMessageEvent(next.value);
		}
	};

	/** 就绪之后的持续泵：流断开即整条连接故障（未 close、未 abort 的前提下） */
	const pumpChannel = async (events: AsyncIterator<SseEvent>, controller: AbortController): Promise<void> => {
		try {
			for (;;) {
				const next = await events.next();
				if (next.done === true) break;
				if (next.value.event === "message") handleMessageEvent(next.value);
				// ping 与其它事件名忽略；注释帧（: keep-alive）已由 parseSseStream 丢弃
			}
			if (closed || controller.signal.aborted) return;
			emitError(new McpTransportError("MCP SSE channel closed by the server", { failure: "stream" }));
		} catch (err) {
			if (closed || controller.signal.aborted) return;
			emitError(toTransportError(err, "MCP SSE channel failed"));
		}
	};

	/** 取到上行端点后才允许 POST；endpoint 为空时给出可读错误而不是打到错的 URL */
	const requireEndpoint = (): string => {
		const endpoint = messageEndpoint;
		if (endpoint === null)
			throw new Error("MCP HTTP+SSE transport is not started: message endpoint is unknown");
		return endpoint;
	};

	/** 上行 POST：规范约定 202（无 body）；若服务器顺手在 body 里回了 JSON-RPC 消息也投递 */
	const postMessage = async (
		endpoint: string,
		message: JsonRpcMessage,
		controller: AbortController,
	): Promise<void> => {
		const response: McpHttpResponse = await mcpHttpRequest({
			url: endpoint,
			method: "POST",
			headers: buildHeaders({ "content-type": "application/json" }),
			body: JSON.stringify(message),
			tls: options.tls,
			signal: controller.signal,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		const text = await response.text();
		if (text.trim() === "") return;
		const parsed = parseJsonRpcPayload(text);
		if (parsed !== null) {
			deliver(parsed);
			return;
		}
		if (response.status >= 200 && response.status < 300) {
			// 2xx 但 body 不是 JSON-RPC：上行已被接受（规范的 202 语义），不视为失败
			log.debug("ignoring non JSON-RPC POST body", { url: options.url, status: response.status });
			return;
		}
		throw new McpTransportError(`MCP message POST responded with HTTP ${response.status}`, {
			failure: "http",
			status: response.status,
			body: text.slice(0, ERROR_BODY_LIMIT),
		});
	};

	return {
		kind: "http-sse",

		async start(): Promise<void> {
			if (closed) throw new Error("MCP HTTP+SSE transport is closed");
			if (started) return; // 幂等：重复 start 不重开信道
			const target = new URL(options.url);
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error(`Unsupported MCP server URL protocol: ${target.protocol}`);
			}
			const controller = new AbortController();
			channelAbort = controller;
			let ready: { endpoint: URL; events: AsyncIterator<SseEvent> } | null = null;
			try {
				// scope 只决定「先拿到 endpoint 还是先超时」；失败/超时都走同一个 reject 出口
				const outcome = await Promise.race([
					openChannel(controller).then((channel) => ({ kind: "ready" as const, channel })),
					delay(ENDPOINT_TIMEOUT_MS, undefined, { ref: false }).then(() => ({ kind: "timeout" as const })),
				]);
				if (outcome.kind === "timeout") {
					throw new McpTransportError(
						`No "endpoint" event received from ${options.url} within ${ENDPOINT_TIMEOUT_MS}ms`,
						{ failure: "stream" },
					);
				}
				ready = outcome.channel;
			} catch (err) {
				// 启动失败：关掉半开的信道，避免 registry 重连时留下僵尸 GET 流
				controller.abort();
				throw toTransportError(err, `MCP SSE channel failed to start (${options.url})`);
			}
			messageEndpoint = ready.endpoint.href;
			// 会话标识：端点 URL 的 sessionId query（规范用它关联同一条 GET 流）
			sessionIdValue = ready.endpoint.searchParams.get("sessionId");
			started = true;
			log.info("HTTP+SSE channel ready", { url: options.url, hasSessionId: sessionIdValue !== null });
			// 信道在 start 之后继续跑：断开即致命故障（见 pumpChannel），这里刻意不 await
			void pumpChannel(ready.events, controller);
		},

		async send(message: JsonRpcMessage): Promise<void> {
			if (closed) throw new Error("MCP HTTP+SSE transport is closed");
			const endpoint = requireEndpoint();
			// 只有「请求」才按 id 归属：客户端→服务器的响应带的是服务端 id 空间的值，不能拿它命中 client.pending
			const requestId = isRequest(message) ? message.id : undefined;
			const controller = new AbortController();
			inflightPosts.add(controller);
			try {
				await postMessage(endpoint, message, controller);
			} catch (err) {
				if (controller.signal.aborted) {
					log.debug("POST aborted", { url: options.url, requestId: String(requestId ?? "") });
					return;
				}
				settleFailure(withRequestId(toTransportError(err, "MCP message POST failed"), requestId), requestId);
			} finally {
				inflightPosts.delete(controller);
			}
		},

		async cancel(id: JsonRpcId): Promise<void> {
			// 2024-11-05 绑定没有取消信号的通道（规范原文），只能尽力而为地发一条通知；失败静默
			if (closed || !started) return;
			const endpoint = messageEndpoint;
			if (endpoint === null) return;
			const notification: JsonRpcMessage = {
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, reason: "client cancelled" },
			};
			const controller = new AbortController();
			inflightPosts.add(controller);
			try {
				await postMessage(endpoint, notification, controller);
			} catch (err) {
				log.debug("best-effort cancel failed", { requestId: String(id), message: String(err) });
			} finally {
				inflightPosts.delete(controller);
			}
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

		setProtocolVersion(): void {
			// 2024-11-05 没有协议版本头：版本在 initialize 消息体里协商
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
			channelAbort?.abort();
			for (const controller of [...inflightPosts]) controller.abort();
			inflightPosts.clear();
			messageEndpoint = null;
			messageHandlers.clear();
			errorHandlers.clear();
			logHandlers.clear();
		},
	};
}
