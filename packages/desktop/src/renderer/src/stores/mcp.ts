import type {
	LoginAuthPrompt,
	McpAuthEventPayload,
	McpAuthResult,
	McpEventPayload,
	McpImportCandidate,
	McpImportPick,
	McpServerConfig,
	McpServerView,
	McpTestResult,
	McpToolInfo,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";

/** 稳定空引用：selector 缺省值禁内联新建（zustand 每帧新引用 → 无限重渲染，本仓有事故记录） */
export const EMPTY_SERVERS: McpServerView[] = [];
export const EMPTY_TOOLS: McpToolInfo[] = [];
export const EMPTY_LOG_LINES: string[] = [];

/** 每个服务器在内存里保留的日志行上限（长跑 stdio 服务器的 stderr 会无限增长） */
const MAX_LOG_TAIL = 400;
/** 日志区一次渲染的尾部行数（行数上限之外再限渲染量，避免 DOM 过大） */
export const LOG_RENDER_TAIL = 120;
/** 面板内保留的配置层提示条数（notice 是瞬时事件，不落盘） */
const MAX_NOTICES = 5;

/** 配置层提示（后端 mcp:event 的 notice 载荷）：面板顶部横幅就地产显示，不进服务器日志区 */
export interface McpNotice {
	id: string;
	level: "warn" | "error";
	message: string;
}

/** OAuth 单流程状态（同一时刻只有一个：登录按钮在流程进行中被禁用） */
export interface McpAuthFlow {
	flowId: string;
	server: string;
	running: boolean;
	authUrl?: { url: string; instructions?: string };
	statusLine?: string;
	pendingPrompt?: { promptId: string; prompt: LoginAuthPrompt };
	error?: string;
	/** 流程结束后的结算态（ok / cancelled）；成功后由用户关闭对话框 */
	result?: McpAuthResult;
}

/** 从 record 里删键：键不存在时返回原引用（避免无谓重渲染） */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface McpStore {
	servers: McpServerView[];
	serversLoading: boolean;
	serversError: string | null;
	/** 防陈旧响应：每次列表刷新自增，响应只认最新序号 */
	serversSeq: number;
	/** 配置层提示（notice 事件累积，可逐条关闭） */
	notices: McpNotice[];
	/** 工具清单缓存（按服务器名；懒加载，展开「工具」时拉取） */
	tools: Record<string, McpToolInfo[]>;
	toolsLoading: Record<string, true>;
	toolsErrors: Record<string, string>;
	testing: Record<string, true>;
	testResults: Record<string, McpTestResult>;
	testErrors: Record<string, string>;
	/** 日志尾部（按服务器名；log 事件实时追加，readLog 增量拉取） */
	logs: Record<string, string[]>;
	logCursors: Record<string, number>;
	logsLoading: Record<string, true>;
	logsErrors: Record<string, string>;
	/** 导入向导扫描结果（null = 未扫描过） */
	importCandidates: McpImportCandidate[] | null;
	scanning: boolean;
	scanError: string | null;
	importing: boolean;
	/** 进行中/已结算的 OAuth 流程 */
	authFlow: McpAuthFlow | null;

	refresh: () => Promise<void>;
	/** 新增/覆盖服务器（失败向上抛，表单就地展示） */
	upsert: (name: string, config: McpServerConfig) => Promise<void>;
	remove: (name: string) => Promise<void>;
	setEnabled: (name: string, enabled: boolean) => Promise<void>;
	setDirectTools: (name: string, enabled: boolean) => Promise<void>;
	testServer: (name: string) => Promise<void>;
	listTools: (name: string, force?: boolean) => Promise<void>;
	readLog: (name: string, reset?: boolean) => Promise<void>;
	scanHostConfigs: () => Promise<void>;
	importServers: (picks: McpImportPick[]) => Promise<void>;
	openConfig: () => Promise<void>;
	reloadAll: () => Promise<void>;
	startAuth: (server: string) => Promise<void>;
	respondAuth: (value: string) => Promise<void>;
	cancelAuth: () => void;
	dismissAuth: () => void;
	dismissNotice: (id: string) => void;
	/** 订阅 mcp:event（返回退订函数；引用计数，多处挂载不会重复订阅） */
	subscribeEvents: () => () => void;
}

/** 事件订阅的模块级状态：面板挂载/卸载都会走这里，避免重复注册 ipcRenderer 监听 */
let releaseEvents: (() => void) | undefined;
let eventRefCount = 0;
/** 列表刷新防抖（changed 事件短时间可能连发：增删改 + 连接状态收敛） */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let noticeSeq = 0;

export const useMcpStore = create<McpStore>((set, get) => {
	const scheduleRefresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => void get().refresh(), 300);
	};

	/** status 事件/写操作返回值：只替换列表里同名的那一项，其余保持原引用 */
	const applyServer = (server: McpServerView) => {
		set((state) => {
			const index = state.servers.findIndex((item) => item.name === server.name);
			if (index < 0) return { servers: [...state.servers, server] };
			const servers = state.servers.slice();
			servers[index] = server;
			return { servers };
		});
	};

	const pushNotice = (level: "warn" | "error", message: string) => {
		set((state) => ({
			notices: [...state.notices, { id: `notice${noticeSeq++}`, level, message }].slice(-MAX_NOTICES),
		}));
	};

	/** auth 事件：只认当前流程（flowId 由 renderer 生成，事件归属靠它） */
	const applyAuthEvent = (payload: McpAuthEventPayload) => {
		const flow = get().authFlow;
		if (!flow || flow.flowId !== payload.flowId) return;
		if (payload.kind === "prompt") {
			set({ authFlow: { ...flow, pendingPrompt: { promptId: payload.promptId, prompt: payload.prompt } } });
			return;
		}
		if (payload.kind === "prompt-cancel") {
			if (flow.pendingPrompt?.promptId === payload.promptId) {
				set({ authFlow: { ...flow, pendingPrompt: undefined } });
			}
			return;
		}
		const event = payload.event;
		if (event.type === "auth_url") {
			set({ authFlow: { ...flow, authUrl: { url: event.url, instructions: event.instructions } } });
			return;
		}
		if (event.type === "progress" || event.type === "info") {
			set({ authFlow: { ...flow, statusLine: event.message } });
			return;
		}
		// device_code 不在 MCP 授权流程里（规范走 127.0.0.1 回调）；真出现就原样展示，不做二次解释
		set({ authFlow: { ...flow, statusLine: `${event.userCode} → ${event.verificationUri}` } });
	};

	return {
		servers: EMPTY_SERVERS,
		serversLoading: false,
		serversError: null,
		serversSeq: 0,
		notices: [],
		tools: {},
		toolsLoading: {},
		toolsErrors: {},
		testing: {},
		testResults: {},
		testErrors: {},
		logs: {},
		logCursors: {},
		logsLoading: {},
		logsErrors: {},
		importCandidates: null,
		scanning: false,
		scanError: null,
		importing: false,
		authFlow: null,

		refresh: async () => {
			const seq = get().serversSeq + 1;
			set({ serversSeq: seq, serversLoading: true, serversError: null });
			try {
				const servers = await getPi().listServers();
				if (get().serversSeq !== seq) return; // 已有更新的刷新，丢弃陈旧响应
				set({ servers, serversLoading: false });
			} catch (error) {
				if (get().serversSeq !== seq) return;
				set({ serversLoading: false, serversError: errorMessage(error) });
			}
		},

		upsert: async (name, config) => {
			const view = await getPi().upsertServer({ name, config });
			applyServer(view);
			// 配置变更可能让工具清单/日志源发生变化，清掉缓存让展开区下次重新拉
			set((state) => ({ tools: withoutKey(state.tools, name) }));
		},

		remove: async (name) => {
			await getPi().removeServer({ name });
			set((state) => ({
				servers: state.servers.filter((item) => item.name !== name),
				tools: withoutKey(state.tools, name),
				logs: withoutKey(state.logs, name),
				logCursors: withoutKey(state.logCursors, name),
				testResults: withoutKey(state.testResults, name),
			}));
		},

		setEnabled: async (name, enabled) => {
			applyServer(await getPi().setEnabled({ name, enabled }));
		},

		setDirectTools: async (name, enabled) => {
			applyServer(await getPi().setDirectTools({ name, enabled }));
		},

		testServer: async (name) => {
			set((state) => ({
				testing: { ...state.testing, [name]: true },
				testErrors: withoutKey(state.testErrors, name),
			}));
			try {
				const result = await getPi().testServer({ name });
				set((state) => ({ testResults: { ...state.testResults, [name]: result } }));
			} catch (error) {
				set((state) => ({ testErrors: { ...state.testErrors, [name]: errorMessage(error) } }));
			} finally {
				set((state) => ({ testing: withoutKey(state.testing, name) }));
			}
		},

		listTools: async (name, force = false) => {
			if (!force && get().tools[name]) return;
			set((state) => ({
				toolsLoading: { ...state.toolsLoading, [name]: true },
				toolsErrors: withoutKey(state.toolsErrors, name),
			}));
			try {
				const tools = await getPi().listTools({ name });
				set((state) => ({ tools: { ...state.tools, [name]: tools } }));
			} catch (error) {
				set((state) => ({ toolsErrors: { ...state.toolsErrors, [name]: errorMessage(error) } }));
			} finally {
				set((state) => ({ toolsLoading: withoutKey(state.toolsLoading, name) }));
			}
		},

		readLog: async (name, reset = false) => {
			const cursor = reset ? 0 : (get().logCursors[name] ?? 0);
			set((state) => ({
				logsLoading: { ...state.logsLoading, [name]: true },
				logsErrors: withoutKey(state.logsErrors, name),
			}));
			try {
				const page = await getPi().readLog({ name, cursor });
				set((state) => {
					const previous = reset ? [] : (state.logs[name] ?? []);
					return {
						logs: { ...state.logs, [name]: [...previous, ...page.lines].slice(-MAX_LOG_TAIL) },
						logCursors: { ...state.logCursors, [name]: page.cursor },
					};
				});
			} catch (error) {
				set((state) => ({ logsErrors: { ...state.logsErrors, [name]: errorMessage(error) } }));
			} finally {
				set((state) => ({ logsLoading: withoutKey(state.logsLoading, name) }));
			}
		},

		scanHostConfigs: async () => {
			set({ scanning: true, scanError: null });
			try {
				const candidates = await getPi().scanHostConfigs();
				set({ importCandidates: candidates, scanning: false });
			} catch (error) {
				set({ scanning: false, scanError: errorMessage(error) });
			}
		},

		importServers: async (picks) => {
			set({ importing: true });
			try {
				await getPi().importServers({ picks });
				set({ importing: false, importCandidates: null });
				await get().refresh();
			} catch (error) {
				set({ importing: false });
				throw error instanceof Error ? error : new Error(String(error));
			}
		},

		openConfig: async () => {
			await getPi().openConfig();
		},

		reloadAll: async () => {
			await getPi().reload();
			// 连接被丢弃重建：工具清单与日志游标都失效
			set({ tools: {}, logs: {}, logCursors: {} });
			await get().refresh();
		},

		startAuth: async (server) => {
			// 单流程：进行中不重入（登录按钮同时禁用，这里再兜一层）
			if (get().authFlow?.running) return;
			const flowId = crypto.randomUUID();
			set({ authFlow: { flowId, server, running: true } });
			try {
				const result = await getPi().authStart({ name: server, flowId });
				const flow = get().authFlow;
				if (!flow || flow.flowId !== flowId) return;
				set({ authFlow: { ...flow, running: false, pendingPrompt: undefined, result } });
				// 成功后 hasOAuthToken 变化，列表视图需要刷新
				if (result.ok) await get().refresh();
			} catch (error) {
				const flow = get().authFlow;
				if (!flow || flow.flowId !== flowId) return;
				set({ authFlow: { ...flow, running: false, pendingPrompt: undefined, error: errorMessage(error) } });
			}
		},

		respondAuth: async (value) => {
			const flow = get().authFlow;
			if (!flow?.pendingPrompt) return;
			const { promptId } = flow.pendingPrompt;
			try {
				await getPi().authRespond({ flowId: flow.flowId, promptId, value });
				// 竞态：后端可能在同一 tick 内连发下一个 prompt，清理必须只针对本次应答的 promptId
				set((state) =>
					state.authFlow?.pendingPrompt?.promptId === promptId
						? { authFlow: { ...state.authFlow, pendingPrompt: undefined } }
						: {},
				);
			} catch (error) {
				set((state) =>
					state.authFlow ? { authFlow: { ...state.authFlow, error: errorMessage(error) } } : {},
				);
			}
		},

		cancelAuth: () => {
			const flow = get().authFlow;
			// 只发取消信号：结算态由 authStart 的返回值统一落地（避免两处同时改流程状态）
			if (flow?.running) void getPi().authCancel({ flowId: flow.flowId });
		},

		dismissAuth: () => set({ authFlow: null }),

		dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((item) => item.id !== id) })),

		subscribeEvents: () => {
			eventRefCount += 1;
			if (!releaseEvents) {
				releaseEvents = getPi().onMcpEvent((payload: McpEventPayload) => {
					if (payload.kind === "status") {
						applyServer(payload.server);
						return;
					}
					if (payload.kind === "log") {
						// 实时追加（行尾截断）：不触发 readLog，避免每条 stderr 都打一次 IPC
						set((state) => ({
							logs: {
								...state.logs,
								[payload.server]: [...(state.logs[payload.server] ?? []), payload.line].slice(-MAX_LOG_TAIL),
							},
						}));
						return;
					}
					if (payload.kind === "notice") {
						pushNotice(payload.level, payload.message);
						return;
					}
					if (payload.kind === "auth") {
						applyAuthEvent(payload.payload);
						return;
					}
					// changed：配置变化（增删改/导入/启停）→ 防抖重取列表
					scheduleRefresh();
				});
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				eventRefCount -= 1;
				if (eventRefCount <= 0) {
					eventRefCount = 0;
					releaseEvents?.();
					releaseEvents = undefined;
				}
			};
		},
	};
});
