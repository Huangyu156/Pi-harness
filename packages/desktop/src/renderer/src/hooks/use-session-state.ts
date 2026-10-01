import type { AvailableModel } from "@percho/shared";
import { useMemo } from "react";
import { clampThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../lib/thinking";
import { useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";

/**
 * 当前生效模型的完整信息（D4 收拢点）：
 * 真实会话 = 会话覆写 ?? 全局默认；draft 页（`activeSessionId === null`）= draft 配置里的起步模型。
 * Composer（图片门控）/ ModelPicker / ThinkingSlider 三处共用，替代各自手写解析。
 */
export function useActiveModelInfo(): AvailableModel | undefined {
	return useSessionsStore((s) => {
		const sessionModel = s.sessions.find((x) => x.sessionId === s.activeSessionId)?.model;
		const effective =
			s.activeSessionId === null ? s.newSessionDraft?.model : (sessionModel ?? s.lastUsedModel);
		if (!effective) return undefined;
		return s.models.find((m) => m.provider === effective.provider && m.id === effective.modelId);
	});
}

/** 活跃会话是否只读（subagent 产物检视）；无会话 = false */
export function useSessionReadOnly(): boolean {
	return useSessionsStore(
		(s) => s.sessions.find((x) => x.sessionId === s.activeSessionId)?.readOnly === true,
	);
}

/** 会话忙碌（agent 运行中或压缩中）：fork/撤回/发送类操作的禁用依据 */
export function useSessionBusy(sessionId: string | null): boolean {
	return useTranscriptStore((s) => {
		if (!sessionId) return false;
		const entry = s.bySession[sessionId];
		return entry?.agentActive === true || entry?.compacting === true;
	});
}

/**
 * 思考档位收拢点（模型弹层底部横条 + chip 上的档位后缀共用）：
 * - effective：draft 页读 draft 配置，真实会话 = 会话覆写 ?? 全局默认；
 * - supported：当前模型支持的档位（按 THINKING_LEVELS 顺序规范化；缺省 = 全量）；
 * - display：收敛到 supported 后的显示值（clamp 只作用于显示，不回写 store）。
 */
export function useThinkingLevelState(): {
	effective: string;
	supported: ThinkingLevel[];
	display: string;
} {
	const effective = useSessionsStore((s) => {
		const draft = s.activeSessionId === null ? s.newSessionDraft?.thinkingLevel : undefined;
		const session = s.sessions.find((x) => x.sessionId === s.activeSessionId);
		return draft ?? session?.thinkingLevel ?? s.lastUsedThinkingLevel;
	});
	// 直接取 store 里那个数组引用（稳定），过滤放到 useMemo：selector 返回新数组会触发死循环
	const declared = useActiveModelInfo()?.thinkingLevels;
	const supported = useMemo<ThinkingLevel[]>(() => {
		if (!declared || declared.length === 0) return [...THINKING_LEVELS];
		return THINKING_LEVELS.filter((level) => declared.includes(level));
	}, [declared]);
	return { effective, supported, display: clampThinkingLevel(effective, supported) };
}
