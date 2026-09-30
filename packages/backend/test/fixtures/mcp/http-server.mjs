/**
 * HTTP 测试替身：真实 node:http 服务，同时扮演 Streamable HTTP 与已弃用的 HTTP+SSE 两种绑定。
 * 端口打到 stdout 第一行，测试读出来拼 base URL。
 *
 * Streamable HTTP（单端点 POST，模式由 query 的 ?mode= 决定）：
 * - json（默认）：200 + application/json；result.received 回显收到的关键头，并带 Mcp-Session-Id 响应头
 * - sse：200 + text/event-stream；注释帧 `: keep-alive` → progress 通知 → 最终响应 → **流保持打开**，
 *   之后由 /control/notify 推「响应之后」的通知，/control/end 才结束流
 * - err400：400 + JSON-RPC error（模拟 UnsupportedProtocolVersionError）
 * - err500：500 + text/plain（不可解析 → 走传输错误通道）
 * - notify202：一律 202 无 body
 * - hang：200 + text/event-stream，永不结束也不发数据（测 cancel 关流）
 * 通知（无 id）在上述模式里统一回 202 无 body。
 *
 * HTTP+SSE：
 * - GET /sse：text/event-stream，先发 endpoint 事件（data=/messages?sessionId=test-session-42），
 *   紧接着发一条 message 通知与一个 ping 事件（验证 endpoint 之后流仍在被读、ping 被忽略）
 * - POST /messages：202 无 body；body 是请求时把响应推回 GET 流；method=test/inline 时改回 200 + JSON-RPC 消息
 *
 * 控制面（测试用，不经过被测传输）：GET /state 看服务端记录；/control/notify、/control/end、
 * /control/end-legacy 操作打开着的流。
 */
import { createServer } from "node:http";

const state = {
	requests: [],
	postedMessages: [],
	cancels: [],
	closedStreams: [],
	streamableSse: null,
	hangStream: null,
	legacyStream: null,
};

const PICKED_HEADERS = [
	"content-type",
	"accept",
	"mcp-method",
	"mcp-name",
	"mcp-protocol-version",
	"mcp-session-id",
	"authorization",
	"x-static",
];

function picked(headers) {
	const out = {};
	for (const name of PICKED_HEADERS) out[name] = headers[name] ?? null;
	return out;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function parseBody(text) {
	if (text.trim() === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function sendJson(res, status, payload, extraHeaders = {}) {
	res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
	res.end(JSON.stringify(payload));
}

function sendNotification(res, method, params) {
	res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method, params })}\n\n`);
}

/** Streamable HTTP 的单端点 POST：模式由 ?mode= 决定 */
async function handleStreamable(req, res, url) {
	const parsed = parseBody(await readBody(req));
	const mode = url.searchParams.get("mode") ?? "json";
	state.requests.push({ mode, headers: picked(req.headers), body: parsed });
	const isNotification = parsed !== null && parsed.id === undefined;
	if (mode === "notify202") {
		res.writeHead(202);
		res.end();
		return;
	}
	if (mode === "err400") {
		sendJson(res, 400, {
			jsonrpc: "2.0",
			id: parsed?.id,
			error: { code: -32020, message: "Unsupported protocol version" },
		});
		return;
	}
	if (mode === "err500") {
		res.writeHead(500, { "content-type": "text/plain" });
		res.end("boom: internal server error");
		return;
	}
	if (mode === "hang") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(": keep-alive\n\n");
		state.hangStream = res;
		res.on("close", () => {
			state.hangStream = null;
			state.closedStreams.push({ kind: "hang", id: parsed?.id ?? null });
		});
		return;
	}
	if (mode === "sse") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"mcp-session-id": "test-session-1",
		});
		res.write(": keep-alive\n\n");
		sendNotification(res, "notifications/progress", { progressToken: "p1", progress: 1 });
		res.write(": keep-alive\n\n");
		res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: parsed?.id, result: { ok: true } })}\n\n`);
		state.streamableSse = res;
		res.on("close", () => {
			state.streamableSse = null;
		});
		return;
	}
	// json 模式（含通知的 202 语义）
	if (isNotification) {
		res.writeHead(202, { "mcp-session-id": "test-session-1" });
		res.end();
		return;
	}
	sendJson(
		res,
		200,
		{
			jsonrpc: "2.0",
			id: parsed?.id,
			result: { ok: true, received: picked(req.headers), params: parsed?.params ?? null },
		},
		{ "mcp-session-id": "test-session-1" },
	);
}

/** 已弃用的 HTTP+SSE：GET 下行信道 */
function handleLegacyChannel(_req, res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	res.write(": keep-alive\n\n");
	res.write("event: endpoint\ndata: /messages?sessionId=test-session-42\n\n");
	res.write("event: ping\ndata: {}\n\n");
	res.write(
		`event: message\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/message",
			params: { text: "after-endpoint" },
		})}\n\n`,
	);
	state.legacyStream = res;
	res.on("close", () => {
		state.legacyStream = null;
	});
}

/** 已弃用的 HTTP+SSE：POST 上行 */
async function handleLegacyPost(req, res, url) {
	const parsed = parseBody(await readBody(req));
	state.postedMessages.push({
		sessionId: url.searchParams.get("sessionId"),
		headers: picked(req.headers),
		body: parsed,
	});
	if (parsed?.method === "notifications/cancelled") state.cancels.push(parsed.params?.requestId);
	if (parsed?.method === "test/inline") {
		// 「响应体里有 JSON-RPC 消息」的变体：传输应当把它投递出来（必须正常结束响应，否则客户端读 body 会挂住）
		sendJson(res, 200, { jsonrpc: "2.0", method: "notifications/message", params: { text: "inline" } });
		return;
	}
	res.writeHead(202);
	res.end();
	if (parsed !== null && parsed.id !== undefined && state.legacyStream !== null) {
		// 响应走 GET 流而不是 POST 响应体（规范语义）
		state.legacyStream.write(
			`event: message\ndata: ${JSON.stringify({
				jsonrpc: "2.0",
				id: parsed.id,
				result: { echo: parsed.method, params: parsed.params ?? null },
			})}\n\n`,
		);
	}
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
	if (req.method === "GET" && url.pathname === "/state") {
		sendJson(res, 200, {
			requests: state.requests,
			postedMessages: state.postedMessages,
			cancels: state.cancels,
			closedStreams: state.closedStreams,
			sseOpen: state.streamableSse !== null,
			hangOpen: state.hangStream !== null,
			legacyOpen: state.legacyStream !== null,
		});
		return;
	}
	if (req.method === "GET" && url.pathname === "/control/notify") {
		state.streamableSse?.write(
			`data: ${JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { text: url.searchParams.get("text") ?? "after-response" },
			})}\n\n`,
		);
		sendJson(res, 200, { ok: state.streamableSse !== null });
		return;
	}
	if (req.method === "GET" && url.pathname === "/control/end") {
		state.streamableSse?.end();
		state.streamableSse = null;
		sendJson(res, 200, { ok: true });
		return;
	}
	if (req.method === "GET" && url.pathname === "/control/end-legacy") {
		state.legacyStream?.end();
		state.legacyStream = null;
		sendJson(res, 200, { ok: true });
		return;
	}
	if (req.method === "GET" && url.pathname === "/sse") {
		handleLegacyChannel(req, res);
		return;
	}
	if (req.method === "POST" && url.pathname === "/messages") {
		void handleLegacyPost(req, res, url);
		return;
	}
	if (req.method === "POST") {
		void handleStreamable(req, res, url);
		return;
	}
	sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`${server.address().port}\n`);
});
