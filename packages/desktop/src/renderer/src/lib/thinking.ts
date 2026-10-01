import { THINKING_LEVELS } from "@percho/shared";

export { THINKING_LEVELS, type ThinkingLevel } from "@percho/shared";

/** 思考条滑块/刻度共用的直径（px），也是轨道高度（见 globals.css .think-slider 处注释） */
export const THINKING_BAR_KNOB = 26;

/** 脏值（不在 THINKING_LEVELS 里）判为非法档位 */
export function isThinkingLevel(value: string): value is (typeof THINKING_LEVELS)[number] {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** 档位名对应的 i18n key（脏值回落 medium，与旧 ThinkingPicker 行为一致） */
export function thinkingLevelKey(level: string): `thinkingLevels.${(typeof THINKING_LEVELS)[number]}` {
	return `thinkingLevels.${isThinkingLevel(level) ? level : "medium"}`;
}

/**
 * 第 index 档在思考条上的归一化位置（0 = 最左端刻度，1 = 最右端刻度）。
 *
 * 刻度中心 x = 填充宽 = 滑块中心 = `calc((100% - 26px) * pos + 13px)`：滑块直径 = 轨道高度，
 * 滑块走到两端时左右各占半个滑块，所以刻度也得跟着内缩 13px，否则首尾刻度会被滑块盖偏或顶出条外。
 * count <= 1（非推理模型只给 off）时恒为 0，index 越界按端点夹紧。
 */
export function thinkingLevelPos(index: number, count: number): number {
	if (count <= 1) return 0;
	const clamped = Math.min(Math.max(index, 0), count - 1);
	return clamped / (count - 1);
}

/**
 * 将当前档位收敛到模型支持的档位集合：
 *   1. 若 supported 已包含 level，直接返回；
 *   2. 否则在 THINKING_LEVELS 顺序里找第一个 >= level 的（就近向上）；
 *   3. 都没有（所有 supported 都比 level 小）则取 supported 中最高档；
 *   4. supported 为空时返回原 level（调用方应保证 supported 非空）；
 *   5. level 不在 THINKING_LEVELS 中（脏数据）时按步骤 3 取 supported 最高档。
 *
 * 注意：与 SDK clampThinkingLevel 的「反向就近降级」策略不同；这里是「就近向上 +
 * supported 末位回退」。supported 应保证按 THINKING_LEVELS 顺序传入（当前由后端
 * getSupportedThinkingLevels 通过 THINKING_LEVELS 过滤保证）。
 * 仅 renderer UI（模型选择器）使用；backend 不做收敛、也不 import 本函数（spec R4）。
 */
export function clampThinkingLevel(level: string, supported: readonly string[]): string {
	if (supported.length === 0) return level;
	if (supported.includes(level)) return level;
	const order = THINKING_LEVELS as readonly string[];
	const currentIdx = order.indexOf(level);
	if (currentIdx === -1) {
		return supported.at(-1) as string;
	}
	for (let i = currentIdx + 1; i < order.length; i++) {
		const candidate = order[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return supported.at(-1) as string;
}
