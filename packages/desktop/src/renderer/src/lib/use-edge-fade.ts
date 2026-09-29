import { type RefObject, useEffect } from "react";

/**
 * 滚动边界淡出：把滚动容器当前的位置写成 `data-fade-top` / `data-fade-bottom`
 * （样式在 globals.css 的 `.edge-fade`），把原来的硬裁切（和曾经的 1px 实线）换成渐变。
 *
 * 只读容器 + 只写 data-*：
 * - 不 setState —— 滚动期间零 React 渲染（长会话滚动/流式期都不额外提交渲染）；
 * - 不拦 wheel、不改 scrollTop —— 延续项目「原生滚动」的既有决策（分组会话列表时代同一套做法）。
 *
 * 触发来源三处，缺一会漏状态：滚动位置变化（scroll）、容器尺寸变化（ResizeObserver）、
 * 内容变化（MutationObserver —— 展开分组/加载历史/流式追加都会改「还有没有另一边」）。
 *
 * 用法：`const ref = useRef<HTMLDivElement>(null); useEdgeFade(ref);` + 容器上挂 `edge-fade` 类。
 * 只要一侧淡出时传 `edges`（例：对话区下沿贴输入框，用户不要那里淡 → `useEdgeFade(scrollRef, "top")`）。
 */
export function useEdgeFade(ref: RefObject<HTMLElement | null>, edges: EdgeFadeEdges = "both"): void {
	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		let frame = 0;
		// 合帧：流式期 DOM 每帧都在变，合并成每帧最多量一次（避免每条 delta 都触发布局读取）
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				syncEdgeFade(el, edges);
			});
		};

		syncEdgeFade(el, edges);
		el.addEventListener("scroll", schedule, { passive: true });
		const resizeObserver = new ResizeObserver(schedule);
		resizeObserver.observe(el);
		const mutationObserver = new MutationObserver(schedule);
		mutationObserver.observe(el, { childList: true, subtree: true });

		return () => {
			if (frame) cancelAnimationFrame(frame);
			el.removeEventListener("scroll", schedule);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
		};
	}, [ref, edges]);
}

/** 参与淡出的边（默认两侧） */
export type EdgeFadeEdges = "both" | "top" | "bottom";

/**
 * 按滚动位置写淡出属性；不溢出的容器不挂属性（没有"另一边"，边缘保持干净，也清掉上一轮的旧值）。
 * 不参与的那一侧始终不写（并清掉残留），这样 CSS 里 `[data-fade-top]` / `[data-fade-bottom]`
 * 两条单侧规则就足以表达「只淡一侧」。
 */
export function syncEdgeFade(el: HTMLElement, edges: EdgeFadeEdges = "both"): void {
	const wantsTop = edges !== "bottom";
	const wantsBottom = edges !== "top";
	if (!wantsTop) delete el.dataset.fadeTop;
	if (!wantsBottom) delete el.dataset.fadeBottom;
	if (el.scrollHeight - el.clientHeight <= 1) {
		delete el.dataset.fadeTop;
		delete el.dataset.fadeBottom;
		return;
	}
	// 容差 1px：触控板/缩放下的分数 scrollTop 不该被当成「还能滚」
	if (wantsTop) el.dataset.fadeTop = el.scrollTop > 1 ? "true" : "false";
	if (wantsBottom)
		el.dataset.fadeBottom = el.scrollHeight - el.clientHeight - el.scrollTop > 1 ? "true" : "false";
}
