import { isThinkingLevel } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { clampThinkingLevel, THINKING_LEVELS, thinkingLevelKey, thinkingLevelPos } from "./thinking";

describe("thinking 档位（shared 白名单 + renderer 收敛）", () => {
	it("白名单恰为 7 档，非法值一律拒绝", () => {
		expect(THINKING_LEVELS).toHaveLength(7);
		for (const level of THINKING_LEVELS) expect(isThinkingLevel(level)).toBe(true);
		expect(isThinkingLevel("ultra")).toBe(false);
		expect(isThinkingLevel("")).toBe(false);
		expect(isThinkingLevel(undefined)).toBe(false);
		expect(isThinkingLevel(3)).toBe(false);
	});

	it("clampThinkingLevel 就近向上 + supported 末位回退（仅 renderer UI 用；backend 交 SDK clamp）", () => {
		expect(clampThinkingLevel("medium", ["low", "medium", "high"])).toBe("medium");
		expect(clampThinkingLevel("high", ["low", "xhigh"])).toBe("xhigh");
		expect(clampThinkingLevel("max", ["off", "low"])).toBe("low");
		expect(clampThinkingLevel("ultra", ["low", "high"])).toBe("high");
		expect(clampThinkingLevel("high", [])).toBe("high");
	});

	it("thinkingLevelPos：刻度/填充/滑块共用的归一化位置（0..1，端点对齐）", () => {
		// 7 档：0 / 1/6 / 1 —— 中档位落在正中间
		expect(thinkingLevelPos(0, 7)).toBe(0);
		expect(thinkingLevelPos(1, 7)).toBeCloseTo(1 / 6);
		expect(thinkingLevelPos(3, 7)).toBe(0.5);
		expect(thinkingLevelPos(6, 7)).toBe(1);
		// 档位不连号也一样按「有几档铺几颗」均分（deepseek-v4-pro 只有 关闭/高/最大）
		expect(thinkingLevelPos(1, 3)).toBe(0.5);
		// 越界按端点夹紧；只有一档（非推理模型）= 恒 0，不给可拖的把手
		expect(thinkingLevelPos(-1, 5)).toBe(0);
		expect(thinkingLevelPos(99, 5)).toBe(1);
		expect(thinkingLevelPos(0, 1)).toBe(0);
		expect(thinkingLevelPos(0, 0)).toBe(0);
	});

	it("thinkingLevelKey：脏值回落 medium（不至于因后端脏值渲染出 undefined）", () => {
		expect(thinkingLevelKey("xhigh")).toBe("thinkingLevels.xhigh");
		expect(thinkingLevelKey("ultra")).toBe("thinkingLevels.medium");
		expect(thinkingLevelKey("")).toBe("thinkingLevels.medium");
	});
});
