/**
 * MCP 客户端：世代探测 + 请求生命周期 + 能力面（tools/resources/prompts）+ 通知分发。
 *
 * 职责边界：传输层只管帧（见 ./transport.ts），本文件管协议语义。两者由 registry 组装。
 *
 * 关键设计（每条都对应规范原文的坑）：
 * - **dual-era**：modern 无握手、每请求带 `_meta`；legacy 走 initialize + notifications/initialized。
 *   探测规则与回退见 ./era.ts。`forceEra` 用于「stdio 探针把 legacy 服务器弄挂了」后的重试，
 *   这是规范建议的确定性失败路径之外的必要兜底。
 * - **结果类型**：`resultType` 缺省按 complete 处理（规范要求兼容早期服务器，不得报错）。
 * - **MRTR**：`inputRequests` 是映射表（key = 服务器分配标识），`requestState` 不透明且必须原样
 *   回传（规范硬要求，客户端不得解析/修改）。本客户端只把请求原样交给上层，回放由上层带
 *   `inputResponses` + `requestState` 再调一次。
 * - **订阅**：modern 用 `subscriptions/listen`（长活响应流，`subscriptionId` 关联）；legacy 无此
 *   能力，退回 `notifications/*_list_changed` 被动失效缓存。列表缓存按 `ttlMs` 过期。
 * - **legacy 服务端反向请求**（sampling/roots/elicitation）：2026-07-28 已改为 MRTR。我们对
 *   legacy 的反向请求回 -32601 并记日志——不声明这些能力时回错误比假装成功更诚实。
 */

import type {
	McpCallResult,
	McpContentBlock,
	McpEra,
	McpInputRequest,
	McpPromptInfo,
	McpResourceInfo,
	McpServerInfo,
	McpToolInfo,
} from "@percho/shared";
import { createLogger } from "../log";
import {
	describeCapabilities,
	LEGACY_PROTOCOL_VERSION,
	MODERN_PROTOCOL_VERSION,
	pickModernVersion,
	probeFromError,
	readResultType,
	readServerInfo,
	readTtlMs,
	type ServerHandshake,
} from "./era";
import { asRecord, recordArray, recordObject, recordString } from "./json";
import {
	isRequest,
	isResponse,
	type JsonRpcErrorShape,
	type JsonRpcId,
	type JsonRpcRequest,
	type McpTransport,
	McpTransportError,
	type ServerMessage,
	type TransportDelivery,
} from "./transport";

const log = createLogger("mcp-client");

/** 客户端自述（写进 legacy initialize 与 modern `_meta`；服务器据此做兼容分流） */
const CLIENT_INFO = { name: "percho", version: "0.1.0" };

/** 列表缓存默认时长（服务器给 ttlMs 时以它为准；modern 规范要求列表结果带缓存提示） */
const DEFAULT_LIST_TTL_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** 分页上限：防止服务器给出环状 cursor 时无限翻页 */
const MAX_LIST_PAGES = 50;

/**
 * 我们声明的客户端能力。只声明 elicitation：语义是「客户端能向用户取信息」，本应用的实现路径
 * 是把服务器的取信息请求转述给模型/用户再回放原请求。sampling / roots 不声明也不实现，
 * 这样规范会阻止服务器发来我们处理不了的反向请求。
 */
const CLIENT_CAPABILITIES: Record<string, unknown> = { elicitation: {} };

/** 单个 JSON-RPC 请求的挂起记录 */
interface Pending {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	/** 结算时解绑外部 signal 的监听（不清会随每请求泄漏一个监听器） */
	cleanup?: () => void;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

/** 提示（prompts/get）的返回投影；内容按 type 分派，未知类型原样保留 */
export interface McpPromptResult {
	description: string | null;
	messages: Array<{ role: string; content: McpContentBlock[] }>;
	inputRequests?: McpInputRequest[];
	requestState?: string;
}

/** 服务器返回了 JSON-RPC 错误（区别于传输层失败：HTTP 状态码保留在 httpStatus） */
export class McpCallError extends Error {
	readonly code: number;
	readonly data: unknown;
	readonly httpStatus: number | undefined;

	constructor(error: JsonRpcErrorShape, httpStatus?: number) {
		super(`MCP error ${error.code}: ${error.message}`);
		this.name = "McpCallError";
		this.code = error.code;
		this.data = error.data;
		this.httpStatus = httpStatus;
	}
}

/** 内部信号：modern 探针判定对端是 legacy，需要回退 initialize */
class LegacyFallback extends Error {
	constructor(readonly reason: string) {
		super(`legacy server: ${reason}`);
		this.name = "LegacyFallback";
	}
}

export interface McpClientOptions {
	/** 服务器名（日志与诊断用，同时作为工具投影的 server 字段） */
	name: string;
	transport: McpTransport;
	/** 每次 HTTP 请求前取认证头（OAuth bearer 会刷新，不能在构造期固定）；返回 null = 无凭据 */
	authHeader?: () => Promise<string | null>;
	/** 需要重新授权（401）时回调：抽屉据此提示用户重新登录 */
	onUnauthorized?: (reason: string) => void;
	requestTimeoutMs?: number;
}

export class McpClient {
	private readonly pending = new Map<JsonRpcId, Pending>();
	private readonly unsubscribes: Array<() => void> = [];
	private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
	private readonly logHandlers = new Set<(line: string) => void>();
	private readonly fatalHandlers = new Set<(error: Error) => void>();
	private nextId = 1;
	private eraValue: McpEra | null = null;
	/**
	 * 当前是否按 modern 信封发请求（无握手，每请求带 `_meta`）。
	 * **探测期就必须为 true**：modern 服务器会校验「版本头声称 2026-07-28 ⇒ 请求必须带 `_meta`」，
	 * 拿 legacy 信封去探会被 400 `-32602 Invalid params: ... missing the required per-request
	 * envelope key(s): _meta` 直接拒掉（真服务器 context7 / Cloudflare docs 实测）。
	 * 所以这里不能用 `eraValue === "modern"`——那个标志要握手成功之后才置位。
	 */
	private modernEnvelope = false;
	private protocolVersionValue: string | null = null;
	private capabilitiesValue: Record<string, unknown> = {};
	private serverInfoValue: McpServerInfo | null = null;
	private instructionsValue: string | null = null;
	private toolsCache: CacheEntry<McpToolInfo[]> | null = null;
	private resourcesCache: CacheEntry<McpResourceInfo[]> | null = null;
	private promptsCache: CacheEntry<McpPromptInfo[]> | null = null;
	/** 致命失败后置位：后续请求立即 reject，避免在死连接上堆积超时 */
	private fatal: Error | null = null;
	private closed = false;

	constructor(private readonly options: McpClientOptions) {}

	get era(): McpEra | null {
		return this.eraValue;
	}

	get protocolVersion(): string | null {
		return this.protocolVersionValue;
	}

	get serverInfo(): McpServerInfo | null {
		return this.serverInfoValue;
	}

	get instructions(): string | null {
		return this.instructionsValue;
	}

	/** 能力面的人类可读清单（设置页展示） */
	get capabilityNames(): string[] {
		return describeCapabilities(this.capabilitiesValue);
	}

	/** 服务器是否声明了某项能力（决定代理工具给出哪些动作） */
	hasCapability(name: string): boolean {
		return typeof this.capabilitiesValue[name] === "object" && this.capabilitiesValue[name] !== null;
	}

	onNotification(handler: (method: string, params: unknown) => void): () => void {
		this.notificationHandlers.add(handler);
		return () => {
			this.notificationHandlers.delete(handler);
		};
	}

	/** 传输层旁路日志（stderr / HTTP 诊断）透出，供设置页日志面板 */
	onLog(handler: (line: string) => void): () => void {
		this.logHandlers.add(handler);
		return () => {
			this.logHandlers.delete(handler);
		};
	}

	/** 连接不可恢复失败（子进程退出、流中断、整体 HTTP 故障）；registry 据此改状态并决定是否重连 */
	onFatal(handler: (error: Error) => void): () => void {
		this.fatalHandlers.add(handler);
		return () => {
			this.fatalHandlers.delete(handler);
		};
	}

	/**
	 * 建连并完成世代握手。`forceEra` 跳过探测（stdio 探针弄挂 legacy 服务器后的重试路径）。
	 */
	async connect(options: { forceEra?: McpEra } = {}): Promise<ServerHandshake> {
		if (this.fatal) throw this.fatal;
		await this.options.transport.start();
		this.unsubscribes.push(
			this.options.transport.onMessage((delivery) => this.handleDelivery(delivery)),
			this.options.transport.onError((error) => this.handleTransportError(error)),
			this.options.transport.onLog((line) => {
				for (const handler of this.logHandlers) handler(line);
			}),
		);

		// HTTP+SSE 是 2024-11-05 的绑定，不存在 modern 形态，直接走 legacy 握手
		if (this.options.transport.kind === "http-sse" || options.forceEra === "legacy") {
			return this.handshakeLegacy();
		}
		try {
			return await this.handshakeModern();
		} catch (err) {
			// 探针把子进程弄挂：进程级失败原样抛出，交给 registry 用 forceEra:"legacy" 重试
			if (err instanceof McpTransportError) throw err;
			if (err instanceof LegacyFallback) {
				log.info("era probe: fall back to legacy", this.options.name, { reason: err.reason });
				return this.handshakeLegacy();
			}
			throw err;
		}
	}

	/** modern 探针：`server/discover` 是规范要求 modern 服务器必实现的方法，用它探测最省往返 */
	private async handshakeModern(): Promise<ServerHandshake> {
		// 探测请求本身也要是合规的 modern 请求（带 _meta），否则现代服务器 400 拒收
		this.modernEnvelope = true;
		let version = MODERN_PROTOCOL_VERSION;
		for (let attempt = 0; attempt < 2; attempt++) {
			this.protocolVersionValue = version;
			this.options.transport.setProtocolVersion(version);
			let result: unknown;
			try {
				result = await this.request("server/discover", {});
			} catch (err) {
				if (!(err instanceof McpCallError)) throw err;
				const probe = probeFromError(
					{ code: err.code, message: err.message, data: err.data },
					err.httpStatus,
				);
				if (probe.era === "legacy") throw new LegacyFallback(probe.reason);
				// modern 端点：服务器可能给出另一个它支持的版本（规范 UnsupportedProtocolVersionError）
				const next = pickModernVersion(probe.supportedVersions);
				if (next !== null && next !== version) {
					log.info("server prefers another modern version", this.options.name, { next });
					version = next;
					continue;
				}
				// 其余情况一律带上服务器原话：真实的拒绝原因常常不是「版本」，而是别的请求形状问题
				// （例如缺 _meta）。原来那句「rejected protocol version without offering alternatives」
				// 会把服务器给出的关键诊断吞掉，用户只能看到一条误导性的版本错误。
				throw new Error(
					`Modern MCP endpoint rejected server/discover (JSON-RPC ${err.code}${err.httpStatus === undefined ? "" : ` / HTTP ${err.httpStatus}`}): ${err.message}` +
						(probe.supportedVersions.length === 0
							? ""
							: ` [server supports: ${probe.supportedVersions.join(", ")}]`),
				);
			}
			this.eraValue = "modern";
			const handshake = this.readHandshake(result, version);
			log.info("connected (modern)", this.options.name, {
				protocolVersion: handshake.protocolVersion,
				capabilities: describeCapabilities(handshake.capabilities),
			});
			return handshake;
		}
		throw new Error("Protocol version negotiation failed");
	}

	private async handshakeLegacy(): Promise<ServerHandshake> {
		// legacy 信封：initialize 绝不能带 _meta（老服务器会当成未知参数）
		this.modernEnvelope = false;
		this.protocolVersionValue = LEGACY_PROTOCOL_VERSION;
		this.options.transport.setProtocolVersion(LEGACY_PROTOCOL_VERSION);
		const result = await this.request("initialize", {
			protocolVersion: LEGACY_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		const handshake = this.readHandshake(result, LEGACY_PROTOCOL_VERSION);
		this.eraValue = "legacy";
		// 协商到的版本可能与请求版本不同（legacy 服务器在结果里回自己支持的版本）
		this.protocolVersionValue = handshake.protocolVersion;
		this.options.transport.setProtocolVersion(handshake.protocolVersion);
		await this.notify("notifications/initialized", {});
		log.info("connected (legacy)", this.options.name, {
			protocolVersion: handshake.protocolVersion,
			capabilities: describeCapabilities(handshake.capabilities),
		});
		return handshake;
	}

	/** 从 modern DiscoverResult / legacy InitializeResult 读自述（两者字段名同构，容错读取） */
	private readHandshake(result: unknown, fallbackVersion: string): ServerHandshake {
		const handshake: ServerHandshake = {
			protocolVersion: recordString(result, "protocolVersion") ?? fallbackVersion,
			capabilities: recordObject(result, "capabilities") ?? {},
			serverInfo: readServerInfo(recordObject(result, "serverInfo") ?? null),
			instructions: recordString(result, "instructions") ?? null,
		};
		this.capabilitiesValue = handshake.capabilities;
		this.serverInfoValue = handshake.serverInfo;
		this.instructionsValue = handshake.instructions;
		return handshake;
	}

	async listTools(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<McpToolInfo[]> {
		const cached = this.readCache(this.toolsCache, options.force);
		if (cached) return cached;
		const { items, ttlMs } = await this.listAll("tools/list", "tools", options.signal);
		const tools = items.map((item): McpToolInfo => {
			const schema = asRecord(item);
			return {
				server: this.options.name,
				name: recordString(item, "name") ?? "",
				title: recordString(item, "title"),
				description: recordString(item, "description"),
				inputSchema: schema !== null && "inputSchema" in schema ? schema.inputSchema : undefined,
			};
		});
		this.toolsCache = { value: tools, expiresAt: Date.now() + ttlMs };
		return tools;
	}

	async listResources(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<McpResourceInfo[]> {
		const cached = this.readCache(this.resourcesCache, options.force);
		if (cached) return cached;
		const { items, ttlMs } = await this.listAll("resources/list", "resources", options.signal);
		const resources = items.map((item): McpResourceInfo => {
			return {
				server: this.options.name,
				uri: recordString(item, "uri") ?? "",
				name: recordString(item, "name"),
				title: recordString(item, "title"),
				description: recordString(item, "description"),
				mimeType: recordString(item, "mimeType"),
			};
		});
		this.resourcesCache = { value: resources, expiresAt: Date.now() + ttlMs };
		return resources;
	}

	async listPrompts(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<McpPromptInfo[]> {
		const cached = this.readCache(this.promptsCache, options.force);
		if (cached) return cached;
		const { items, ttlMs } = await this.listAll("prompts/list", "prompts", options.signal);
		const prompts = items.map((item): McpPromptInfo => {
			const record = asRecord(item);
			return {
				server: this.options.name,
				name: recordString(item, "name") ?? "",
				title: recordString(item, "title"),
				description: recordString(item, "description"),
				arguments: record !== null && "arguments" in record ? record.arguments : undefined,
			};
		});
		this.promptsCache = { value: prompts, expiresAt: Date.now() + ttlMs };
		return prompts;
	}

	/**
	 * 调用远端工具。`inputResponses` + `requestState` 是 MRTR 的回放凭据：上一个结果返回
	 * inputRequests 时，上层补齐后原样带回（requestState 不得改动）。
	 */
	async callTool(
		name: string,
		args: unknown,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<McpCallResult> {
		const params: Record<string, unknown> = { name, arguments: args ?? {} };
		if (options.inputResponses !== undefined) params.inputResponses = options.inputResponses;
		if (options.requestState !== undefined) params.requestState = options.requestState;
		return this.toCallResult(await this.request("tools/call", params, undefined, options.signal));
	}

	/** 读资源；返回内容块与可能的 MRTR 输入请求 */
	async readResource(
		uri: string,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<{ content: McpContentBlock[]; inputRequests?: McpInputRequest[]; requestState?: string }> {
		const params: Record<string, unknown> = { uri };
		if (options.inputResponses !== undefined) params.inputResponses = options.inputResponses;
		if (options.requestState !== undefined) params.requestState = options.requestState;
		const result = await this.request("resources/read", params, undefined, options.signal);
		return {
			content: toContentBlocks(recordArray(result, "contents")),
			...this.readInputRequired(result),
		};
	}

	/** 取提示；返回角色化消息与可能的 MRTR 输入请求 */
	async getPrompt(
		name: string,
		args: Record<string, unknown> | undefined,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<McpPromptResult> {
		const params: Record<string, unknown> = { name };
		if (args !== undefined) params.arguments = args;
		if (options.inputResponses !== undefined) params.inputResponses = options.inputResponses;
		if (options.requestState !== undefined) params.requestState = options.requestState;
		const result = await this.request("prompts/get", params, undefined, options.signal);
		const rawMessages = recordArray(result, "messages") ?? [];
		return {
			description: recordString(result, "description") ?? null,
			messages: rawMessages.map((message) => {
				const record = asRecord(message);
				const content = record === null ? undefined : record.content;
				return {
					role: recordString(message, "role") ?? "user",
					content: Array.isArray(content) ? toContentBlocks(content) : toContentBlocks([content]),
				};
			}),
			...this.readInputRequired(result),
		};
	}

	/**
	 * 开启变更通知订阅（modern 的 `subscriptions/listen`）。legacy 无此能力：返回 false，
	 * 调用方退回「列表按 ttl 过期」语义。
	 */
	async listen(options: { resourceSubscriptions?: string[] } = {}): Promise<boolean> {
		if (this.eraValue !== "modern") return false;
		const notifications: Record<string, unknown> = {
			toolsListChanged: true,
			promptsListChanged: true,
			resourcesListChanged: true,
		};
		if (options.resourceSubscriptions?.length) {
			notifications.resourceSubscriptions = options.resourceSubscriptions;
		}
		// 长活请求：不 await 结果（服务器只在优雅结束时才回响应），失败只影响订阅能力
		const id = this.allocateId();
		this.options.transport
			.send(this.buildRequest(id, "subscriptions/listen", { notifications }))
			.catch((err: unknown) => {
				log.warn("subscriptions/listen failed", this.options.name, err);
			});
		log.info("listening for change notifications", this.options.name, { id: String(id) });
		return true;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// 挂起请求按「连接已关闭」结算，不留悬挂 promise（dispose 语义要求）
		this.failPending(new Error("MCP client closed"));
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		this.notificationHandlers.clear();
		this.fatalHandlers.clear();
		await this.options.transport.close().catch((err: unknown) => {
			log.warn("transport close failed", this.options.name, err);
		});
	}

	/** 关闭日志订阅（close 之外单独清理时用） */
	clearLogHandlers(): void {
		this.logHandlers.clear();
	}

	// ---------------------------------------------------------------- 内部实现

	private readCache<T>(entry: CacheEntry<T> | null, force: boolean | undefined): T | null {
		if (force || entry === null || entry.expiresAt <= Date.now()) return null;
		return entry.value;
	}

	/** 分页拉取列表（cursor/nextCursor），返回条目与 TTL（modern 结果带 ttlMs） */
	private async listAll(
		method: string,
		key: string,
		signal?: AbortSignal,
	): Promise<{ items: unknown[]; ttlMs: number }> {
		const items: unknown[] = [];
		let cursor: string | undefined;
		let ttlMs = DEFAULT_LIST_TTL_MS;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const result = await this.request(method, cursor === undefined ? {} : { cursor }, undefined, signal);
			const page_items = recordArray(result, key);
			if (page_items) items.push(...page_items);
			ttlMs = readTtlMs(result, ttlMs);
			const next = recordString(result, "nextCursor");
			if (next === undefined || next === "") break;
			cursor = next;
		}
		return { items, ttlMs };
	}

	/** `resultType: "input_required"` 的投影（requestState 原样透传） */
	private readInputRequired(result: unknown): {
		inputRequests?: McpInputRequest[];
		requestState?: string;
	} {
		if (readResultType(result) !== "input_required") return {};
		const out: { inputRequests?: McpInputRequest[]; requestState?: string } = {};
		const requests = recordObject(result, "inputRequests");
		if (requests) {
			// 规范是映射表：key = 服务器分配标识，value = { method, params }
			out.inputRequests = Object.entries(requests).map(([id, value]) => ({
				id,
				method: recordString(value, "method") ?? "unknown",
				params: recordObject(value, "params") ?? {},
			}));
		}
		const requestState = recordString(result, "requestState");
		if (requestState !== undefined) out.requestState = requestState;
		return out;
	}

	private toCallResult(result: unknown): McpCallResult {
		const record = asRecord(result);
		const out: McpCallResult = {
			isError: record !== null && record.isError === true,
			content: toContentBlocks(recordArray(result, "content")),
			...this.readInputRequired(result),
		};
		if (record !== null && "structuredContent" in record) out.structured = record.structuredContent;
		return out;
	}

	private handleDelivery(delivery: TransportDelivery): void {
		const message: ServerMessage = delivery.message;
		if (isResponse(message)) {
			// 关联顺序：绑定层认定的归属 id（HTTP 传输知道自己发的是哪条请求）优先于 body 里的 id。
			// 真服务器在 400 上会回 `id: null` 或自造 id，只认 body 会让请求一直挂到超时。
			const id = delivery.requestId ?? message.id;
			if (id === undefined) {
				log.debug("response without id", this.options.name);
				return;
			}
			const pending = this.pending.get(id);
			if (!pending) {
				log.debug("response for unknown id", this.options.name, { id: String(id) });
				return;
			}
			this.settle(id, pending);
			if ("error" in message && message.error) {
				pending.reject(new McpCallError(message.error, delivery.httpStatus));
			} else if ("result" in message) {
				pending.resolve(message.result);
			} else {
				pending.reject(new Error("Malformed JSON-RPC response (neither result nor error)"));
			}
			return;
		}
		if (isRequest(message)) {
			// legacy 服务端反向请求：不声明这些能力，回 -32601 让它快速失败而不是挂住
			void this.rejectServerRequest(message);
			return;
		}
		this.handleNotification(message.method, message.params);
	}

	private async rejectServerRequest(request: JsonRpcRequest): Promise<void> {
		log.info("rejecting server-initiated request", this.options.name, { method: request.method });
		await this.options.transport
			.send({
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32601,
					message: `Client does not support server-initiated ${request.method} (use MRTR inputRequests instead)`,
				},
			})
			.catch((err: unknown) => {
				log.warn("failed to reject server request", this.options.name, err);
			});
	}

	private handleNotification(method: string, params: unknown): void {
		// 列表变更通知：失效对应缓存，让下一次读取拿到新数据
		if (method === "notifications/tools/list_changed") this.toolsCache = null;
		else if (method === "notifications/resources/list_changed") this.resourcesCache = null;
		else if (method === "notifications/prompts/list_changed") this.promptsCache = null;
		for (const handler of this.notificationHandlers) {
			try {
				handler(method, params);
			} catch (err) {
				log.warn("notification handler failed", this.options.name, err);
			}
		}
	}

	private handleTransportError(error: McpTransportError): void {
		if (error.requestId !== undefined && this.pending.has(error.requestId)) {
			// 单请求失败（401/400/超时）：只结算该请求，连接本身可能仍然健康
			const pending = this.pending.get(error.requestId);
			if (pending) {
				this.settle(error.requestId, pending);
				pending.reject(error);
			}
			if (error.status === 401) this.options.onUnauthorized?.(error.message);
			return;
		}
		this.fatal = error;
		this.failPending(error);
		for (const handler of this.fatalHandlers) {
			try {
				handler(error);
			} catch (err) {
				log.warn("fatal handler failed", this.options.name, err);
			}
		}
	}

	private failPending(error: Error): void {
		for (const [id, pending] of [...this.pending]) {
			this.settle(id, pending);
			pending.reject(error);
		}
	}

	private settle(id: JsonRpcId, pending: Pending): void {
		clearTimeout(pending.timer);
		pending.cleanup?.();
		this.pending.delete(id);
	}

	private allocateId(): JsonRpcId {
		return this.nextId++;
	}

	/** modern 的每请求元数据（规范：所有请求都要带版本/能力/身份，无握手） */
	private meta(): Record<string, unknown> {
		return {
			"io.modelcontextprotocol/protocolVersion": this.protocolVersionValue ?? MODERN_PROTOCOL_VERSION,
			"io.modelcontextprotocol/clientCapabilities": CLIENT_CAPABILITIES,
			"io.modelcontextprotocol/clientInfo": CLIENT_INFO,
		};
	}

	private buildRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): JsonRpcRequest {
		const merged = this.modernEnvelope ? { ...params, _meta: this.meta() } : params;
		return { jsonrpc: "2.0", id, method, params: merged };
	}

	private async applyAuthHeaders(): Promise<void> {
		if (!this.options.authHeader) return;
		try {
			const header = await this.options.authHeader();
			this.options.transport.setAuthHeaders(header === null ? {} : { authorization: header });
		} catch (err) {
			log.warn("failed to resolve auth header", this.options.name, err);
			this.options.transport.setAuthHeaders({});
		}
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		if (this.fatal) throw this.fatal;
		await this.applyAuthHeaders();
		const merged = this.modernEnvelope ? { ...params, _meta: this.meta() } : params;
		await this.options.transport.send({ jsonrpc: "2.0", method, params: merged });
	}

	/**
	 * 发请求等结果；超时/主动中止/传输失败/JSON-RPC 错误抛不同错误类型以便上层区分。
	 * `signal` 中止 = 用户按了停止：既要结算本地挂起，也要通知传输层取消（stdio 发
	 * notifications/cancelled，HTTP 关流），否则服务器会在我们不再等结果的情况下白算一遍。
	 */
	private async request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.fatal) throw this.fatal;
		const id = this.allocateId();
		const pending: Pending = { resolve: () => {}, reject: () => {} };
		const promise = new Promise<unknown>((resolve, reject) => {
			pending.resolve = resolve;
			pending.reject = reject;
			pending.timer = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.settle(id, pending);
				void this.options.transport.cancel(id).catch(() => {});
				reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.timer.unref();
			// 先登记再挂 abort：signal 已中止时同步回调会立刻按挂起结算
			this.pending.set(id, pending);
			if (signal) {
				const onAbort = () => {
					if (!this.pending.has(id)) return;
					this.settle(id, pending);
					void this.options.transport.cancel(id).catch(() => {});
					reject(new Error(`Request ${method} aborted`));
				};
				pending.cleanup = () => signal.removeEventListener("abort", onAbort);
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		try {
			await this.applyAuthHeaders();
			await this.options.transport.send(this.buildRequest(id, method, params));
		} catch (err) {
			const stuck = this.pending.get(id);
			if (stuck) this.settle(id, stuck);
			throw err;
		}
		return promise;
	}
}

/** 把线上 content/contents 归一化为内容块数组；未知 type 原样保留（规范允许扩展类型） */
function toContentBlocks(raw: unknown): McpContentBlock[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(item): item is McpContentBlock => typeof item === "object" && item !== null && "type" in item,
	);
}
