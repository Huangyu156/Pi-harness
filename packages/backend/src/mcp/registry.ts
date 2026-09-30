/**
 * MCP 连接生命周期：懒连接、并发去重、失败退避、空闲回收、日志环形缓冲 + 限流。
 *
 * 为什么单独一层：client 只管一条连接的协议语义，registry 管「什么时候有连接、什么时候关」。
 * 重连策略集中在这里，避免 client 与传输层各有一套退避（两套退避 = 无法预测的重连风暴）。
 *
 * 限流的依据：仓库有过「3 分钟写 12.7GB」的日志/事件放大事故（docs/PITFALLS.md:78-88）。
 * MCP 服务器的 stderr 可能非常吵，因此这里对行数（环形缓冲）与事件推送（200ms 合帧）双重设限。
 */

import type { McpConnectionState, McpEra, McpServerInfo, McpTestResult, McpToolInfo } from "@percho/shared";
import { createLogger } from "../log";
import { McpClient } from "./client";
import type { ResolvedMcpServer } from "./config";
import { createTransport } from "./transports";

const log = createLogger("mcp-registry");

/** 每服务器日志环形缓冲上限 */
const MAX_LOG_LINES = 500;
/** 单行截断（服务器可能把整个堆栈打成一行） */
const MAX_LOG_LINE_CHARS = 2000;
/** 日志事件合帧窗口与每帧上限（超出丢弃并留一条省略标记） */
const LOG_FLUSH_MS = 200;
const LOG_FLUSH_MAX = 50;
/** 空闲回收扫描间隔 */
const IDLE_SWEEP_MS = 30_000;
/** 连接失败后的最短重试间隔（避免在坏配置上疯狂重连） */
const FAILED_RETRY_MS = 3_000;

interface LogEntry {
	seq: number;
	line: string;
}

/** 单个服务器的运行时状态（UI 视图的状态部分） */
export interface McpRuntimeState {
	state: McpConnectionState;
	era: McpEra | null;
	protocolVersion: string | null;
	serverInfo: McpServerInfo | null;
	toolCount: number | null;
	lastError: string | null;
	lastUsedAt: number;
}

interface Entry {
	client: McpClient | null;
	/** 进行中的连接（并发去重：同时多个调用只会建一条连接） */
	connecting: Promise<McpClient> | null;
	/**
	 * 配置世代：drop/改配置时自增，用来作废「还在建连的那次」。否则 drop 之后完成的连接会
	 * 把 client 装回条目（且此后再没人关它——配置已删，空闲回收也找不回它）。
	 */
	generation: number;
	state: McpRuntimeState;
	logs: LogEntry[];
	logSeq: number;
	pendingLogs: string[];
	flushTimer: NodeJS.Timeout | null;
	failedAt: number;
}

export interface McpRegistryDeps {
	/** 取当前配置（每次连接时读，保证改配置后立即生效） */
	resolve: (name: string) => ResolvedMcpServer | undefined;
	/** OAuth bearer 提供者；返回 null = 无凭据 */
	authHeader?: (name: string) => Promise<string | null>;
	/** 状态/日志事件出口（service 把 status 事件补全为完整视图后转 IPC） */
	onEvent: (event: McpRegistryEvent) => void;
	/** 注入以便测试与替换实现 */
	transportFactory?: typeof createTransport;
}

/**
 * registry 只发出「谁变了」与「哪一行日志」，不组装跨进程视图——
 * McpServerView 需要配置 + 凭据状态（service 才有），放在 registry 会造出半成品载荷。
 */
export type McpRegistryEvent =
	| { kind: "status"; server: string }
	| { kind: "log"; server: string; line: string };

/** 事件同一性：状态视图变化时才推送，避免无意义刷新 */
function sameRuntime(a: McpRuntimeState, b: McpRuntimeState): boolean {
	return (
		a.state === b.state &&
		a.era === b.era &&
		a.protocolVersion === b.protocolVersion &&
		a.lastError === b.lastError &&
		a.toolCount === b.toolCount &&
		a.serverInfo?.name === b.serverInfo?.name &&
		a.serverInfo?.version === b.serverInfo?.version
	);
}

export class McpRegistry {
	private readonly entries = new Map<string, Entry>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private disposed = false;

	constructor(private readonly deps: McpRegistryDeps) {}

	/** 运行时状态快照（不存在则按配置给出初始态） */
	runtimeState(name: string): McpRuntimeState {
		return this.entries.get(name)?.state ?? emptyState();
	}

	/** 已建立连接的客户端（不存在则 null）；工具层用它判断某服务器当前是否可用 */
	peek(name: string): McpClient | null {
		return this.entries.get(name)?.client ?? null;
	}

	/**
	 * 取得（必要时建立）某服务器的客户端。
	 * 并发去重、失败退避、懒连接语义都在这里；配置禁用或缺失时抛可读错误。
	 */
	async ensureClient(name: string): Promise<McpClient> {
		if (this.disposed) throw new Error("MCP registry disposed");
		const resolved = this.deps.resolve(name);
		if (!resolved) throw new Error(`Unknown MCP server "${name}"`);
		if (resolved.config.disabled) throw new Error(`MCP server "${name}" is disabled`);

		const entry = this.entry(name);
		if (entry.client) {
			entry.state.lastUsedAt = Date.now();
			return entry.client;
		}
		if (entry.connecting) return entry.connecting;
		if (Date.now() - entry.failedAt < FAILED_RETRY_MS && entry.state.lastError !== null) {
			throw new Error(entry.state.lastError);
		}

		const connecting = this.connect(name, resolved, entry);
		entry.connecting = connecting;
		// 只清理「自己那一份」：drop 会把 connecting 置空，此后可能有新的建连占位
		const clearConnecting = (): void => {
			if (entry.connecting === connecting) entry.connecting = null;
		};
		void connecting.then(clearConnecting, clearConnecting);
		return connecting;
	}

	private async connect(name: string, resolved: ResolvedMcpServer, entry: Entry): Promise<McpClient> {
		this.patch(name, entry, { state: "connecting", lastError: null });
		const generation = entry.generation;
		const transport = (this.deps.transportFactory ?? createTransport)(resolved.transportOptions);
		const client = new McpClient({
			name,
			transport,
			authHeader: this.authHeaderFor(name),
			onUnauthorized: (reason) => {
				this.patch(name, entry, { lastError: `Authorization required: ${reason}` });
			},
		});
		client.onLog((line) => this.pushLog(name, entry, line));
		client.onFatal((error) => {
			// 连接已死：丢弃 client，状态置 error；下次 ensureClient 会重新建连
			entry.client = null;
			this.patch(name, entry, { state: "error", lastError: error.message, toolCount: null });
			log.warn("connection lost", name, error.message);
		});

		try {
			const handshake = await client.connect();
			if (generation !== entry.generation) {
				// drop/改配置发生在建连过程中：这条连接已经没有任何人认领，直接关掉并如实报错
				await client.close().catch(() => {});
				throw new Error(`Connection to MCP server "${name}" superseded by a configuration change`);
			}
			entry.client = client;
			this.patch(name, entry, {
				state: "ready",
				era: client.era,
				protocolVersion: handshake.protocolVersion,
				serverInfo: handshake.serverInfo,
				lastError: null,
			});
			this.ensureSweeper();
			// 后台拉一次工具数（失败不影响连接可用性），并尝试订阅变更通知
			void this.refreshToolCount(name, client, entry);
			void client.listen().catch(() => {});
			return client;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// stdio 探针可能把 legacy 服务器弄挂：用 forceEra 重试一次（规范建议的确定性问题）
			const retried = await this.retryAsLegacy(name, resolved, entry, client, message, generation);
			if (retried) return retried;
			await client.close().catch(() => {});
			if (generation !== entry.generation) {
				// 已 drop/改配置：不要把它记成本次配置的错误状态（下次连接会重新判断）
				throw new Error(`Connection to MCP server "${name}" superseded by a configuration change`);
			}
			entry.failedAt = Date.now();
			this.patch(name, entry, { state: "error", lastError: message });
			log.warn("connect failed", name, message);
			throw err instanceof Error ? err : new Error(message);
		}
	}

	/**
	 * 探测阶段进程级失败 → 换新传输用 legacy 握手重试一次（避免在 legacy 服务器上误判为不可用）。
	 * `generation` 是发起本次建连时的世代：期间发生过 drop/改配置就不再重试——重试出来的连接同样
	 * 无人认领，白起一个子进程（冒烟日志里表现为「删了服务器后还在 spawn」）。
	 */
	private async retryAsLegacy(
		name: string,
		resolved: ResolvedMcpServer,
		entry: Entry,
		failed: McpClient,
		reason: string,
		generation: number,
	): Promise<McpClient | null> {
		if (resolved.transportOptions.kind !== "stdio") return null;
		if (generation !== entry.generation) return null;
		log.info("retrying handshake as legacy", name, { reason });
		await failed.close().catch(() => {});
		const transport = (this.deps.transportFactory ?? createTransport)(resolved.transportOptions);
		const client = new McpClient({
			name,
			transport,
			authHeader: this.authHeaderFor(name),
		});
		client.onLog((line) => this.pushLog(name, entry, line));
		client.onFatal((error) => {
			entry.client = null;
			this.patch(name, entry, { state: "error", lastError: error.message, toolCount: null });
		});
		try {
			const handshake = await client.connect({ forceEra: "legacy" });
			if (generation !== entry.generation) {
				await client.close().catch(() => {});
				return null;
			}
			entry.client = client;
			this.patch(name, entry, {
				state: "ready",
				era: client.era,
				protocolVersion: handshake.protocolVersion,
				serverInfo: handshake.serverInfo,
				lastError: null,
			});
			this.ensureSweeper();
			void this.refreshToolCount(name, client, entry);
			return client;
		} catch (err) {
			log.warn("legacy retry failed", name, err instanceof Error ? err.message : String(err));
			await client.close().catch(() => {});
			return null;
		}
	}

	private async refreshToolCount(name: string, client: McpClient, entry: Entry): Promise<void> {
		try {
			const tools: McpToolInfo[] = await client.listTools();
			this.patch(name, entry, { toolCount: tools.length });
		} catch (err) {
			log.debug("tool count unavailable", name, err instanceof Error ? err.message : String(err));
		}
	}

	/** 连接自检：建连 + 能力清点 + 耗时，返回给设置页展示 */
	async test(name: string): Promise<McpTestResult> {
		const started = Date.now();
		const resolved = this.deps.resolve(name);
		const entry = this.entry(name);
		const base = { logs: this.recentLogs(name) };
		if (!resolved) {
			return {
				ok: false,
				era: null,
				protocolVersion: null,
				serverInfo: null,
				toolCount: 0,
				resourceCount: 0,
				promptCount: 0,
				capabilities: [],
				durationMs: 0,
				error: `Unknown MCP server "${name}"`,
				...base,
			};
		}
		try {
			const client = await this.ensureClient(name);
			const capabilities = client.capabilityNames;
			const [tools, resources, prompts] = await Promise.all([
				client.hasCapability("tools") ? client.listTools({ force: true }) : Promise.resolve([]),
				client.hasCapability("resources") ? client.listResources({ force: true }) : Promise.resolve([]),
				client.hasCapability("prompts") ? client.listPrompts({ force: true }) : Promise.resolve([]),
			]);
			this.patch(name, entry, { toolCount: tools.length });
			return {
				ok: true,
				era: client.era,
				protocolVersion: client.protocolVersion,
				serverInfo: client.serverInfo,
				toolCount: tools.length,
				resourceCount: resources.length,
				promptCount: prompts.length,
				capabilities,
				durationMs: Date.now() - started,
				error: null,
				logs: this.recentLogs(name),
			};
		} catch (err) {
			return {
				ok: false,
				era: entry.state.era,
				protocolVersion: entry.state.protocolVersion,
				serverInfo: null,
				toolCount: 0,
				resourceCount: 0,
				promptCount: 0,
				capabilities: [],
				durationMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
				...base,
			};
		}
	}

	/** 明确的能力清点（供 test 之外的调用点复用，如设置页刷新） */
	capabilitiesOf(name: string): string[] {
		const client = this.peek(name);
		return client === null ? [] : client.capabilityNames;
	}

	/** 断开并遗忘某服务器的连接（改配置/停用/删除后调用） */
	async drop(name: string): Promise<void> {
		const entry = this.entries.get(name);
		if (!entry) return;
		// 先作废在途建连：它完成后会把 client 装回条目，而配置已变/已删，此后再没人关它。
		// connecting 也要置空——否则后续 ensureClient 会把「已被作废的那次」当成并发去重的目标，
		// 直接继承它的失败（表现为配置刚改完就报 superseded）
		entry.generation += 1;
		entry.connecting = null;
		const client = entry.client;
		entry.client = null;
		this.patch(name, entry, {
			state: "idle",
			era: null,
			protocolVersion: null,
			serverInfo: null,
			toolCount: null,
			lastError: null,
		});
		await client?.close().catch((err: unknown) => {
			log.warn("drop failed", name, err);
		});
	}

	/** 丢弃全部连接（reload：证书/配置变化后重建） */
	async reload(): Promise<void> {
		for (const name of [...this.entries.keys()]) await this.drop(name);
	}

	/** 读日志分页：cursor 是单调递增序号（0 = 从头） */
	readLog(name: string, cursor = 0): { lines: string[]; cursor: number } {
		const entry = this.entries.get(name);
		if (!entry) return { lines: [], cursor: 0 };
		const lines = entry.logs.filter((item) => item.seq > cursor).map((item) => item.line);
		return { lines, cursor: entry.logSeq };
	}

	private recentLogs(name: string): string[] {
		const entry = this.entries.get(name);
		return entry ? entry.logs.slice(-20).map((item) => item.line) : [];
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		for (const entry of this.entries.values()) {
			if (entry.flushTimer) {
				clearTimeout(entry.flushTimer);
				entry.flushTimer = null;
			}
		}
		await Promise.all([...this.entries.values()].map((entry) => entry.client?.close() ?? Promise.resolve()));
		this.entries.clear();
		log.info("registry disposed");
	}

	// ---------------------------------------------------------------- 内部

	/**
	 * 认证头解析闭包（凭据每次请求前实时取，token 会刷新所以不能在构造期固定）。
	 * 这里不用非空断言：把可选依赖收进一个局部变量，闭包里就是已收窄的类型。
	 */
	private authHeaderFor(name: string): (() => Promise<string | null>) | undefined {
		const resolveAuth = this.deps.authHeader;
		if (resolveAuth === undefined) return undefined;
		return () => resolveAuth(name);
	}

	private entry(name: string): Entry {
		let entry = this.entries.get(name);
		if (!entry) {
			entry = {
				client: null,
				connecting: null,
				generation: 0,
				state: emptyState(),
				logs: [],
				logSeq: 0,
				pendingLogs: [],
				flushTimer: null,
				failedAt: 0,
			};
			this.entries.set(name, entry);
		}
		return entry;
	}

	private patch(name: string, entry: Entry, patch: Partial<McpRuntimeState>): void {
		const next = { ...entry.state, ...patch };
		const changed = !sameRuntime(entry.state, next);
		entry.state = next;
		if (changed) this.deps.onEvent({ kind: "status", server: name });
	}

	/** 日志入环形缓冲；事件按 200ms 合帧推送（防日志放大） */
	private pushLog(name: string, entry: Entry, rawLine: string): void {
		const line = rawLine.length > MAX_LOG_LINE_CHARS ? `${rawLine.slice(0, MAX_LOG_LINE_CHARS)}…` : rawLine;
		entry.logs.push({ seq: ++entry.logSeq, line });
		if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
		entry.pendingLogs.push(line);
		if (entry.flushTimer) return;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			const batch = entry.pendingLogs.splice(0);
			const kept = batch.slice(0, LOG_FLUSH_MAX);
			if (batch.length > kept.length) kept.push(`… ${batch.length - kept.length} more lines suppressed`);
			for (const item of kept) this.deps.onEvent({ kind: "log", server: name, line: item });
		}, LOG_FLUSH_MS);
		entry.flushTimer.unref();
	}

	/** 空闲回收扫描（单个 unref 定时器，避免每服务器一个定时器） */
	private ensureSweeper(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => {
			void this.sweepIdle();
		}, IDLE_SWEEP_MS);
		this.sweepTimer.unref();
	}

	private async sweepIdle(): Promise<void> {
		const now = Date.now();
		for (const [name, entry] of this.entries) {
			if (!entry.client) continue;
			const resolved = this.deps.resolve(name);
			if (!resolved) {
				// 配置已被删（手动改文件/外部删除）：没人会再认领这条连接，扫到就收掉
				log.info("closing connection of a removed server", name);
				await this.drop(name);
				continue;
			}
			const idleMs = resolved.percho.idleTimeoutMs;
			if (idleMs <= 0) continue;
			if (now - entry.state.lastUsedAt < idleMs) continue;
			log.info("closing idle connection", name, { idleMs });
			await this.drop(name);
		}
	}
}

function emptyState(): McpRuntimeState {
	return {
		state: "idle",
		era: null,
		protocolVersion: null,
		serverInfo: null,
		toolCount: null,
		lastError: null,
		lastUsedAt: Date.now(),
	};
}
