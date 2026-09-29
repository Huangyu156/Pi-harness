import type { SessionMeta } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../stores/projects";
import { setDailyDirForTest } from "./daily";
import { deriveSidebarGroups, type SidebarGroupsInput } from "./sidebar-groups";
import {
	bumpMoreClicks,
	clearMoreClicks,
	EMPTY_MORE_CLICKS,
	hasMoreSessions,
	visibleSessionCount,
	visibleSessions,
} from "./sidebar-visible-count";

/**
 * 分批显示纯逻辑单测（spec: sidebar-unified-scroll）：条数契约 6 + 16n、边界、
 * 与派生层的组合（先排序/先过滤再裁剪），以及「搜索不得改持久化展开投影」这条边界。
 * 组件层的内存计数与搜索态在阶段 1（CDP）验证。
 */

const DAILY = "/home/me/.percho/daily";
const P1 = "/work/alpha";

setDailyDirForTest(DAILY);
afterEach(() => setDailyDirForTest(DAILY));

function session(id: string, cwd: string, modifiedAt: number, name = `会话 ${id}`): SessionMeta {
	return { sessionId: id, cwd, name, active: false, messageCount: 1, createdAt: 0, modifiedAt };
}

function project(cwd: string, sessionCount = 0): ProjectEntry {
	return { cwd, name: cwd.split("/").pop() ?? cwd, sessionCount, lastActive: 0, addedIndex: -1 };
}

function derive(overrides: Partial<SidebarGroupsInput> = {}) {
	return deriveSidebarGroups({
		sessions: [],
		projects: [],
		search: "",
		activeCwd: null,
		pinnedSessions: [],
		pinnedProjects: [],
		expandedGroups: [],
		expandedGroupsTouched: false,
		...overrides,
	});
}

/** n 条同 cwd 的会话，越靠后（id 越大）活动时间越新 —— 排序后 id 大者在前面 */
function manySessions(cwd: string, count: number, startIndex = 0): SessionMeta[] {
	return Array.from({ length: count }, (_, i) => session(`s${startIndex + i}`, cwd, 100 + i));
}

describe("visibleSessionCount · 6 + 16n 契约", () => {
	it("0 / 1 / 2 次点击 → 6 / 22 / 38 条", () => {
		expect(visibleSessionCount(1000, 0)).toBe(6);
		expect(visibleSessionCount(1000, 1)).toBe(22);
		expect(visibleSessionCount(1000, 2)).toBe(38);
	});

	it("组内总数不够时分档落在实际条数上（不留空位，也不越界）", () => {
		for (const click of [0, 1, 2, 3]) {
			for (const total of [0, 1, 5, 6, 7, 22, 23, 38, 39]) {
				const shown = visibleSessionCount(total, click);
				expect(shown).toBeLessThanOrEqual(total);
				expect(shown).toBe(Math.min(total, 6 + 16 * click));
			}
		}
	});

	it("临界点：6 与 7 之间、22 与 23 之间各差一次点击才会多露出", () => {
		expect(visibleSessionCount(6, 0)).toBe(6);
		expect(visibleSessionCount(7, 0)).toBe(6);
		expect(visibleSessionCount(7, 1)).toBe(7);
		expect(visibleSessionCount(22, 0)).toBe(6);
		expect(visibleSessionCount(22, 1)).toBe(22);
		expect(visibleSessionCount(23, 1)).toBe(22);
		expect(visibleSessionCount(23, 2)).toBe(23);
	});

	it("会话被删除后自动裁到实际条数（已有点击次数不会撑出空洞）", () => {
		expect(visibleSessionCount(37, 5)).toBe(37);
		expect(visibleSessionCount(0, 3)).toBe(0);
	});

	it("非法入参按 0 处理：负数/小数/NaN 都不产生负条数或越界", () => {
		expect(visibleSessionCount(10, -1)).toBe(6);
		expect(visibleSessionCount(10, 0.9)).toBe(6);
		expect(visibleSessionCount(100, 1.9)).toBe(22);
		expect(visibleSessionCount(10, Number.NaN)).toBe(6);
		expect(visibleSessionCount(-5, 0)).toBe(0);
	});
});

describe("visibleSessions · 只裁剪，不重排不去重", () => {
	it("返回的是原数组的前缀（顺序与源一致），源数组不被修改", () => {
		const source = Array.from({ length: 30 }, (_, i) => i);
		expect(visibleSessions(source, 0)).toEqual(source.slice(0, 6));
		expect(visibleSessions(source, 1)).toEqual(source.slice(0, 22));
		expect(visibleSessions(source, 2)).toEqual(source);
		expect(source).toHaveLength(30);
	});
});

describe("hasMoreSessions · 全显后按钮消失", () => {
	it("总数 6 条：一次都不用点（不显示按钮）", () => {
		expect(hasMoreSessions(5, 0)).toBe(false);
		expect(hasMoreSessions(6, 0)).toBe(false);
	});

	it("总数 7 条：点一次后按钮消失", () => {
		expect(hasMoreSessions(7, 0)).toBe(true);
		expect(hasMoreSessions(7, 1)).toBe(false);
	});

	it("总数 23 条：第二档才全显", () => {
		expect(hasMoreSessions(23, 0)).toBe(true);
		expect(hasMoreSessions(23, 1)).toBe(true);
		expect(hasMoreSessions(23, 2)).toBe(false);
	});

	it("空组不显示按钮", () => {
		expect(hasMoreSessions(0, 0)).toBe(false);
	});
});

describe("与派生层组合：先排序（置顶分区）再裁剪", () => {
	it("置顶行即使活动时间最旧也在前 6 条里；裁剪后顺序 = 派生顺序", () => {
		const sessions = [...manySessions(P1, 30), session("pinned-old", P1, 1)];
		const result = derive({ sessions, projects: [project(P1, 31)], pinnedSessions: ["pinned-old"] });
		const group = result.projects[0];
		expect(group?.sessions[0]?.session.sessionId).toBe("pinned-old");
		expect(group?.sessions[0]?.pinned).toBe(true);

		const rows = visibleSessions(group?.sessions ?? [], 0);
		expect(rows).toHaveLength(6);
		expect(rows.map((row) => row.session.sessionId)).toEqual(
			(group?.sessions ?? []).slice(0, 6).map((row) => row.session.sessionId),
		);
		expect(rows[0]?.pinned).toBe(true);
	});
});

describe("与派生层组合：先搜索过滤再计数", () => {
	it("计数用过滤后的条数（不是磁盘真实总数），按钮按过滤结果出现与消失", () => {
		const sessions = [
			...Array.from({ length: 20 }, (_, i) => session(`match-${i}`, P1, 100 + i, `重构左栏 ${i}`)),
			session("other", P1, 999, "无关会话"),
		];
		const searched = derive({ sessions, projects: [project(P1, 21)], search: "重构左栏" });
		const group = searched.projects[0];
		// 真实总数仍是不受搜索影响的 21（移除项目的确认文案要用它）
		expect(group?.totalSessions).toBe(21);
		expect(group?.sessions).toHaveLength(20);
		expect(visibleSessions(group?.sessions ?? [], 0)).toHaveLength(6);
		expect(hasMoreSessions(group?.sessions.length ?? 0, 0)).toBe(true);
		expect(hasMoreSessions(group?.sessions.length ?? 0, 1)).toBe(false);
	});
});

describe("搜索不得改持久化展开投影（临时展开是 UI 层的事）", () => {
	const sessions = [
		session("a", P1, 100, "重构左栏"),
		session("b", DAILY, 200, "重构右栏"),
		session("c", "/work/beta", 300, "重构顶栏"),
	];
	const base: Partial<SidebarGroupsInput> = {
		sessions,
		projects: [project(P1), project("/work/beta")],
		activeCwd: P1,
		expandedGroups: [],
		expandedGroupsTouched: true,
	};

	it("默认展开集与各组 expanded 在搜索前后完全一致（命中组也不会被「自动展开」）", () => {
		const normal = derive(base);
		const searching = derive({ ...base, search: "重构" });
		expect(searching.defaultExpandedKeys).toEqual(normal.defaultExpandedKeys);
		expect(searching.projects.map((p) => [p.cwd, p.expanded])).toEqual(
			normal.projects.map((p) => [p.cwd, p.expanded]),
		);
		expect(searching.daily?.expanded).toBe(normal.daily?.expanded);
		// 用户记录 = 全部折叠：搜索命中也不得把它撑开（临时展开只能在组件层叠加）
		expect(searching.projects.every((p) => !p.expanded)).toBe(true);
		expect(searching.daily?.expanded).toBe(false);
	});

	it("未操作过（touched=false）时，搜索也不改变默认展开推断（仍是 activeCwd 那组）", () => {
		const untouched = { ...base, expandedGroupsTouched: false };
		expect(derive(untouched).defaultExpandedKeys).toEqual([P1]);
		expect(derive({ ...untouched, search: "重构" }).defaultExpandedKeys).toEqual([P1]);
	});
});

describe("计数表 helpers（不可变更新）", () => {
	it("bumpMoreClicks 不改原表，同 key 累加", () => {
		const once = bumpMoreClicks(EMPTY_MORE_CLICKS, P1);
		const twice = bumpMoreClicks(once, P1);
		expect(once).toEqual({ [P1]: 1 });
		expect(twice).toEqual({ [P1]: 2 });
		expect(EMPTY_MORE_CLICKS).toEqual({});
	});

	it("clearMoreClicks 删掉该组计数（折叠再展开回到 6 条），没有该 key 时返回同一引用", () => {
		const map = { [P1]: 2, "/work/beta": 1 };
		const cleared = clearMoreClicks(map, P1);
		expect(cleared).toEqual({ "/work/beta": 1 });
		expect(map).toEqual({ [P1]: 2, "/work/beta": 1 });
		expect(clearMoreClicks(map, "/work/gone")).toBe(map);
	});
});
