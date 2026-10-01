import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveRecallEntryId, toBranchSessionMessages } from "../src/session/messages";

/** 构造带两条用户消息（+一条回复在中间）的内存会话，返回 manager 与 entry id */
function makeSession() {
	const sm = SessionManager.inMemory();
	const first = sm.appendMessage({ role: "user", content: "第一条", timestamp: 1000 } satisfies Message);
	const reply = sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "回复" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		timestamp: 1001,
	} as unknown as Message);
	const second = sm.appendMessage({ role: "user", content: "第二条", timestamp: 2000 } satisfies Message);
	return { sm, first, reply, second };
}

describe("resolveRecallEntryId（撤回目标解析）", () => {
	it("entryId 精确命中用户消息", () => {
		const { sm, second } = makeSession();
		expect(resolveRecallEntryId(sm, { entryId: second })).toBe(second);
	});

	it("entryId 指向非用户消息时拒绝", () => {
		const { sm, reply } = makeSession();
		expect(() => resolveRecallEntryId(sm, { entryId: reply })).toThrow(/not a user message/);
	});

	it("entryId 不存在时抛错", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { entryId: "nope" })).toThrow(/not found/);
	});

	it("按文本从分支尾部匹配最近一条同文用户消息", () => {
		const { sm, second } = makeSession();
		expect(resolveRecallEntryId(sm, { text: "第二条" })).toBe(second);
	});

	it("text + timestamp 双锚定：时间戳不符时不命中", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { text: "第二条", timestamp: 9999 })).toThrow(/not found/);
		expect(resolveRecallEntryId(sm, { text: "第二条", timestamp: 2000 })).toBeDefined();
	});

	it("未命中（文本不存在 / 全空 ref）抛错", () => {
		const { sm } = makeSession();
		expect(() => resolveRecallEntryId(sm, { text: "不存在" })).toThrow(/not found/);
		expect(() => resolveRecallEntryId(sm, {})).toThrow(/not found/);
	});

	it("只匹配当前 leaf 路径：branch 回退后侧枝上的消息不可见", () => {
		const { sm, first } = makeSession();
		sm.branch(first);
		expect(() => resolveRecallEntryId(sm, { text: "第二条" })).toThrow(/not found/);
		expect(resolveRecallEntryId(sm, { text: "第一条" })).toBe(first);
	});
});

describe("压缩后的 UI 历史", () => {
	it("读取完整会话树分支，而不是被 compaction 裁剪的模型上下文", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "压缩前第一条", timestamp: 1 } satisfies Message);
		sm.appendMessage({ role: "user", content: "压缩前第二条", timestamp: 2 } satisfies Message);
		const kept = sm.appendMessage({
			role: "user",
			content: "压缩前保留条目",
			timestamp: 3,
		} satisfies Message);
		sm.appendCompaction("模型上下文摘要", kept, 10_000);
		sm.appendMessage({ role: "user", content: "压缩后消息", timestamp: 4 } satisfies Message);

		const uiHistory = toBranchSessionMessages(sm.getBranch());
		// 压缩分割线也回放：位置 = compaction entry 在分支上的位置（即压缩真正发生的那一处），
		// 旧消息一条不少（UI 历史不裁，只有模型上下文被裁）
		expect(
			uiHistory.map((message) => (message.role === "compaction" ? "「压缩分割线」" : message.text)),
		).toEqual(["压缩前第一条", "压缩前第二条", "压缩前保留条目", "「压缩分割线」", "压缩后消息"]);
		expect(uiHistory.filter((m) => m.role === "compaction")).toEqual([
			{ role: "compaction", timestamp: expect.any(Number), summary: "模型上下文摘要", tokensBefore: 10_000 },
		]);
		// SDK 上下文确实已缩短，证明测试没有把两种数据源混为一谈。
		expect(sm.buildSessionContext().messages.length).toBeLessThan(4);
	});

	it("多次压缩：每条 compaction entry 各产一条分割线，顺序与分支一致", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "a", timestamp: 1 } satisfies Message);
		sm.appendCompaction("摘要一", sm.getLeafId() ?? "", 100);
		sm.appendMessage({ role: "user", content: "b", timestamp: 2 } satisfies Message);
		sm.appendCompaction("摘要二", sm.getLeafId() ?? "", 200);

		const roles = toBranchSessionMessages(sm.getBranch()).map((m) =>
			m.role === "compaction" ? m.summary : m.text,
		);
		expect(roles).toEqual(["a", "摘要一", "b", "摘要二"]);
	});

	it("压缩 entry 缺 summary/tokensBefore 时仍产分割线（字段不硬求）", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "a", timestamp: 1 } satisfies Message);
		sm.appendCompaction("", "", undefined as unknown as number);

		const divider = toBranchSessionMessages(sm.getBranch()).find((m) => m.role === "compaction");
		expect(divider).toEqual({ role: "compaction", timestamp: expect.any(Number) });
	});
});

describe("撤回持久化机制（SessionManager 层语义）", () => {
	it("branch + custom entry 标记后，上下文排除被撤回消息且 leaf 落在标记上", () => {
		const sm = SessionManager.inMemory();
		const first = sm.appendMessage({ role: "user", content: "a", timestamp: 1 } satisfies Message);
		const second = sm.appendMessage({ role: "user", content: "b", timestamp: 2 } satisfies Message);
		// 撤回第二条：leaf 回到 first，追加不进上下文的 custom 标记（重启后按文件序 leaf=标记）
		sm.branch(first);
		sm.appendCustomEntry("message-recalled", { recalledEntryId: second });
		const context = sm.buildSessionContext();
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]).toMatchObject({ role: "user" });
		const leaf = sm.getLeafEntry();
		expect(leaf?.type).toBe("custom");
	});
});
