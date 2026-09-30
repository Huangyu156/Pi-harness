/**
 * MCP HTTP 底座：三种 HTTP 场景（Streamable HTTP、已弃用的 HTTP+SSE、OAuth 令牌交换）共用的
 * 请求原语。
 *
 * 为什么不用全局 fetch（重要）：
 * - per-request TLS 选项（企业自签 CA 的 `tls.caFile` / `rejectUnauthorized`）在 fetch 上无法透传，
 *   零依赖前提下拿不到 undici Agent（`undici` 不是内建模块）；node:https 的 `ca` 是原生能力。
 * - SSE 要边到边解析，`http.IncomingMessage` 的字节流比 fetch 的 ReadableStream 更直接可控。
 * - Streamable HTTP 的取消语义是「关闭响应流」，需要拿到 socket 主动 destroy。
 *
 * 错误约定：网络/证书/TLS 失败一律以 Error 抛出（reject），HTTP 状态码不抛——状态码是调用方
 * 的判定输入（世代探测要看 400/404 的 body）。
 */

import { createReadStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createLogger } from "../log";
import { type McpTlsOptions, McpTransportError } from "./transport";

const log = createLogger("mcp-http");

export type { McpTlsOptions };

export interface McpHttpRequestOptions {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
	/** 取消信号：中止请求并销毁 socket */
	signal?: AbortSignal;
	tls?: McpTlsOptions;
	/** 建连 + 首字节超时（ms） */
	timeoutMs?: number;
}

/** 一次 HTTP 响应：状态码与响应头已就绪，body 由调用方决定怎么读 */
export interface McpHttpResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	/** 原始字节流（SSE 用）；只可读一次 */
	stream: AsyncIterable<Uint8Array>;
	/** 读完整个 body 为字符串（一次性响应；<=16MB 防御上限） */
	text(): Promise<string>;
	/** 主动断开（取消在途请求） */
	destroy(): void;
}

/** 打包态下 ~ 展开（与 Node 的 `~` 语义一致：仅前缀，且只认 / 或 \ 之后为路径） */
function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
	return path;
}

/** 读取 PEM 证书文件内容；文件缺失/不可读时抛可读错误（不静默降级为不校验，避免静默失去安全语义） */
async function readCaFile(caFile: string): Promise<string> {
	const chunks: Buffer[] = [];
	await new Promise<void>((done, fail) => {
		createReadStream(expandHomePath(caFile))
			.on("data", (chunk) => chunks.push(chunk as Buffer))
			.on("end", done)
			.on("error", (err) => fail(new Error(`Cannot read CA file ${caFile}: ${err.message}`)));
	});
	return Buffer.concat(chunks).toString("utf8");
}

/** 发起一次 HTTP(S) 请求；网络层失败 reject，HTTP 状态码原样返回 */
export async function mcpHttpRequest(options: McpHttpRequestOptions): Promise<McpHttpResponse> {
	const target = new URL(options.url);
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new McpTransportError(`Unsupported URL protocol: ${target.protocol}`, { failure: "http" });
	}
	const secure = target.protocol === "https:";
	const ca = options.tls?.caFile === undefined ? undefined : await readCaFile(options.tls.caFile);
	const requestFn = secure ? httpsRequest : httpRequest;
	const headers: Record<string, string> = { ...options.headers };
	if (options.body !== undefined && headers["content-length"] === undefined) {
		headers["content-length"] = String(Buffer.byteLength(options.body));
	}

	const response = await new Promise<IncomingMessage>((done, fail) => {
		const req = requestFn(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port === "" ? undefined : Number(target.port),
				path: `${target.pathname}${target.search}`,
				method: options.method,
				headers,
				...(secure ? { ca, rejectUnauthorized: options.tls?.rejectUnauthorized ?? true } : {}),
			},
			done,
		);
		const timeoutMs = options.timeoutMs ?? 30_000;
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
		});
		req.on("error", fail);
		const onAbort = () => req.destroy(new Error("Request aborted"));
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});

	const asAsyncIterable = async function* (): AsyncIterable<Uint8Array> {
		for await (const chunk of response) {
			yield chunk as Uint8Array;
		}
	};

	return {
		status: response.statusCode ?? 0,
		headers: response.headers,
		stream: asAsyncIterable(),
		text: async () => {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of response) {
				const buf = chunk as Buffer;
				size += buf.length;
				if (size > 16 * 1024 * 1024) {
					response.destroy();
					throw new McpTransportError("HTTP response body exceeds 16MB", { failure: "parse" });
				}
				chunks.push(buf);
			}
			return Buffer.concat(chunks).toString("utf8");
		},
		destroy: () => {
			response.destroy();
		},
	};
}

/** 读取响应体为字符串（保留给 OAuth 等一次性 JSON 场景，带同样的大小上限） */
export async function mcpHttpJson<T>(options: McpHttpRequestOptions): Promise<{ status: number; json: T }> {
	const response = await mcpHttpRequest(options);
	const text = await response.text();
	try {
		return { status: response.status, json: JSON.parse(text) as T };
	} catch (err) {
		throw new McpTransportError(`Expected JSON but got: ${text.slice(0, 200)}`, {
			failure: "parse",
			status: response.status,
			cause: err,
		});
	}
}

export interface SseEvent {
	event?: string;
	data: string;
}

/**
 * SSE 解析（规范 basic/transports/streamable-http）：
 * - `data:` 多行按 \n 拼接；空行分发一个事件；
 * - `:` 开头是注释（keep-alive），必须忽略且不得视为畸形输入；
 * - 不支持断线续传（`Last-Event-ID` 与事件 id 在 2026-07-28 已删除），因此忽略 `id:` 字段。
 */
export async function* parseSseStream(source: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let eventName: string | undefined;
	let dataLines: string[] = [];

	const dispatch = (): SseEvent | null => {
		if (dataLines.length === 0) {
			eventName = undefined;
			return null;
		}
		const event: SseEvent = { data: dataLines.join("\n") };
		if (eventName !== undefined) event.event = eventName;
		eventName = undefined;
		dataLines = [];
		return event;
	};

	for await (const chunk of source) {
		buffer += decoder.decode(chunk, { stream: true });
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const rawLine = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line === "") {
				const event = dispatch();
				if (event) yield event;
			} else if (line.startsWith(":")) {
				// keep-alive 注释，忽略
			} else {
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				let value = colon === -1 ? "" : line.slice(colon + 1);
				if (value.startsWith(" ")) value = value.slice(1);
				if (field === "event") eventName = value;
				else if (field === "data") dataLines.push(value);
			}
			index = buffer.indexOf("\n");
		}
	}
	const tail = dispatch();
	if (tail) yield tail;
	log.debug("sse stream ended");
}
