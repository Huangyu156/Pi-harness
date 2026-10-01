import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHydrationGate } from "../src/session/hydration-gate";

afterEach(() => vi.useRealTimers());

describe("SessionHydrationGate", () => {
	it("显式 ACK 解除同一会话的等待；其它会话不受影响", async () => {
		const gate = new SessionHydrationGate();
		const a = gate.wait("a");
		const b = gate.wait("b");
		gate.ack("a");
		expect(await a).toBe(true);
		gate.cancel("b");
		expect(await b).toBe(false);
		expect(await gate.wait("a")).toBe(true); // 同会话 SDK reload 不必重新等 ACK
		gate.dispose();
	});

	it("无 renderer ACK 时有限等待后放行，不永久饿死频道", async () => {
		vi.useFakeTimers();
		const gate = new SessionHydrationGate(100);
		const released = vi.fn();
		const pending = gate.wait("a").then(released);
		await vi.advanceTimersByTimeAsync(99);
		expect(released).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(released).toHaveBeenCalledExactlyOnceWith(true);
		gate.dispose();
	});
});
