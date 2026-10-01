import { useState } from "react";
import {
	bumpMoreClicks,
	clearMoreClicks,
	EMPTY_MORE_CLICKS,
	type MoreClicksMap,
} from "../../lib/sidebar-visible-count";
import { useExpandedGroups } from "./useExpandedGroups";

/** 搜索态的临时展开/折叠（key → 是否展开）：只在**本次搜索词**内有效，一个字都不写持久化 */
type SearchOverrides = Readonly<Record<string, boolean>>;

const EMPTY_OVERRIDES: SearchOverrides = {};

/**
 * 搜索态（临时折叠 + 搜索用的「显示更多」次数）。`term` 是这份临时态归属的搜索词：
 * 搜索词一变（含清空）整份作废 —— 于是「每次搜索都从全展开 + 6 条开始」「清空即还原」都是结构上成立的。
 */
type SearchState = {
	term: string;
	overrides: SearchOverrides;
	clicks: MoreClicksMap;
};

const emptySearchState = (term: string): SearchState => ({
	term,
	overrides: EMPTY_OVERRIDES,
	clicks: EMPTY_MORE_CLICKS,
});

/** 删掉一个 key（本来就没有时原样返回，避免无谓重渲染） */
function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
	if (!(key in record)) return record;
	const next: Record<string, T> = { ...record };
	delete next[key];
	return next;
}

/**
 * 左栏的「分批显示 + 搜索临时展开」内存态（纯本地：不写 ui-state/localStorage、不新增 IPC，重启回 6 条）。
 *
 * 两张「显示更多」计数表 + 一张临时折叠表，按**模式**分开存：
 * - 正常模式：计数表 = 用户在各组点「显示更多」的次数；折叠该组标题时清掉它（重开回到 6 条）；
 * - 搜索模式（查询词非空）：所有命中组临时展开（不看持久化偏好），标题点击只改临时折叠表、
 *   「显示更多」只加搜索计数表。两张表互不相干 → 「清空搜索即恢复搜索前的展开态与计数」是结构上成立的，
 *   而不是靠退出搜索时把状态搬回去。
 *
 * 搜索词变化在**渲染期**处理（React 的「props 变化时调整 state」模式）而不是 effect：否则新搜索词的
 * 第一帧还会带着上一轮的临时折叠，看起来像「命中组没展开」。
 */
export function useSidebarBatching({ search, defaults }: { search: string; defaults: readonly string[] }) {
	const searching = search.trim().length > 0;
	const { toggleGroup: persistToggle } = useExpandedGroups();
	const [normalClicks, setNormalClicks] = useState<MoreClicksMap>(EMPTY_MORE_CLICKS);
	const [searchState, setSearchState] = useState<SearchState>(() => emptySearchState(search));

	// 搜索词变了（含清空）：本轮搜索的临时折叠与计数整份作废
	if (searchState.term !== search) setSearchState(emptySearchState(search));

	return {
		searching,
		/** 该组当前是否展开：正常模式 = 派生层给的持久化投影；搜索模式 = 本轮临时值（默认展开） */
		isExpanded: (key: string, persistedExpanded: boolean) =>
			searching ? (searchState.overrides[key] ?? true) : persistedExpanded,
		/** 该组在当前模式下已点过多少次「显示更多」 */
		moreClicks: (key: string) => (searching ? searchState.clicks[key] : normalClicks[key]) ?? 0,
		showMore: (key: string) => {
			if (searching) {
				setSearchState((prev) => ({ ...prev, clicks: bumpMoreClicks(prev.clicks, key) }));
				return;
			}
			setNormalClicks((prev) => bumpMoreClicks(prev, key));
		},
		/** 点分组标题。`nextExpanded` = 点击后的展开态（调用方从 `isExpanded` 得到，避免两处各自推一遍） */
		toggleGroup: (key: string, nextExpanded: boolean) => {
			if (searching) {
				// 搜索期间只改本轮临时值：持久化偏好不动，清空搜索后自然回到搜索前的展开态
				setSearchState((prev) => ({
					...prev,
					overrides: { ...prev.overrides, [key]: nextExpanded },
					// 重新展开 = 该组回到 6 条（搜索期间的「显示更多」不跨折叠保留）
					clicks: nextExpanded ? clearMoreClicks(prev.clicks, key) : prev.clicks,
				}));
				return;
			}
			// 折叠该组 → 计数清零（重开从 6 条开始）。侧栏整体收起再展开不算折叠，不会走到这里
			if (!nextExpanded) setNormalClicks((prev) => clearMoreClicks(prev, key));
			persistToggle(key, defaults);
		},
		/** 项目被移除：两张计数表与临时折叠表都不留这个 key */
		forget: (key: string) => {
			setNormalClicks((prev) => clearMoreClicks(prev, key));
			setSearchState((prev) => ({
				...prev,
				overrides: withoutKey(prev.overrides, key),
				clicks: clearMoreClicks(prev.clicks, key),
			}));
		},
	};
}

export type SidebarBatching = ReturnType<typeof useSidebarBatching>;
