/**
 * `mcpScript` 执行器：worker 线程 + vm 沙箱 + 双向 RPC。
 *
 * 这里用**注入的 dispatch**（不碰真实 MCP 服务器）验证执行器本身的行为：返回值投影、console 捕获、
 * `tools.*` 协议、超时、中止、预算、错误传播。真实「脚本 → 远端工具」的端到端在 mcp-service.test.ts。
 */

import { describe, expect, it, vi } from "vitest";
import { runMcpScript } from "../src/mcp/script";

/** 统一的桩 dispatch：把调用记下来并把固定载荷回给脚本 */
function stubDispatch(payload: unknown = { ok: true, items: [] }) {
	const calls: Array<{ op: string; path?: unknown; input?: unknown; args?: unknown }> = [];
	const dispatch = vi.fn(async (message: { op: string; path?: unknown; input?: unknown; args?: unknown }) => {
		calls.push(message);
		return payload as Record<string, unknown>;
	});
	return { calls, dispatch };
}

describe("mcpScript 执行器", () => {
	it("脚本返回值经格式化后回传；undefined 归 null", async () => {
		const stub = stubDispatch();
		const outcome = await runMcpScript({
			code: "return { answer: 42, nested: [1, 2] };",
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(outcome.returnText).toContain('"answer": 42');
		expect(outcome.calls).toEqual([]);
	});

	it("console.log 与 emit 的文本按序进入 logs（带 level 前缀）", async () => {
		const stub = stubDispatch();
		const outcome = await runMcpScript({
			code: 'console.log("first", 1); emit({ done: true }); console.error("last");',
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(outcome.logs[0]).toBe("[log] first 1");
		expect(outcome.logs[1]).toContain('"done": true');
		expect(outcome.logs[2]).toBe("[error] last");
	});

	it("tools.search / tools.describe / tools.call 都转发给 dispatch，并记录调用轨迹", async () => {
		const stub = stubDispatch({
			ok: true,
			items: [{ path: "echo__echo" }],
			total: 1,
			failed: [],
			pending: [],
		});
		const outcome = await runMcpScript({
			code: `const found = await tools.search({ query: "echo", server: "echo" });
				await tools.describe({ path: "echo__echo" });
				const called = await tools.call("echo__echo", { a: 1 });
				return { total: found.total, called: called.ok };`,
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(stub.calls.map((call) => call.op)).toEqual(["search", "describe", "call"]);
		expect(stub.calls[0]?.input).toEqual({ query: "echo", server: "echo" });
		expect(stub.calls[1]?.path).toBe("echo__echo");
		expect(stub.calls[2]?.args).toEqual({ a: 1 });
		expect(outcome.returnText).toContain('"total": 1');
		expect(outcome.calls.every((call) => call.ok)).toBe(true);
	});

	it("简写 tools.<path>(args) 等价于 tools.call(path, args)", async () => {
		const stub = stubDispatch({ ok: true, result: { isError: false, content: [] } });
		await runMcpScript({
			code: 'return (await tools.echo__echo({ x: "y" })).result.isError;',
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(stub.calls[0]?.op).toBe("call");
		expect(stub.calls[0]?.path).toBe("echo__echo");
		expect(stub.calls[0]?.args).toEqual({ x: "y" });
	});

	it("空 path 的 tools.call 在 worker 内就被拒（不产生调用轨迹）", async () => {
		const stub = stubDispatch();
		const outcome = await runMcpScript({
			code: 'const bad = await tools.call("", {}); return bad.error.code;',
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(outcome.returnText).toBe("invalid_path");
		expect(stub.calls).toEqual([]);
	});

	it("调用失败时轨迹里带错误摘要，脚本仍能把失败面返回", async () => {
		const stub = stubDispatch({ ok: false, error: { code: "call_failed", message: "boom" } });
		const outcome = await runMcpScript({
			code: 'const r = await tools.call("echo__echo", {}); return r.error.message;',
			timeoutMs: 5_000,
			dispatch: stub.dispatch,
		});
		expect(outcome.returnText).toBe("boom");
		expect(outcome.calls[0]).toMatchObject({ op: "call", target: "echo__echo", ok: false, error: "boom" });
	});

	it("脚本抛错 → 执行器 reject 且带上原文（不是静默成功）", async () => {
		const stub = stubDispatch();
		await expect(
			runMcpScript({ code: 'throw new Error("script blew up");', timeoutMs: 5_000, dispatch: stub.dispatch }),
		).rejects.toThrow("script blew up");
	});

	it("vm 内禁用字符串代码生成（eval/Function 不可用）", async () => {
		const stub = stubDispatch();
		await expect(
			runMcpScript({ code: 'return Function("return 1")();', timeoutMs: 5_000, dispatch: stub.dispatch }),
		).rejects.toThrow(/code generation from strings/i);
	});

	it("超时：死循环脚本被终止，错误里给出预算与建议", async () => {
		const stub = stubDispatch();
		const started = Date.now();
		// 真实时钟：超时由 worker 线程的真实执行时间驱动，假定时器无法控制另一个线程的调度
		await expect(
			runMcpScript({
				code: "while (true) {}",
				timeoutMs: 500,
				dispatch: stub.dispatch,
			}),
		).rejects.toThrow(/timed out after 500ms/);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("signal 中止 → reject，且已产出的日志仍然可读（轨迹不丢）", async () => {
		const stub = stubDispatch();
		const controller = new AbortController();
		// 真实时钟：中止要与 worker 的真实启动/执行交错，假定时器无法驱动跨线程时序
		const abortTimer = setTimeout(() => controller.abort(), 120);
		try {
			await expect(
				runMcpScript({
					code: 'console.log("before abort"); await new Promise((r) => setTimeout(r, 3000));',
					timeoutMs: 5_000,
					signal: controller.signal,
					dispatch: stub.dispatch,
				}),
			).rejects.toThrow("aborted");
		} finally {
			clearTimeout(abortTimer);
		}
	});

	it("单次载荷超预算 → 回 payload_too_large 错误而不是把巨型载荷交给脚本", async () => {
		const huge = { ok: true, blob: "x".repeat(9 * 1024 * 1024) };
		const stub = stubDispatch(huge);
		const outcome = await runMcpScript({
			code: 'const r = await tools.search({ query: "big" }); return r.ok ? "unexpected" : r.error.code;',
			timeoutMs: 10_000,
			dispatch: stub.dispatch,
		});
		expect(outcome.returnText).toBe("payload_too_large");
		expect(outcome.calls[0]).toMatchObject({ op: "search", ok: true });
	});
});
