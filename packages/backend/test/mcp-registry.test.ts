/**
 * MCP registry 生命周期回归：**建连途中被 drop/改配置作废**。
 *
 * 这条来自 dev 冒烟的实测缺陷（scripts/smoke-mcp-ui.mjs 的日志）：删掉服务器后仍能看到
 * 子进程被 spawn、以及「retrying handshake as legacy」——因为 drop 只关掉了「当时已存在的 client」，
 * 而正在进行的建连完成后会把新 client 装回条目；该条目此后无人认领（配置已删 → 空闲回收也跳过它），
 * 连接与子进程就此泄漏。
 *
 * 用注入的假传输（`deps.transportFactory`）把「建连完成」的时机握在手里，无需真实子进程与定时器。
 */

import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "../src/mcp/config";
import { McpRegistry } from "../src/mcp/registry";
import type {
	JsonRpcMessage,
	McpTransport,
	McpTransportError,
	TransportDelivery,
} from "../src/mcp/transport";

/** 假传输：start() 由测试控制何时完成；send() 立即按方法回落一条响应 */
function makeFakeTransport(): {
	transport: McpTransport;
	startNow: () => void;
	closed: () => boolean;
} {
	let release: (() => void) | undefined;
	let closed = false;
	let onMessage: ((delivery: TransportDelivery) => void) | undefined;
	const transport: McpTransport = {
		kind: "stdio",
		start: () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		send: async (message: JsonRpcMessage) => {
			if (!("method" in message) || !("id" in message)) return;
			onMessage?.({
				message: {
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2026-07-28",
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "0.0.1" },
						resultType: "complete",
					},
				},
			});
		},
		cancel: async () => {},
		onMessage: (handler) => {
			onMessage = handler;
			return () => {
				onMessage = undefined;
			};
		},
		onError: (_handler: (error: McpTransportError) => void) => () => {},
		onLog: () => () => {},
		setProtocolVersion: () => {},
		setAuthHeaders: () => {},
		sessionId: () => null,
		close: async () => {
			closed = true;
		},
	};
	return {
		transport,
		startNow: () => release?.(),
		closed: () => closed,
	};
}

function resolvedServer(name: string): ResolvedMcpServer {
	return {
		name,
		config: { command: "fake", args: [] },
		source: "user",
		percho: { lazy: true, directTools: false, idleTimeoutMs: 0, exclude: [], ask: [] },
		transportOptions: { kind: "stdio", command: "fake", args: [], env: {}, inheritEnv: true },
	};
}

describe("McpRegistry 建连作废", () => {
	it("建连途中 drop：连接不得装回条目，且必须被关掉（不泄漏子进程）", async () => {
		const fake = makeFakeTransport();
		const servers = new Map([["alpha", resolvedServer("alpha")]]);
		const registry = new McpRegistry({
			resolve: (name) => servers.get(name),
			onEvent: () => {},
			transportFactory: () => fake.transport,
		});
		try {
			const connecting = registry.ensureClient("alpha");
			// drop 发生在 start() 尚未完成时（真实场景：删除/停用/改配置打断 npx 冷启动）
			await registry.drop("alpha");
			expect(registry.runtimeState("alpha").state).toBe("idle");
			fake.startNow();

			await expect(connecting).rejects.toThrow(/superseded by a configuration change/);
			expect(registry.peek("alpha")).toBeNull();
			expect(fake.closed()).toBe(true);
			// 已经作废的那次失败不得把状态记成 error（下次连接会重新判断）
			expect(registry.runtimeState("alpha").state).toBe("idle");
		} finally {
			await registry.dispose();
		}
	});

	it("未被 drop 的正常建连照常成功（对照，防作废判据误伤）", async () => {
		const fake = makeFakeTransport();
		const registry = new McpRegistry({
			resolve: () => resolvedServer("beta"),
			onEvent: () => {},
			transportFactory: () => fake.transport,
		});
		try {
			const connecting = registry.ensureClient("beta");
			fake.startNow();
			const client = await connecting;
			expect(client.era).toBe("modern");
			expect(registry.peek("beta")).toBe(client);
			expect(registry.runtimeState("beta").state).toBe("ready");
		} finally {
			await registry.dispose();
		}
	});

	it("drop 后立刻 ensureClient：不得继承被作废的在途建连（改配置后马上连要能成功）", async () => {
		const first = makeFakeTransport();
		const second = makeFakeTransport();
		const transports = [first.transport, second.transport];
		let call = 0;
		const registry = new McpRegistry({
			resolve: () => resolvedServer("delta"),
			onEvent: () => {},
			transportFactory: () => transports[call++] ?? second.transport,
		});
		try {
			const stale = registry.ensureClient("delta");
			await registry.drop("delta");
			const fresh = registry.ensureClient("delta");
			first.startNow(); // 老连接完成 → 判定作废并关闭
			second.startNow(); // 新连接完成 → 正常就绪

			await expect(stale).rejects.toThrow(/superseded by a configuration change/);
			expect((await fresh).era).toBe("modern");
			expect(first.closed()).toBe(true);
			expect(registry.peek("delta")).not.toBeNull();
		} finally {
			await registry.dispose();
		}
	});

	it("并发 ensureClient 只建一条连接（去重不因 drop 而失效）", async () => {
		const fake = makeFakeTransport();
		const factory = vi.fn(() => fake.transport);
		const registry = new McpRegistry({
			resolve: () => resolvedServer("gamma"),
			onEvent: () => {},
			transportFactory: factory,
		});
		try {
			const first = registry.ensureClient("gamma");
			const second = registry.ensureClient("gamma");
			fake.startNow();
			expect(await first).toBe(await second);
			expect(factory).toHaveBeenCalledTimes(1);
		} finally {
			await registry.dispose();
		}
	});
});
