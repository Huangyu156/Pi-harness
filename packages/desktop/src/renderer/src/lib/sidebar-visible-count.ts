/**
 * 左栏分组的「分批显示」纯逻辑（spec: sidebar-unified-scroll）。
 *
 * 纪律：不 import React / 不读 store / 不碰持久化 —— 这些二次点击计数只活在 renderer 内存里
 * （重启回 6 条，不进 `UiState`/localStorage，也不新增 IPC）。这里只回答一个问题：
 * **「给这个组点过 n 次『显示更多』，现在该画多少行」**；不改数据源、不改排序、不改项目的真实会话数
 * （删除确认要用的全量计数仍由派生层给）。
 *
 * 状态归属（放 `Sidebar` 还是独立叶 hook）与搜索态的临时计数由组件层决定，见 IMPL-NOTES。
 */

/** 每个展开的组初始显示的会话条数 */
export const SIDEBAR_GROUP_INITIAL_ROWS = 6;
/** 每点一次「显示更多」追加的条数（6 → 22 → 38 …，直到全显后按钮消失） */
export const SIDEBAR_GROUP_MORE_STEP = 16;

/** 组 key（= cwd）→ 「显示更多」点击次数（正常模式与搜索模式各持一份，互不污染） */
export type MoreClicksMap = Readonly<Record<string, number>>;

/** 空表（初始 state / 清空后的稳定引用） */
export const EMPTY_MORE_CLICKS: MoreClicksMap = {};

/** 非负整数夹取：外部传入的负数/小数/NaN 一律按 0 处理，别让它算出负的显示条数 */
function normalizeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** 该组当前应显示的会话条数 = `min(真实条数, 6 + 16 × 点击数)`（会话变少时自动裁到实际条数） */
export function visibleSessionCount(total: number, moreClicks: number): number {
	const rows = SIDEBAR_GROUP_INITIAL_ROWS + SIDEBAR_GROUP_MORE_STEP * normalizeCount(moreClicks);
	return Math.min(normalizeCount(total), rows);
}

/**
 * 按点击数裁剪**已排序且已过滤**的会话列表（只裁剪，不重排、不去重、不动源数组）。
 * 调用方传进来的顺序就是最终顺序（置顶分区 + 最后活动倒序由派生层负责）。
 */
export function visibleSessions<T>(sessions: readonly T[], moreClicks: number): T[] {
	return sessions.slice(0, visibleSessionCount(sessions.length, moreClicks));
}

/** 还有没显示的行 → 该组末尾需要「显示更多」按钮 */
export function hasMoreSessions(total: number, moreClicks: number): boolean {
	return visibleSessionCount(total, moreClicks) < normalizeCount(total);
}

/** 点一次「显示更多」（不可变更新；组内已有次数上 +1） */
export function bumpMoreClicks(map: MoreClicksMap, key: string): MoreClicksMap {
	return { ...map, [key]: normalizeCount(map[key] ?? 0) + 1 };
}

/**
 * 清掉一个组的计数（项目折叠再展开 / 项目被删除时调用，该组回到 6 条）。
 * 本来就没有该 key 时原样返回同一个引用，避免无谓的重渲染。
 */
export function clearMoreClicks(map: MoreClicksMap, key: string): MoreClicksMap {
	if (!(key in map)) return map;
	const next: Record<string, number> = { ...map };
	delete next[key];
	return next;
}
