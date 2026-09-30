/**
 * MCP 服务层（MCP 域对内唯一门面）：配置读写 + 连接生命周期 + 凭据/OAuth + 宿主导入。
 *
 * 分层：`config.ts`（配置）→ `registry.ts`（什么时候有连接）→ `client.ts`（协议语义）→
 * `transports/*`（帧）。本文件只做组装与用例：把 registry 的运行时状态 + 凭据状态拼成
 * 跨进程视图（McpServerView），把配置写操作收敛到单一入口（写后失效缓存 + 广播 changed）。
 *
 * 配置读带 2s TTL：MCP 生态惯例是用户直接手改 `mcp.json`（编辑器里改完即生效），TTL 让手改
 * 在 2s 内可见；本服务自己的写操作显式失效缓存，不等 TTL。同时 TTL 避免列表/状态这类高频
 * IPC 每次都读盘。
 *
 * 凭据边界（硬性）：本文件是唯一同时接触「配置」与「凭据」的地方，跨进程视图只下发
 * `secretKeys`（键名）与 `hasOAuthToken`（布尔），值永不出 backend。
 */

import { existsSync } from "node:fs";
import type {
	LoginAuthPrompt,
	McpAuthResult,
	McpCallResult,
	McpConfigSource,
	McpContentBlock,
	McpEventPayload,
	McpImportCandidate,
	McpImportPick,
	McpInputRequest,
	McpLogPage,
	McpPromptInfo,
	McpResourceInfo,
	McpServerConfig,
	McpServerView,
	McpTestResult,
	McpToolInfo,
	McpTransportKind,
} from "@percho/shared";
import { MCP_SECRET_MASK } from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";
import { acquireAccessToken, type OAuthPromptContext, runOAuthLogin } from "./auth/oauth";
import { type McpCredentialStore, makeMcpCredentialStore } from "./auth/store";
import type { McpPromptResult } from "./client";
import {
	describeServer,
	loadMcpConfig,
	type McpConfigContext,
	mcpConfigPath,
	type ResolvedMcpServer,
	removeMcpServer,
	secretKeysOf,
	writeMcpServer,
} from "./config";
import { scanHostConfigs } from "./import";
import { McpRegistry, type McpRuntimeState } from "./registry";

const log = createLogger("mcp-service");

/** 配置派生读的 TTL（外部手改 mcp.json 的生效上界） */
const CONFIG_TTL_MS = 2_000;
/** 一次搜索最多返回的远端工具数（防把上百个工具灌进上下文） */
const SEARCH_LIMIT = 40;
/** 搜索等待连接的预算：连接可能要 npx 冷下载，超预算的服务器如实报 pending，不无限等 */
const SEARCH_BUDGET_MS = 20_000;

/** 用户级/项目级配置文件形状（本服务只碰 `mcpServers`；其它顶层键由 config.ts 原样保留） */
interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
}

interface ConfigSnapshot {
	at: number;
	servers: ResolvedMcpServer[];
	errors: string[];
}

/** 一次进行中的 OAuth 登录流程（对应 renderer 侧一个模态；settle 时回收全部挂起 prompt） */
interface ActiveAuthFlow {
	abort: AbortController;
	/** promptId → 挂起应答（renderer respondAuth 解除；null = 用户取消） */
	prompts: Map<string, (value: string | null) => void>;
	seq: number;
}

/** 一次性读取配置文件里的服务器名集合（判「名字在哪个源里」用；缺失/损坏按空集） */
async function namesInFile(path: string): Promise<Set<string>> {
	const file = await new JsonStore<McpConfigFile>({ path, defaultValue: () => ({}) }).read();
	return new Set(Object.keys(file.mcpServers ?? {}));
}

export interface McpServiceDeps {
	/** pi agent 目录（`<agentDir>/mcp.json` 与 `mcp-auth.json` 的落点） */
	agentDir: string;
	/** 当前项目目录（项目级配置锚点）——desktop 由 main 在 ui-state 变化时同步，故用函数而非值 */
	cwd: () => string;
	env?: NodeJS.ProcessEnv;
	/** 事件出口（main 转发到 renderer 的 `mcp:event`） */
	send: (event: McpEventPayload) => void;
}

/**
 * MCP 域门面。IPC 层（`main/ipc/mcp.ts`）与工具层（`tools.ts` / `script.ts`）都只经它访问
 * MCP 能力，不直接碰 config/registry/auth。
 */
export class McpService {
	private config: ConfigSnapshot | null = null;
	private loading: Promise<ConfigSnapshot> | null = null;
	/** main 同步过来的项目目录（覆盖 deps.cwd 的实时读；null = 未同步过） */
	private cwdOverride: string | null = null;
	private readonly credentials: McpCredentialStore;
	private readonly registry: McpRegistry;
	private readonly authFlows = new Map<string, ActiveAuthFlow>();
	/** 远端工具清单缓存（key = 服务器名）：直投工具的同步快照与搜索共用 */
	private readonly toolCache = new Map<string, McpToolInfo[]>();
	/** 服务级取消信号（dispose 时中止在途 OAuth 刷新等后台工作） */
	private readonly lifecycle = new AbortController();

	constructor(private readonly deps: McpServiceDeps) {
		this.credentials = makeMcpCredentialStore(deps.agentDir);
		this.registry = new McpRegistry({
			resolve: (name) => this.findSync(name),
			authHeader: (name) => this.authHeader(name),
			onEvent: (event) => {
				if (event.kind === "status") {
					// registry 只报「谁变了」：补全为完整视图（配置 + 凭据状态）再出网
					void this.emitStatus(event.server);
					return;
				}
				this.deps.send({ kind: "log", server: event.server, line: event.line });
			},
		});
		// 启动即预热一次配置：工具层需要在会话构造时**同步**判断「有没有可用服务器」，
		// 那份快照来自这里；失败不影响启动（记日志，改配置后自愈）
		void this.ensureConfig().catch((err: unknown) => log.warn("initial config load failed", err));
	}

	// ------------------------------------------------------------------ 配置

	/** 项目目录变更（main 在 ui-state 变化时同步）：失效缓存并广播 changed */
	setProjectCwd(cwd: string): void {
		if ((this.cwdOverride ?? this.deps.cwd()) === cwd) return;
		this.cwdOverride = cwd;
		this.invalidate("project cwd changed");
	}

	private context(): McpConfigContext {
		return {
			agentDir: this.deps.agentDir,
			cwd: this.cwdOverride ?? this.deps.cwd(),
			env: this.deps.env,
		};
	}

	/** 配置文件路径（`openConfig` 与诊断用）：注入上下文，调用方不需要知道 agentDir/cwd */
	configPath(source: McpConfigSource): string {
		return mcpConfigPath(this.context(), source);
	}

	/** 确保用户级配置文件存在（返回路径）：用系统编辑器打开前先落一个空骨架 */
	async ensureUserConfigFile(): Promise<string> {
		const path = this.configPath("user");
		if (!existsSync(path)) {
			await new JsonStore<McpConfigFile>({ path, defaultValue: () => ({}) }).write({ mcpServers: {} });
		}
		return path;
	}

	private invalidate(reason: string): void {
		this.config = null;
		this.loading = null;
		log.info("config cache invalidated", { reason });
		this.deps.send({ kind: "changed" });
	}

	/**
	 * 配置快照（2s TTL + single-flight）。非法条目由 config.ts 收集在 errors 里——这里既写主日志
	 * 也发 notice 事件，避免用户「服务器莫名消失」却无从得知。
	 *
	 * 注意：这里**不**做直投预热（预热会真的拉起子进程/发网络请求）。构造期只读一个文件，
	 * 预热推迟到「面板打开 / 开关直投 / 会话构造」这些真实使用点，避免纯构造场景（测试、CLI 启动）
	 * 触发宿主看不见的连接。
	 */
	private async ensureConfig(force = false): Promise<ConfigSnapshot> {
		if (!force && this.config && Date.now() - this.config.at < CONFIG_TTL_MS) return this.config;
		if (this.loading) return this.loading;
		this.loading = this.loadConfig();
		try {
			return await this.loading;
		} finally {
			this.loading = null;
		}
	}

	private async loadConfig(): Promise<ConfigSnapshot> {
		const { servers, errors } = await loadMcpConfig(this.context());
		this.config = { at: Date.now(), servers, errors };
		for (const message of errors) {
			log.warn("config entry skipped", { message });
			this.deps.send({ kind: "notice", level: "warn", message });
		}
		return this.config;
	}

	/** 同步查配置（registry.resolve 是同步契约：调用方已先 await ensureConfig） */
	private findSync(name: string): ResolvedMcpServer | undefined {
		return this.config?.servers.find((server) => server.name === name);
	}

	/** 取配置条目；缺失即抛（面向开发者的英文错误） */
	private async required(name: string): Promise<ResolvedMcpServer> {
		await this.ensureConfig();
		const resolved = this.findSync(name);
		if (!resolved) throw new Error(`Unknown MCP server "${name}"`);
		return resolved;
	}

	/** 已启用服务器数：工具层据此决定要不要注册 `mcp` 工具（零服务器时不占 context） */
	enabledServerCount(): number {
		let count = 0;
		for (const server of this.config?.servers ?? []) {
			if (server.config.disabled !== true) count += 1;
		}
		return count;
	}

	// ------------------------------------------------------------------ 视图

	/** 全部服务器视图（用户级 + 项目级合并后）；凭据只以 hasOAuthToken 布尔出现 */
	async list(): Promise<McpServerView[]> {
		const snapshot = await this.ensureConfig();
		// 面板打开 = 用户明确的进入点：顺手把开了直投的服务器的工具清单预热（后台，不阻塞列表）
		void this.warmDirectTools(snapshot.servers);
		// 凭据文件只读一次：每服务器各读一遍会把同一份 JSON 读 N 次（列表是高频 IPC）
		const connected = new Set(await this.credentials.connectedServers());
		return snapshot.servers.map((server) => this.toView(server, connected));
	}

	private toView(resolved: ResolvedMcpServer, oauthServers: ReadonlySet<string>): McpServerView {
		const runtime = this.registry.runtimeState(resolved.name);
		const disabled = resolved.config.disabled === true;
		return {
			name: resolved.name,
			transport: transportKindOf(resolved.config),
			summary: describeServer(resolved.config),
			config: maskSecrets(resolved.config),
			disabled,
			percho: resolved.percho,
			secretKeys: secretKeysOf(resolved.config),
			authKind: authKindOf(resolved.config),
			state: disabled ? "disabled" : runtime.state,
			era: runtime.era,
			protocolVersion: runtime.protocolVersion,
			serverInfo: runtime.serverInfo,
			toolCount: runtime.toolCount,
			lastError: runtime.lastError,
			source: resolved.source,
			hasOAuthToken: oauthServers.has(resolved.name),
		};
	}

	private async emitStatus(name: string): Promise<void> {
		try {
			const snapshot = await this.ensureConfig();
			const resolved = snapshot.servers.find((server) => server.name === name);
			if (!resolved) return;
			const connected = new Set(await this.credentials.connectedServers());
			this.deps.send({ kind: "status", server: this.toView(resolved, connected) });
		} catch (err) {
			log.warn("status event dropped", name, err);
		}
	}

	/** 运行时状态快照（工具层的 status 动作用：既要配置摘要也要连接状态） */
	async runtimeStatus(name: string): Promise<{ resolved: ResolvedMcpServer; runtime: McpRuntimeState }> {
		const resolved = await this.required(name);
		return { resolved, runtime: this.registry.runtimeState(name) };
	}

	// ------------------------------------------------------------------ 写操作

	/**
	 * 新增/覆盖一个服务器。目标来源：同名条目已在项目级则写项目级（就地编辑），否则写用户级——
	 * 通道没有 source 参数（契约里 `upsertServer` 只收 name + config），这样「改哪来的写回哪」；
	 * 新服务器落在用户级（跨项目可用，与各 MCP 宿主的默认预期一致）。
	 *
	 * 提交的 `env`/`headers` 里值为 `MCP_SECRET_MASK` 的条目会换回磁盘原值（视图不下发凭据值，
	 * 编辑表单只能这样回传「保持原样」）；其余字段按提交值整份覆盖。
	 */
	async upsert(name: string, config: McpServerConfig): Promise<McpServerView> {
		await this.ensureConfig();
		const trimmed = name.trim();
		if (trimmed === "") throw new Error("Server name must not be empty");
		const existing = this.findSync(trimmed);
		// 无条件丢弃旧连接：配置已变（传输/URL/命令都可能不同），旧连接以及它的运行时状态都不再有效，
		// 留着会让视图显示上一次运行留下的 state/era/toolCount
		await this.registry.drop(trimmed);
		const merged = restoreSecrets(config, existing?.config);
		await writeMcpServer(this.context(), trimmed, merged, existing?.source ?? "user");
		this.invalidate(`upsert ${trimmed}`);
		const snapshot = await this.ensureConfig(true);
		const resolved = snapshot.servers.find((server) => server.name === trimmed);
		if (!resolved) throw new Error(`Server "${trimmed}" rejected by config validation`);
		return this.toView(resolved, new Set(await this.credentials.connectedServers()));
	}

	/**
	 * 删除服务器配置。合并视图只给出「生效的那个源」，而同一个名字可能同时存在于两个源
	 * （项目级覆盖用户级），所以这里对两个文件各查一次存在性再按需删——避免删掉覆盖项后
	 * 用户级那条幽灵配置又冒出来。
	 */
	async remove(name: string): Promise<void> {
		await this.ensureConfig();
		if (!this.findSync(name)) return;
		await this.registry.drop(name);
		this.toolCache.delete(name);
		for (const source of ["user", "project"] as const) {
			const path = this.configPath(source);
			if (!(await namesInFile(path)).has(name)) continue;
			await removeMcpServer(this.context(), name, source);
		}
		this.invalidate(`remove ${name}`);
	}

	/** 启停：停用 = 断开连接、不注册工具，配置保留（与各宿主 `disabled` 语义一致） */
	async setEnabled(name: string, enabled: boolean): Promise<McpServerView> {
		return this.patchConfig(name, (config) => ({ ...config, disabled: !enabled }), !enabled);
	}

	/** 逐工具直投开关（默认关：走 mcp 代理工具省 context）；开时顺手预热远端工具清单 */
	async setDirectTools(name: string, enabled: boolean): Promise<McpServerView> {
		const view = await this.patchConfig(name, (config) => ({
			...config,
			percho: { ...config.percho, directTools: enabled },
		}));
		if (enabled) {
			// 设置页不应卡在冷启动连接上：预热失败只是「下次新建会话没有直投工具」
			void this.cacheTools(name).catch((err: unknown) => log.warn("direct tool warmup failed", name, err));
		} else {
			this.toolCache.delete(name);
		}
		return view;
	}

	private async patchConfig(
		name: string,
		patch: (config: McpServerConfig) => McpServerConfig,
		dropConnection = false,
	): Promise<McpServerView> {
		const existing = await this.required(name);
		await writeMcpServer(this.context(), name, patch(existing.config), existing.source);
		if (dropConnection) await this.registry.drop(name);
		this.invalidate(`patch ${name}`);
		const snapshot = await this.ensureConfig(true);
		const resolved = snapshot.servers.find((server) => server.name === name);
		if (!resolved) throw new Error(`Server "${name}" disappeared after update`);
		return this.toView(resolved, new Set(await this.credentials.connectedServers()));
	}

	/** 丢弃全部连接与配置缓存后重建（改配置/装证书后手动触发） */
	async reload(): Promise<void> {
		this.invalidate("manual reload");
		await this.registry.reload();
		await this.ensureConfig(true);
	}

	// ------------------------------------------------------------------ 运行

	async test(name: string): Promise<McpTestResult> {
		await this.ensureConfig();
		return this.registry.test(name);
	}

	async listTools(name: string): Promise<McpToolInfo[]> {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(name);
		const tools = await client.listTools({ force: true });
		this.toolCache.set(name, tools);
		return tools;
	}

	/**
	 * 列资源/提示前先看服务端有没有声明该能力：没声明的服务器收到 `resources/list` 会回
	 * `-32601 Method not found`（真服务器实测 Cloudflare docs 只声明 tools+prompts）。
	 * 与其把裸错误抛给 UI，不如说清「它不支持这个能力面」——空列表会是更糟的谎话。
	 */
	async listResources(name: string): Promise<McpResourceInfo[]> {
		const client = await this.requireCapability(name, "resources");
		return client.listResources({ force: true });
	}

	async listPrompts(name: string): Promise<McpPromptInfo[]> {
		const client = await this.requireCapability(name, "prompts");
		return client.listPrompts({ force: true });
	}

	/** 取客户端并校验能力面（缺失即抛可读错误） */
	private async requireCapability(name: string, capability: "tools" | "resources" | "prompts") {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(name);
		if (!client.hasCapability(capability)) {
			throw new Error(
				`MCP server "${name}" does not declare the "${capability}" capability; it exposes: ${client.capabilityNames.join(", ") || "(nothing)"}`,
			);
		}
		return client;
	}

	/** 抽屉内手动调用一个远端工具：用户显式操作，不经权限门控（权限门只管模型发起的调用） */
	async callTool(name: string, tool: string, args: unknown): Promise<McpCallResult> {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(name);
		return client.callTool(tool, args);
	}

	readLog(name: string, cursor: number): McpLogPage {
		return this.registry.readLog(name, cursor);
	}

	/**
	 * 直投工具的**同步**快照：SDK 的工具集在会话构造时固定，所以开关变化只影响新建会话
	 * （pi-mcp-adapter 生态同样要求重新加载）。未连上（缓存为空）的服务器不贡献工具，但会
	 * 顺手在后台预热——下次新建会话即可带上它们的工具（面板里的「测试连接」也能提前预热）。
	 */
	directToolSnapshot(): Array<{ server: string; tools: McpToolInfo[] }> {
		const snapshot: Array<{ server: string; tools: McpToolInfo[] }> = [];
		const cold: ResolvedMcpServer[] = [];
		for (const server of this.config?.servers ?? []) {
			if (server.config.disabled === true || !server.percho.directTools) continue;
			const tools = this.toolCache.get(server.name);
			if (tools !== undefined && tools.length > 0) snapshot.push({ server: server.name, tools });
			else cold.push(server);
		}
		if (cold.length > 0) void this.warmDirectTools(cold);
		return snapshot;
	}

	/** 拉取并缓存某服务器的远端工具清单（直投预热 / 搜索 / 面板都用它） */
	private async cacheTools(name: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
		const client = await this.registry.ensureClient(name);
		const tools = await client.listTools({ signal });
		this.toolCache.set(name, tools);
		return tools;
	}

	/** 配置里开了直投的服务器后台预热（不阻塞配置加载；失败只是没有直投工具） */
	private async warmDirectTools(servers: ResolvedMcpServer[]): Promise<void> {
		const targets = servers.filter((server) => server.config.disabled !== true && server.percho.directTools);
		await Promise.allSettled(targets.map((server) => this.cacheTools(server.name)));
	}

	/**
	 * 跨服务器搜索远端工具（`mcp` 工具的 search 动作 + `mcpScript` 的 tools.search）。
	 * 语义：只搜「已连上或能连上」的服务器，连不上的如实报告（failed / pending），不静默少给。
	 * 排序是确定性的关键词打分（名字精确 > 名字逐词命中 > 名字包含 > 描述包含），不做语义搜索。
	 */
	async searchTools(
		query: string,
		options: { server?: string; limit?: number; signal?: AbortSignal } = {},
	): Promise<{ tools: McpToolInfo[]; failed: Array<{ server: string; error: string }>; pending: string[] }> {
		await this.ensureConfig();
		const targets = (this.config?.servers ?? []).filter(
			(server) =>
				server.config.disabled !== true && (options.server === undefined || server.name === options.server),
		);
		if (options.server !== undefined && targets.length === 0) {
			throw new Error(`Unknown or disabled MCP server "${options.server}"`);
		}
		const finished = new Map<string, { tools: McpToolInfo[] } | { error: string }>();
		const probes = targets.map(async (server) => {
			try {
				finished.set(server.name, { tools: await this.cacheTools(server.name, options.signal) });
			} catch (err) {
				finished.set(server.name, { error: err instanceof Error ? err.message : String(err) });
			}
		});
		const all = Promise.all(probes);
		const budget = new Promise<"timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), SEARCH_BUDGET_MS);
			timer.unref();
		});
		const raced = await Promise.race([all.then(() => "done" as const), budget]);
		const tools: McpToolInfo[] = [];
		const failed: Array<{ server: string; error: string }> = [];
		for (const [server, outcome] of finished) {
			if ("tools" in outcome) tools.push(...outcome.tools);
			else failed.push({ server, error: outcome.error });
		}
		return {
			tools: rankTools(tools, query).slice(0, options.limit ?? SEARCH_LIMIT),
			failed,
			pending:
				raced === "timeout"
					? targets.filter((server) => !finished.has(server.name)).map((server) => server.name)
					: [],
		};
	}

	/** 描述一个远端工具（path = `<server>__<tool>`） */
	async describeTool(path: string, signal?: AbortSignal): Promise<McpToolInfo> {
		await this.ensureConfig();
		const { server, tool } = parseToolPath(path);
		const client = await this.registry.ensureClient(server);
		const tools = await client.listTools({ signal });
		this.toolCache.set(server, tools);
		const found = tools.find((item) => item.name === tool);
		if (!found) throw new Error(`Tool "${tool}" not found on MCP server "${server}"`);
		return found;
	}

	/** 调用远端工具（含 MRTR 回放凭据透传：`requestState` 不透明，原样回传；signal 中止时关流取消） */
	async callRemoteTool(
		server: string,
		tool: string,
		args: unknown,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<McpCallResult> {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(server);
		return client.callTool(tool, args, options);
	}

	/** 读远端资源（`mcp` 工具的 resource 动作） */
	async readResource(
		server: string,
		uri: string,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<{ content: McpContentBlock[]; inputRequests?: McpInputRequest[]; requestState?: string }> {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(server);
		return client.readResource(uri, options);
	}

	/** 取远端提示（`mcp` 工具的 prompt 动作） */
	async getPrompt(
		server: string,
		name: string,
		args: Record<string, unknown> | undefined,
		options: { inputResponses?: Record<string, unknown>; requestState?: string; signal?: AbortSignal } = {},
	): Promise<McpPromptResult> {
		await this.ensureConfig();
		const client = await this.registry.ensureClient(server);
		return client.getPrompt(name, args, options);
	}

	// ------------------------------------------------------------------ OAuth

	/**
	 * 每次 HTTP 请求前的凭据解析（client 在发请求前调用）：只有 `auth.kind === "oauth"` 的服务器
	 * 走这里；header/none 的静态头已由 config.ts 展开进 `transportOptions.headers`，不在此叠加。
	 * 返回值是完整 authorization 头值（`Bearer <token>`），与 registry 的 `setAuthHeaders` 契约一致。
	 */
	private async authHeader(name: string): Promise<string | null> {
		const resolved = this.config?.servers.find((server) => server.name === name);
		if (!resolved || !("url" in resolved.config)) return null;
		if (resolved.config.auth?.kind !== "oauth") return null;
		return acquireAccessToken({
			server: name,
			resourceUrl: resolved.config.url,
			store: this.credentials,
			signal: this.lifecycle.signal,
		});
	}

	/**
	 * 启动 OAuth 登录：授权 URL / 进度经 `auth` 事件交给 renderer，需要用户输入时发 prompt 事件并等应答。
	 * 成功后丢弃旧连接（旧连接没有 Authorization 头，token 也变了）。
	 */
	async startAuth(name: string, flowId: string): Promise<McpAuthResult> {
		const resolved = await this.required(name);
		if (!("url" in resolved.config)) {
			return {
				ok: false,
				cancelled: false,
				error: `MCP server "${name}" uses stdio; OAuth applies to HTTP transports only`,
			};
		}
		const abort = new AbortController();
		const flow: ActiveAuthFlow = { abort, prompts: new Map(), seq: 0 };
		this.authFlows.set(flowId, flow);
		try {
			const result = await runOAuthLogin({
				server: name,
				resourceUrl: resolved.config.url,
				store: this.credentials,
				ctx: this.authContext(flowId, flow),
				signal: abort.signal,
			});
			if (result.ok) await this.registry.drop(name);
			await this.emitStatus(name);
			return result;
		} catch (err) {
			return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.settleAuth(flowId, flow);
		}
	}

	/** OAuth 流程提示桥：与 settings 域登录同一套事件形状，renderer 复用同一批输入组件 */
	private authContext(flowId: string, flow: ActiveAuthFlow): OAuthPromptContext {
		return {
			prompt: (kind, message) =>
				new Promise<string | null>((resolve) => {
					const promptId = `${flowId}:${++flow.seq}`;
					flow.prompts.set(promptId, resolve);
					this.deps.send({
						kind: "auth",
						payload: {
							flowId,
							kind: "prompt",
							promptId,
							prompt: authPromptOf(kind, message),
						},
					});
				}),
			notify: (event) => {
				this.deps.send({
					kind: "auth",
					payload: {
						flowId,
						kind: "event",
						event:
							event.type === "auth_url"
								? { type: "auth_url", url: event.url }
								: { type: "info", message: event.message },
					},
				});
			},
		};
	}

	/** renderer 应答提示（promptId 已被外部取消时静默忽略，与 settings 域登录同语义） */
	respondAuth(flowId: string, promptId: string, value: string): void {
		const flow = this.authFlows.get(flowId);
		const resolve = flow?.prompts.get(promptId);
		if (!flow || !resolve) return;
		flow.prompts.delete(promptId);
		resolve(value);
	}

	/** 取消进行中的登录（未知 flowId 静默忽略） */
	cancelAuth(flowId: string): void {
		this.authFlows.get(flowId)?.abort.abort();
	}

	private settleAuth(flowId: string, flow: ActiveAuthFlow): void {
		if (this.authFlows.get(flowId) === flow) this.authFlows.delete(flowId);
		flow.abort.abort();
		for (const [promptId, resolve] of flow.prompts) {
			this.deps.send({ kind: "auth", payload: { flowId, kind: "prompt-cancel", promptId } });
			// null = 用户取消（oauth.ts 的约定）；用 reject 会被上层记成「失败」而非「取消」
			resolve(null);
		}
		flow.prompts.clear();
	}

	// ------------------------------------------------------------------ 导入

	/** 只读扫描本机各宿主 MCP 配置（绝不写宿主文件） */
	async scanHostConfigs(): Promise<McpImportCandidate[]> {
		await this.ensureConfig();
		const existing = (this.config?.servers ?? []).map((server) => server.name);
		return scanHostConfigs({
			cwd: this.context().cwd,
			env: this.deps.env,
			agentDir: this.deps.agentDir,
			existingNames: existing,
		});
	}

	/** 把选中的宿主服务器导入 Percho 用户级配置（同名覆盖；绝不写宿主文件） */
	async importServers(picks: McpImportPick[]): Promise<void> {
		const candidates = await this.scanHostConfigs();
		let imported = 0;
		for (const pick of picks) {
			const candidate = candidates.find((item) => item.host === pick.host && item.path === pick.path);
			if (!candidate) {
				this.deps.send({
					kind: "notice",
					level: "warn",
					message: `Import skipped: ${pick.host} config at ${pick.path} is no longer readable`,
				});
				continue;
			}
			for (const name of pick.names) {
				const found = candidate.servers.find((server) => server.name === name);
				if (!found) continue;
				await writeMcpServer(this.context(), name, found.config, "user");
				imported += 1;
			}
		}
		log.info("imported host MCP servers", { imported });
		if (imported > 0) this.invalidate(`import ${imported}`);
	}

	// ------------------------------------------------------------------ 生命周期

	async dispose(): Promise<void> {
		this.lifecycle.abort();
		// 挂起的 OAuth prompt 按「用户取消」结算，不留悬挂 promise（容器被拆时进程要能退）
		for (const [flowId, flow] of [...this.authFlows]) this.settleAuth(flowId, flow);
		await this.registry.dispose();
		this.toolCache.clear();
		this.config = null;
	}
}

/**
 * 视图脱敏：只把 env/headers 的**值**换成哨兵（键名保留，与 `secretKeys` 同语义）。
 * 其它字段原样下发——编辑表单要靠它们才能忠实回填（不下发就只能整份清空）。
 */
function maskSecrets(config: McpServerConfig): McpServerConfig {
	if ("url" in config) {
		if (config.headers === undefined) return config;
		return { ...config, headers: maskValues(config.headers) };
	}
	if (config.env === undefined) return config;
	return { ...config, env: maskValues(config.env) };
}

function maskValues(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.keys(values).map((key) => [key, MCP_SECRET_MASK]));
}

/**
 * 写入还原：提交值里等于哨兵的条目换回磁盘原值（原值也缺失则丢弃该键——用户删了它）。
 * 未提交 env/headers 时保持 undefined（= 本就没有），不凭空造一个空 map。
 */
function restoreSecrets(incoming: McpServerConfig, previous: McpServerConfig | undefined): McpServerConfig {
	if ("url" in incoming) {
		if (incoming.headers === undefined) return incoming;
		const prior = previous !== undefined && "url" in previous ? previous.headers : undefined;
		return { ...incoming, headers: restoreValues(incoming.headers, prior) };
	}
	if (incoming.env === undefined) return incoming;
	const prior = previous !== undefined && !("url" in previous) ? previous.env : undefined;
	return { ...incoming, env: restoreValues(incoming.env, prior) };
}

function restoreValues(
	values: Record<string, string>,
	previous: Record<string, string> | undefined,
): Record<string, string> {
	const restored: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== MCP_SECRET_MASK) {
			restored[key] = value;
			continue;
		}
		const prior = previous?.[key];
		if (prior !== undefined) restored[key] = prior;
	}
	return restored;
}

/**
 * OAuth 流程的 prompt 种类 → 跨进程提示形状（`LoginAuthPrompt` 没有 `client_id` 这种形态，
 * 客户端标识是普通文本输入；密钥类必须走 secret，避免明文回显）。
 */
function authPromptOf(kind: "client_id" | "manual_code" | "client_secret", message: string): LoginAuthPrompt {
	if (kind === "client_secret") return { type: "secret", message };
	if (kind === "manual_code") return { type: "manual_code", message };
	return { type: "text", message };
}

/** 配置 type 字段 → 跨进程视图的传输种类（stdio 缺省即 stdio） */
function transportKindOf(config: McpServerConfig): McpTransportKind {
	if ("url" in config) return config.type === "sse" ? "sse" : "http";
	return "stdio";
}

/** 认证方式：stdio 恒 none；http 族读 auth.kind（旧配置缺省 none） */
function authKindOf(config: McpServerConfig): "none" | "header" | "oauth" {
	if (!("url" in config)) return "none";
	return config.auth?.kind ?? "none";
}

/** `path = <server>__<tool>` → 两段：服务器名允许含连字符，故按**首个** `__` 切分 */
export function parseToolPath(path: string): { server: string; tool: string } {
	const trimmed = path.trim();
	const index = trimmed.indexOf("__");
	if (index <= 0 || index === trimmed.length - 2) {
		throw new Error(`Invalid MCP tool path "${path}"; expected "<server>__<tool>"`);
	}
	return { server: trimmed.slice(0, index), tool: trimmed.slice(index + 2) };
}

/** 关键词打分排序（确定性：精确名 > 名字逐词命中 > 名字包含 > 描述包含；同分按名字字典序） */
function rankTools(tools: McpToolInfo[], query: string): McpToolInfo[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...tools].sort((a, b) => a.name.localeCompare(b.name));
	const words = needle.split(/\s+/).filter((word) => word !== "");
	const scored = tools.map((tool) => {
		const name = tool.name.toLowerCase();
		const haystack = `${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
		let score = 0;
		if (name === needle) score = 100;
		else if (words.length > 0 && words.every((word) => name.includes(word))) score = 60;
		else if (name.includes(needle)) score = 40;
		else if (haystack.includes(needle)) score = 20;
		return { tool, score };
	});
	return scored
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
		.map((item) => item.tool);
}
