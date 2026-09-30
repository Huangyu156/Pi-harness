/**
 * HTTP 系传输绑定测试：跑**真实本地 node:http 服务**（test/fixtures/mcp/http-server.mjs），不用 mock。
 * 覆盖：application/json 与 text/event-stream 两条响应路径、202 语义、非 2xx 的世代判定 body、
 * 会话头捕获与复用、cancel 关流、socket 层失败的 failure 归类，以及已弃用的 HTTP+SSE 绑定。
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asRecord } from "../src/mcp/json";
import type { McpTransport, McpTransportError, TransportDelivery } from "../src/mcp/transport";
import { createTransport } from "../src/mcp/transports";
import { createHttpSseTransport } from "../src/mcp/transports/http-sse";
import { createStreamableHttpTransport } from "../src/mcp/transports/streamable-http";

const HTTP_SERVER = fileURLToPath(new URL("./fixtures/mcp/http-server.mjs", import.meta.url));

interface FixtureState {
	requests: { mode: string; headers: Record<string, string | null>; body: unknown }[];
	postedMessages: { sessionId: string | null; headers: Record<string, string | null>; body: unknown }[];
	cancels: unknown[];
	closedStreams: { kind: string; id: unknown }[];
	sseOpen: boolean;
	hangOpen: boolean;
	legacyOpen: boolean;
}

interface Recorder {
	deliveries: TransportDelivery[];
	errors: McpTransportError[];
	logs: string[];
	waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>;
}

function record(transport: McpTransport): Recorder {
	const deliveries: TransportDelivery[] = [];
	const errors: McpTransportError[] = [];
	const logs: string[] = [];
	transport.onMessage((delivery) => deliveries.push(delivery));
	transport.onError((error) => errors.push(error));
	transport.onLog((line) => logs.push(line));
	return {
		deliveries,
		errors,
		logs,
		async waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
			const deadline = Date.now() + 5_000;
			while (!(await predicate())) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
				await delay(10, undefined, { ref: false });
			}
		},
	};
}

/** 取出投递里的 result（形状由 fixture 决定，用仓库的收窄工具读，不做整块类型断言） */
function resultOf(message: unknown): Record<string, unknown> {
	const result = asRecord(asRecord(message)?.result);
	if (result === null) throw new Error("delivery is not a JSON-RPC result response");
	return result;
}

const transports: McpTransport[] = [];
let server: ChildProcess | null = null;
let base = "";

function track(transport: McpTransport): McpTransport {
	transports.push(transport);
	return transport;
}

async function fixtureState(): Promise<FixtureState> {
	// 带超时：替身服务万一没结算响应，这里报错而不是把测试挂到超时（挂起会掩盖真正的失败点）
	const response = await fetch(`${base}/state`, { signal: AbortSignal.timeout(2_000) });
	// 形状由测试自己的替身服务决定：边界处断言一次，后面按类型读
	const state = (await response.json()) as FixtureState;
	return state;
}

beforeAll(async () => {
	const child = spawn(process.execPath, [HTTP_SERVER], { stdio: ["ignore", "pipe", "pipe"] });
	server = child;
	const stdout = child.stdout;
	if (stdout === null) throw new Error("http fixture server has no stdout pipe");
	const [chunk] = await once(stdout, "data");
	base = `http://127.0.0.1:${Number(String(chunk).trim())}`;
});

afterAll(async () => {
	const child = server;
	server = null;
	if (child === null) return;
	child.kill("SIGKILL");
	await Promise.race([once(child, "close").catch(() => undefined), delay(2_000, undefined, { ref: false })]);
});

afterEach(async () => {
	await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

describe("Streamable HTTP 传输", () => {
	it("application/json：投递带 httpStatus=200，协议头与配置头/动态认证头都带上", async () => {
		const transport = track(
			createStreamableHttpTransport({
				kind: "streamable-http",
				url: `${base}/mcp?mode=json`,
				headers: { "x-static": "static-value" },
			}),
		);
		const rec = record(transport);
		transport.setProtocolVersion("2026-07-28");
		transport.setAuthHeaders({ authorization: "Bearer dynamic-token" });
		await transport.start();

		await transport.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "echo", arguments: { a: 1 } },
		});
		await rec.waitFor(() => rec.deliveries.length >= 1, "json 响应");

		const delivery = rec.deliveries[0];
		expect(delivery?.httpStatus).toBe(200);
		const received = asRecord(resultOf(delivery?.message).received) ?? {};
		expect(received["mcp-method"]).toBe("tools/call");
		expect(received["mcp-name"]).toBe("echo");
		expect(received["mcp-protocol-version"]).toBe("2026-07-28");
		expect(received["content-type"]).toBe("application/json");
		expect(String(received.accept)).toContain("text/event-stream");
		expect(received.authorization).toBe("Bearer dynamic-token");
		expect(received["x-static"]).toBe("static-value");
		expect(rec.errors).toEqual([]);
	});

	it("会话头：首个响应捕获 Mcp-Session-Id，后续 POST 带上；mcp-name 只对具名方法发", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=json`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();
		expect(transport.sessionId()).toBeNull();

		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 1, "首个响应");
		expect(transport.sessionId()).toBe("test-session-1");
		const firstReceived = asRecord(resultOf(rec.deliveries[0]?.message).received);
		expect(firstReceived?.["mcp-session-id"]).toBeNull();
		expect(firstReceived?.["mcp-name"]).toBeNull();

		await transport.send({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "file:///x" } });
		await rec.waitFor(() => rec.deliveries.length >= 2, "第二个响应");
		const received = asRecord(resultOf(rec.deliveries[1]?.message).received) ?? {};
		expect(received["mcp-session-id"]).toBe("test-session-1"); // 捕获之后每个 POST 都带上
		expect(received["mcp-name"]).toBe("file:///x"); // resources/read 取 params.uri
	});

	it("在途表在请求结束后清理：同一条 id 可复用，cancel 不误伤已结束的请求", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=json`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		await transport.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 1, "首个响应");
		// 请求已结束：cancel 是静默 no-op（在途表里不该还留着它的 AbortController）
		await transport.cancel(5);
		await transport.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 2, "同 id 复用的响应");
		expect(rec.deliveries[1]?.message).toMatchObject({ id: 5, result: { ok: true } });
		expect(rec.errors).toEqual([]);
	});

	it("text/event-stream：keep-alive 注释不被当畸形，收到响应后流不中止（继续投递通知）", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=sse`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		let settled = false;
		const sending = transport
			.send({ jsonrpc: "2.0", id: 11, method: "subscriptions/listen", params: { notifications: {} } })
			.then(() => {
				settled = true;
			});

		await rec.waitFor(() => rec.deliveries.length >= 2, "progress 通知与最终响应");
		expect(rec.deliveries[0]?.message).toMatchObject({ method: "notifications/progress" });
		expect(rec.deliveries[1]?.httpStatus).toBe(200);
		expect(rec.deliveries[1]?.message).toMatchObject({ id: 11, result: { ok: true } });
		expect(rec.errors).toEqual([]); // `: keep-alive` 注释帧没有被当畸形输入

		// 响应之后服务器继续在**同一条流**上推通知：读到带 id 的响应就 break 的实现会在这里丢消息
		const notified = await fetch(`${base}/control/notify?text=after-response`);
		expect(await notified.json()).toEqual({ ok: true });
		await rec.waitFor(() => rec.deliveries.length >= 3, "响应之后的通知");
		expect(rec.deliveries[2]?.message).toMatchObject({
			method: "notifications/message",
			params: { text: "after-response" },
		});

		// send 的 promise 在响应体读完前不结算（subscriptions/listen 靠这条流长期开着）
		expect(settled).toBe(false);
		await fetch(`${base}/control/end`);
		await sending;
		expect(settled).toBe(true);
		expect(rec.errors).toEqual([]);
	});

	it("非 2xx 但 body 是 JSON-RPC：投递消息并带 httpStatus=400（世代判定的输入）", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=err400`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		await transport.send({ jsonrpc: "2.0", id: 21, method: "server/discover", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 1, "400 的 JSON-RPC error");

		expect(rec.deliveries[0]?.httpStatus).toBe(400);
		expect(rec.deliveries[0]?.message).toMatchObject({ id: 21, error: { code: -32020 } });
		expect(rec.errors).toEqual([]); // 非 2xx 不抛、不降级成传输错误
	});

	it("非 2xx 且 body 不可解析：onError(failure=http, status, requestId)，send 不 reject", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=err500`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		const sending = transport.send({ jsonrpc: "2.0", id: 31, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.errors.length >= 1, "传输错误");

		const error = rec.errors[0];
		expect(error?.failure).toBe("http");
		expect(error?.status).toBe(500);
		expect(error?.requestId).toBe(31); // client 靠它只结算这一条请求
		expect(String(error?.body)).toContain("boom");
		await expect(sending).resolves.toBeUndefined();
		expect(rec.deliveries).toEqual([]);
	});

	it("202：通知不投递消息；被强制 202 的请求也不造假投递", async () => {
		const notificationTransport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=json`, headers: {} }),
		);
		const notificationRec = record(notificationTransport);
		await notificationTransport.start();
		await notificationTransport.send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
			params: {},
		});
		const notificationState = await fixtureState();
		expect(notificationState.requests.at(-1)?.mode).toBe("json");
		expect(notificationRec.deliveries).toEqual([]);
		expect(notificationRec.errors).toEqual([]);

		const forcedTransport = track(
			createStreamableHttpTransport({
				kind: "streamable-http",
				url: `${base}/mcp?mode=notify202`,
				headers: {},
			}),
		);
		const forcedRec = record(forcedTransport);
		await forcedTransport.start();
		await forcedTransport.send({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} });
		await delay(150, undefined, { ref: false });
		expect(forcedRec.deliveries).toEqual([]);
		expect(forcedRec.errors).toEqual([]);
	});

	it("cancel(id)：关掉该请求的响应流（服务器观测到断开），不报 onError；未知 id 静默", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: `${base}/mcp?mode=hang`, headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		const sending = transport.send({
			jsonrpc: "2.0",
			id: 51,
			method: "tools/call",
			params: { name: "hang" },
		});
		await rec.waitFor(async () => (await fixtureState()).hangOpen, "hang 流已打开");

		await transport.cancel(51);
		await rec.waitFor(
			async () => (await fixtureState()).closedStreams.some((entry) => entry.id === 51),
			"服务器观测到关流",
		);
		await expect(sending).resolves.toBeUndefined(); // 主动取消不算故障，不 reject 也不报错
		expect(rec.errors).toEqual([]);
		await expect(transport.cancel(51)).resolves.toBeUndefined(); // 已出表：静默
		await expect(transport.cancel(999)).resolves.toBeUndefined(); // 未知 id：静默
	});

	it("socket 层失败：请求走 onError(failure=stream, 带 requestId)，通知 reject", async () => {
		const transport = track(
			createStreamableHttpTransport({ kind: "streamable-http", url: "http://127.0.0.1:1/mcp", headers: {} }),
		);
		const rec = record(transport);
		await transport.start();

		const sending = transport.send({ jsonrpc: "2.0", id: 61, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.errors.length >= 1, "socket 失败");
		expect(rec.errors[0]?.failure).toBe("stream");
		expect(rec.errors[0]?.requestId).toBe(61);
		await expect(sending).resolves.toBeUndefined();

		// 通知没有 id 可归属：只能 reject 给调用方（报 onError 会被 client 当成整条连接致命）
		await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).rejects.toThrow(
			/MCP request failed/u,
		);
	});
});

describe("HTTP+SSE 传输（已弃用绑定）", () => {
	it("start 等 endpoint 事件并取 sessionId；GET 流的 message 事件投递；POST 走 202；cancel 尽力而为", async () => {
		const transport = track(createHttpSseTransport({ kind: "http-sse", url: `${base}/sse`, headers: {} }));
		// 必须在 start 之前订阅：endpoint 事件之后服务器立刻推的那条通知也要收到
		const rec = record(transport);
		await transport.start();
		expect(transport.sessionId()).toBe("test-session-42");

		await rec.waitFor(() => rec.deliveries.length >= 1, "endpoint 之后的通知");
		expect(rec.deliveries[0]?.message).toMatchObject({
			method: "notifications/message",
			params: { text: "after-endpoint" },
		});

		// 上行 POST 只回 202，真正的响应经 GET 流回来
		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 2, "GET 流上的响应");
		expect(rec.deliveries[1]?.message).toMatchObject({ id: 1, result: { echo: "tools/list" } });

		// POST 响应体里带 JSON-RPC 消息时也要投递
		await transport.send({ jsonrpc: "2.0", id: 2, method: "test/inline", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 3, "inline 通知");
		expect(rec.deliveries[2]?.message).toMatchObject({
			method: "notifications/message",
			params: { text: "inline" },
		});

		// ping 事件与注释帧被忽略：既没有额外投递也没有错误
		expect(rec.errors).toEqual([]);

		await transport.cancel(1);
		await rec.waitFor(async () => (await fixtureState()).cancels.includes(1), "cancel 落地到服务器");

		const state = await fixtureState();
		expect(state.postedMessages.length).toBeGreaterThanOrEqual(3);
		expect(state.postedMessages.every((message) => message.sessionId === "test-session-42")).toBe(true);
		expect(state.postedMessages[1]?.headers["content-type"]).toBe("application/json");
	});

	it("GET 流被服务器关闭 → onError(failure=stream)", async () => {
		const transport = track(createHttpSseTransport({ kind: "http-sse", url: `${base}/sse`, headers: {} }));
		const rec = record(transport);
		await transport.start();

		await fetch(`${base}/control/end-legacy`);
		await rec.waitFor(() => rec.errors.length >= 1, "信道断开错误");
		expect(rec.errors[0]?.failure).toBe("stream");
		expect(rec.errors[0]?.message).toContain("closed");
	});

	it("未 start 就 send：给出可读错误而不是打到错的 URL", async () => {
		const transport = track(createHttpSseTransport({ kind: "http-sse", url: `${base}/sse`, headers: {} }));
		await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).rejects.toThrow(
			/not started/u,
		);
	});
});

describe("传输工厂", () => {
	it("按 kind 分派到对应绑定；start 拒绝非 http(s) 的 URL", async () => {
		expect(
			createTransport({ kind: "stdio", command: process.execPath, args: [], env: {}, inheritEnv: true }).kind,
		).toBe("stdio");
		expect(createTransport({ kind: "streamable-http", url: `${base}/mcp`, headers: {} }).kind).toBe(
			"streamable-http",
		);
		expect(createTransport({ kind: "http-sse", url: `${base}/sse`, headers: {} }).kind).toBe("http-sse");

		const bad = track(
			createTransport({ kind: "streamable-http", url: "ftp://example.com/mcp", headers: {} }),
		);
		await expect(bad.start()).rejects.toThrow(/Unsupported MCP server URL protocol/u);
		// send 在 start 之前一律拒绝（client 生命周期是 start → send）
		const notStarted = track(
			createTransport({ kind: "streamable-http", url: `${base}/mcp?mode=json`, headers: {} }),
		);
		await expect(
			notStarted.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		).rejects.toThrow(/not started/u);
	});
});
