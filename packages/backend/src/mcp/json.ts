/**
 * MCP 线上 JSON 的收窄工具。
 *
 * 线上数据（服务器 stdout / HTTP body / 配置导入）形状由对端决定，本仓纪律是 `unknown` + 收窄，
 * 不用内联 `as {}` 断言后直接取成员。这里只提供一个有理由的边界断言：`typeof` 已确认是对象，
 * 但 TS 无法从 `object` 推出索引签名，故用一次 `as`（见下）。
 */

/**
 * 把未知值收窄为可按字符串索引的对象视图（不复制；数组与 null 返回 null）。
 *
 * `as` 是边界断言且带理由：`typeof value === "object" && !Array.isArray` 已确认它是普通对象，
 * 但 TypeScript 的 `object` 类型没有索引签名，无法直接按键读取成员。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** 从记录里读字符串字段（错形状一律 undefined，不抛） */
export function recordString(value: unknown, key: string): string | undefined {
	const record = asRecord(value);
	if (record === null) return undefined;
	const field = record[key];
	return typeof field === "string" ? field : undefined;
}

/** 从记录里读数组字段 */
export function recordArray(value: unknown, key: string): unknown[] | undefined {
	const record = asRecord(value);
	if (record === null) return undefined;
	const field = record[key];
	return Array.isArray(field) ? field : undefined;
}

/** 从记录里读嵌套对象字段 */
export function recordObject(value: unknown, key: string): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (record === null) return undefined;
	return asRecord(record[key]) ?? undefined;
}
