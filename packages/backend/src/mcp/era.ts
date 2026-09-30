/**
 * 协议世代（era）判定：MCP 两个世代并存，客户端必须 dual-era。
 *
 * 事实依据（规范 2026-07-28 changelog「Major changes」与 basic/versioning）：
 * - modern（≥2026-07-28）：**无握手、无会话**，每请求在 params._meta 携带
 *   `io.modelcontextprotocol/protocolVersion` + `clientCapabilities`；`server/discover` 必实现。
 * - legacy（≤2025-11-25）：`initialize` 握手 + `notifications/initialized`，Streamable HTTP 用
 *   `Mcp-Session-Id` 头维持会话。
 *
 * 探测规则（规范原文，两侧绑定各一套）：
 * - stdio：先发 `server/discover`；返回结果是 modern；返回「可识别的 modern 错误」也说明是 modern
 *   （按错误里 supported 列表换版本重试）；其余任何错误（含 -32601 方法不存在）→ legacy。
 * - Streamable HTTP：先发 modern 请求；`400` 且 body 是可识别的 modern 错误 → modern；
 *   `404` + `-32601` 说明端点存在但不认该方法，也算 modern 端点；无 JSON-RPC body 的 4xx → legacy。
 *
 * 本模块是纯函数集合（有测试），不做 IO。
 */

import type { McpEra, McpServerInfo } from "@percho/shared";
import type { JsonRpcErrorShape } from "./transport";

/** 本客户端实现的 modern 版本（唯一，按规范逐版本演进） */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * legacy 握手里我们「偏好」的版本。选 2025-06-18 而不是更新的 2025-11-25：生态实现率最高，
 * 且 legacy 服务器会在 initialize 结果里回它自己支持的版本，我们接受即可（无需重试）。
 */
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";

/**
 * 可识别的 modern 错误码（规范 basic/index 的错误码分配：-32020 HeaderMismatch、
 * -32021 MissingRequiredClientCapability、-32022 UnsupportedProtocolVersion）。
 * 用 Record 而非 Set：键集是编译期固定的常量表，成员判定只是查表。
 */
const MODERN_ERROR_CODES: Record<number, true> = { [-32020]: true, [-32021]: true, [-32022]: true };

export interface EraProbe {
	era: McpEra;
	/** 判定依据，写进日志与设置页诊断 */
	reason: string;
	/** modern 服务器在 UnsupportedProtocolVersionError 里给出的候选版本 */
	supportedVersions: string[];
}

/**
 * 从 JSON-RPC 错误判定：这是「modern 服务器」还是「legacy 服务器不认这个方法」。
 * 只有可识别的 modern 错误码才算 modern —— 规范明确 `-32601`（方法不存在）不足以判定，
 * 因为 legacy 服务器收到 `server/discover` 也会回 `-32601`。
 */
export function probeFromError(error: JsonRpcErrorShape, httpStatus?: number): EraProbe {
	if (MODERN_ERROR_CODES[error.code] === true) {
		return {
			era: "modern",
			reason: `modern error ${error.code}`,
			supportedVersions: readSupportedVersions(error.data),
		};
	}
	if (httpStatus === 400 && typeof error.data === "object" && error.data !== null) {
		// 400 + 结构化 data 但非已知码：仍视为 modern 端点（header mismatch 等），保守按 modern 继续
		return {
			era: "modern",
			reason: `HTTP 400 with JSON-RPC error body (code ${error.code})`,
			supportedVersions: readSupportedVersions(error.data),
		};
	}
	return { era: "legacy", reason: `unrecognized error ${error.code}`, supportedVersions: [] };
}

/** `UnsupportedProtocolVersionError.data.supported` 的容错读取（服务器可能给错形状） */
export function readSupportedVersions(data: unknown): string[] {
	if (typeof data !== "object" || data === null || !("supported" in data)) return [];
	const supported = data.supported;
	if (!Array.isArray(supported)) return [];
	return supported.filter((value): value is string => typeof value === "string");
}

/**
 * 在我们支持的版本里挑一个服务器也支持的。只有 2026-07-28 一个候选，因此要么原样返回要么 null
 * （null = 双方无交集，属于不可恢复的版本不兼容）。
 */
export function pickModernVersion(supported: string[]): string | null {
	return supported.includes(MODERN_PROTOCOL_VERSION) ? MODERN_PROTOCOL_VERSION : null;
}

/** 连接建立后的服务端自述（modern 来自 DiscoverResult，legacy 来自 InitializeResult） */
export interface ServerHandshake {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: McpServerInfo | null;
	instructions: string | null;
}

/** `serverInfo` 容错读取（title 可选；缺 name/version 时返回 null 而不是编造） */
export function readServerInfo(value: unknown): McpServerInfo | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("name" in value) || !("version" in value)) return null;
	const name = value.name;
	const version = value.version;
	if (typeof name !== "string" || typeof version !== "string") return null;
	if ("title" in value && typeof value.title === "string") return { name, version, title: value.title };
	return { name, version };
}

/** 能力面的人类可读清单（设置页展示用；只列出声明为对象的条目，空值不冒充能力） */
export function describeCapabilities(capabilities: Record<string, unknown>): string[] {
	return Object.keys(capabilities)
		.filter((key) => typeof capabilities[key] === "object" && capabilities[key] !== null)
		.sort();
}

/** 结果类型的向后兼容读取：规范要求「缺 resultType 的早期服务器结果一律当 complete」 */
export function readResultType(result: unknown): "complete" | "input_required" {
	if (
		typeof result === "object" &&
		result !== null &&
		"resultType" in result &&
		result.resultType === "input_required"
	) {
		return "input_required";
	}
	return "complete";
}

/** `CacheableResult.ttlMs`（modern 必填、legacy 无此字段）→ 缓存毫秒数；非法值回退默认 */
export function readTtlMs(result: unknown, fallbackMs: number): number {
	if (typeof result !== "object" || result === null || !("ttlMs" in result)) return fallbackMs;
	const ttl = result.ttlMs;
	return typeof ttl === "number" && Number.isFinite(ttl) && ttl >= 0 ? ttl : fallbackMs;
}
