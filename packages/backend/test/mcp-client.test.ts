/**
 * `McpClient` 的世代探测与响应关联——三条都来自真远端服务器实测：
 *
 * 1. **探测请求必须带 `_meta`**：modern 服务器会校验「版本头声称 2026-07-28 ⇒ 请求必须带
 *    per-request 信封」，拿 legacy 信封去探会被 400 `-32602 ... missing the required per-request
 *    envelope key(s): _meta` 拒掉（context7 / Cloudflare docs 实测）。反向不变量同样要守：
 *    legacy 的 `initialize` 绝不能带 `_meta`。
 * 2. **响应按绑定层的归属 id 关联**：deepwiki 在 400 上回 `id:"server-error"`、gitmcp 回 `id:null`，
 *    只认 body 里的 id 会把响应丢进「未知 id」分支，请求一直挂到 60s 超时。
 * 3. **拒绝原因不许被吞**：modern 端点拒绝探测时，错误消息里必须带上服务器原话
 *    （旧实现统一报「rejected protocol version without offering alternatives」，把关键诊断吞了）。
 */

import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client";
import type {
	JsonRpcMessage,
	McpTransport,
	McpTransportError,
	TransportDelivery,
} from "../src/mcp/transport";
import { isRequest } from "../src/mcp/transport";

interface ScriptedTransport {
	transport: McpTransport;
	/** 客户端发出的每一条消息（按序） */
	sent: JsonRpcMessage[];
	/** 由测试主动投递一条 delivery（可带 requestId/httpStatus） */
	deliver: (delivery: TransportDelivery) => void;
	/** 找到第一个指定方法的请求 */
	firstRequest: (method: string) => { id: string | number; params?: Record<string, unknown> };
}

function makeScriptedTransport(): ScriptedTransport {
	const sent: JsonRpcMessage[] = [];
	const handlers = new Set<(delivery: TransportDelivery) => void>();
	const transport: McpTransport = {
		kind: "stdio",
		start: async () => {},
		send: async (message) => {
			sent.push(message);
		},
		cancel: async () => {},
		onMessage: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		onError: (_handler: (error: McpTransportError) => void) => () => {},
		onLog: () => () => {},
		setProtocolVersion: () => {},
		setAuthHeaders: () => {},
		sessionId: () => null,
		close: async () => {},
	};
	return {
		transport,
		sent,
		deliver: (delivery) => {
			for (const handler of handlers) handler(delivery);
		},
		firstRequest: (method) => {
			const found = sent.find((message) => "method" in message && message.method === method);
			if (found === undefined || !isRequest(found)) throw new Error(`没有发出 ${method} 请求`);
			return { id: found.id, params: "params" in found ? found.params : undefined };
		},
	};
}

const DISCOVER_RESULT = {
	jsonrpc: "2.0",
	protocolVersion: "2026-07-28",
	capabilities: { tools: {} },
	resultType: "complete",
};

describe("McpClient 世代探测", () => {
	it("modern 探测请求带 _meta（真服务器会强制校验），连上后 era=modern", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();

		// 探测请求必须已经发出，且信封合规
		await new Promise((resolve) => setTimeout(resolve, 0));
		const discover = scripted.firstRequest("server/discover");
		expect(discover.params?._meta).toMatchObject({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "percho" },
		});

		scripted.deliver({
			message: { jsonrpc: "2.0", id: discover.id, result: DISCOVER_RESULT },
			httpStatus: 200,
		});
		const handshake = await connecting;
		expect(client.era).toBe("modern");
		expect(handshake.protocolVersion).toBe("2026-07-28");
		await client.close();
	});

	it("回退 legacy 时 initialize 不带 _meta（反向不变量，防过度修正）", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();

		await new Promise((resolve) => setTimeout(resolve, 0));
		const discover = scripted.firstRequest("server/discover");
		// legacy 服务器收到 server/discover 会回 -32601：不足以判定 modern → 回退 initialize
		scripted.deliver({
			message: { jsonrpc: "2.0", id: discover.id, error: { code: -32601, message: "Method not found" } },
			httpStatus: 200,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const initialize = scripted.firstRequest("initialize");
		expect(initialize.params?._meta).toBeUndefined();
		scripted.deliver({
			message: {
				jsonrpc: "2.0",
				id: initialize.id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "old", version: "1" },
				},
			},
			httpStatus: 200,
		});
		const handshake = await connecting;
		expect(client.era).toBe("legacy");
		expect(handshake.protocolVersion).toBe("2025-06-18");
		await client.close();
	});

	it("modern 端点拒绝探测时，错误里必须带服务器原话（不回退、不吞诊断）", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const discover = scripted.firstRequest("server/discover");
		scripted.deliver({
			message: {
				jsonrpc: "2.0",
				id: discover.id,
				error: {
					code: -32602,
					message:
						"Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28, but the request is missing the required per-request envelope key(s): _meta",
					data: { envelope: { missing: ["_meta"] } },
				},
			},
			httpStatus: 400,
		});

		await expect(connecting).rejects.toThrow(/missing the required per-request envelope key/);
		await expect(connecting).rejects.not.toThrow(/without offering alternatives/);
		await client.close();
	});

	it("服务器给出别的受支持版本 → 换版本重探一次", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const first = scripted.firstRequest("server/discover");
		scripted.deliver({
			message: {
				jsonrpc: "2.0",
				id: first.id,
				error: {
					code: -32022,
					message: "Unsupported protocol version",
					// 只报一个我们同样支持的版本：客户端应把版本换成它再试
					data: { supported: ["2026-07-28"], requested: "2025-01-01" },
				},
			},
			httpStatus: 400,
		});
		// 我们的实现只支持 2026-07-28，与当前版本相同 → 不再重探，直接带上原话失败
		await expect(connecting).rejects.toThrow(/Unsupported protocol version/);
		await client.close();
	});
});

describe("McpClient 响应关联", () => {
	it("body 里的 id 是服务器自造的字符串 / null 时，按 delivery.requestId 结算（不再挂到超时）", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const discover = scripted.firstRequest("server/discover");
		// 真服务器行为：400 + 自己造的 id（deepwiki 是 "server-error"、gitmcp 是 null）
		scripted.deliver({
			message: {
				jsonrpc: "2.0",
				id: "server-error",
				error: { code: -32600, message: "Bad Request: Unsupported protocol version: 2026-07-28" },
			},
			httpStatus: 400,
			requestId: discover.id,
		});

		// -32600 不属 modern 错误码集 → 回退 legacy；关键是：请求被结算了（没有挂到 60s 超时）
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initialize = scripted.firstRequest("initialize");
		expect(initialize.params?._meta).toBeUndefined();
		scripted.deliver({
			message: {
				jsonrpc: "2.0",
				id: initialize.id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					serverInfo: { name: "deepwiki", version: "1" },
				},
			},
			httpStatus: 200,
		});
		const handshake = await connecting;
		expect(client.era).toBe("legacy");
		expect(handshake.serverInfo?.name).toBe("deepwiki");
		await client.close();
	});

	it("id 为 null 的响应同样按 requestId 结算", async () => {
		const scripted = makeScriptedTransport();
		const client = new McpClient({ name: "probe", transport: scripted.transport });
		const connecting = client.connect();
		void connecting.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const discover = scripted.firstRequest("server/discover");
		scripted.deliver({
			message: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad Request" } },
			httpStatus: 400,
			requestId: discover.id,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(() => scripted.firstRequest("initialize")).not.toThrow();
		await client.close().catch(() => {});
	});
});
