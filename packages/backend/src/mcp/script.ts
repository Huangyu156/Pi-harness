/**
 * `mcpScript` 工具：在一个 **worker 线程**里跑 agent 写的 JavaScript，脚本内可搜索/描述/调用远端 MCP
 * 工具（`tools.search` / `tools.describe` / `tools.call` / `tools.<server>__<tool>(args)`）。
 *
 * 为什么值得单开一个工具：一次请求里要「先搜、再按结果挑、再串起来调、再过滤」时，代理工具 `mcp`
 * 每个动作都要一次模型往返；脚本把这些循环/分支压在**一次工具调用**内完成（pi-mcp-adapter 的
 * `mcpScript` 就是这个思路，用户已确认沿用）。
 *
 * 安全边界（重要，别误解）：这是**agent 自己写的可信脚本层，不是隔离边界**——沙箱只是
 * `node:vm` 上下文 + `codeGeneration: {strings:false, wasm:false}`，通过 `tools.*` 拿到的宿主函数
 * 仍可能反推宿主能力（README 级事实，与 pi-mcp-adapter 的自我描述一致）。worker 线程给的是
 * **超时与终止能力**（死循环不会卡住 backend 主线程），不是权限隔离。真正的权限边界是权限门控
 * 扩展对 `mcpScript` 工具本身的 ask（`DEFAULT_PERMISSION_CONFIG.rules.mcpScript === "ask"`）。
 *
 * worker 用 `data:` URL + `type: "module"` 起（而不是 `eval: true`）：`eval` 的模块类型取决于
 * 启动目录的 package.json，打包后不可控；data URL 行为确定，也不需要额外分发资产文件。
 */

import { Worker } from "node:worker_threads";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../log";
import { type McpService, parseToolPath } from "./service";

const log = createLogger("mcp-script");

/** 默认与上限超时（脚本是 agent 写的，卡死必须有人收） */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 单条 console/emit 文本与整份日志的上限（防脚本刷屏把上下文烧掉） */
const MAX_TEXT_CHARS = 4_000;
const MAX_LOG_LINES = 100;
/** 单次远端调用回给脚本的上限与整份脚本的累计预算（与 pi-mcp-adapter 的 16MiB 同量级） */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;

/** 一次远端调用的轨迹（模型看汇总，UI 看明细；不进参数原文——参数可能又大又含凭据） */
export interface McpScriptCallTrace {
	op: "search" | "describe" | "call";
	/** 调用目标（search 是查询串，其余是 `<server>__<tool>`） */
	target: string;
	ok: boolean;
	ms: number;
	error?: string;
}

export interface McpScriptDetails {
	calls: McpScriptCallTrace[];
	/** console / emit 的输出（截断后的尾段） */
	logs: string[];
	timedOut: boolean;
}

const mcpScriptParams = Type.Object({
	code: Type.String({
		description:
			"JavaScript source. Await tools.search({ query, server? }) to find tools, tools.describe({ path }) to inspect one, " +
			"tools.call(path, args) or tools.<server>__<tool>(args) to call one. Return a value to send it back.",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			minimum: 1_000,
			maximum: MAX_TIMEOUT_MS,
			description: `Script budget in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
		}),
	),
});

/** worker 源码（ESM，经 data: URL 装载）：只做「沙箱 + RPC 转发」，协议语义全在父线程 */
const WORKER_SOURCE = `import { parentPort, workerData } from "node:worker_threads";
import { formatWithOptions } from "node:util";
import vm from "node:vm";

const RESERVED_PROPS = new Set(["then", "catch", "finally", "toJSON", "toString", "valueOf"]);
const pending = new Map();
let seq = 0;

function request(op, payload) {
	return new Promise((resolve) => {
		const id = ++seq;
		pending.set(id, resolve);
		parentPort.postMessage({ kind: "call", id: id, op: op, ...payload });
	});
}

parentPort.on("message", (message) => {
	if (!message || typeof message !== "object" || message.kind !== "result") return;
	const resolve = pending.get(message.id);
	if (resolve === undefined) return;
	pending.delete(message.id);
	resolve(message.payload);
});

function formatValue(value) {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value, null, 2);
		if (json !== undefined) return json;
	} catch (error) {
		// 循环引用/自定义 toJSON 抛错时退回 util.inspect
	}
	return formatWithOptions({ colors: false, depth: 6 }, value);
}

function emitText(text) {
	parentPort.postMessage({ kind: "text", text: text });
}

const tools = new Proxy(Object.create(null), {
	get(_target, property) {
		if (property === "search") return (input) => request("search", { input: input === undefined ? {} : input });
		if (property === "describe") {
			return (input) => request("describe", { path: typeof input === "string" ? input : (input && input.path) });
		}
		if (property === "call") {
			return (path, args, options) => {
				if (typeof path !== "string" || path.trim() === "") {
					return Promise.resolve({
						ok: false,
						error: { code: "invalid_path", message: "tools.call(path, args) needs a non-empty path like \\"server__tool\\"." },
					});
				}
				const extra = options && typeof options === "object" ? options : {};
				return request("call", {
					path: path,
					args: args,
					inputResponses: extra.inputResponses,
					requestState: extra.requestState,
				});
			};
		}
		if (typeof property !== "string" || RESERVED_PROPS.has(property)) return undefined;
		// 简写：tools.<server>__<tool>(args)
		return (args) => request("call", { path: property, args: args });
	},
	ownKeys() {
		throw new Error("tools is not enumerable — use tools.search({ query }) to discover tools");
	},
});

const emit = (value) => emitText(formatValue(value));
const capturedConsole = Object.freeze({
	log: (...args) => emitText("[log] " + formatWithOptions({ colors: false, depth: 4 }, ...args)),
	info: (...args) => emitText("[info] " + formatWithOptions({ colors: false, depth: 4 }, ...args)),
	warn: (...args) => emitText("[warn] " + formatWithOptions({ colors: false, depth: 4 }, ...args)),
	error: (...args) => emitText("[error] " + formatWithOptions({ colors: false, depth: 4 }, ...args)),
	debug: (...args) => emitText("[debug] " + formatWithOptions({ colors: false, depth: 4 }, ...args)),
});

// 定时器给「轮询到完成再返回」这类脚本用（远端长任务的标准用法）；脚本结束时 worker 被终止，
// 遗留的 interval 不会泄漏到宿主。其余宿主全局（process/require/fs/fetch）一律不进沙箱。
const sandboxGlobals = {
	tools: tools,
	emit: emit,
	console: capturedConsole,
	setTimeout: setTimeout,
	clearTimeout: clearTimeout,
	setInterval: setInterval,
	clearInterval: clearInterval,
	queueMicrotask: queueMicrotask,
};

try {
	const context = vm.createContext(Object.assign(Object.create(null), sandboxGlobals), {
		codeGeneration: { strings: false, wasm: false },
		name: "mcpScript",
	});
	const script = new vm.Script("(async () => {\\n" + workerData.code + "\\n})()", { filename: "mcpScript.js" });
	const value = await script.runInContext(context);
	parentPort.postMessage({ kind: "done", text: value === undefined ? null : formatValue(value) });
} catch (error) {
	parentPort.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
}
`;

/** worker 装载地址（base64 data URL，构建期与运行期都不依赖文件路径） */
function workerUrl(): URL {
	const encoded = Buffer.from(WORKER_SOURCE, "utf8").toString("base64");
	return new URL(`data:text/javascript;base64,${encoded}`);
}

interface ScriptCallMessage {
	kind: "call";
	id: number;
	op: "search" | "describe" | "call";
	input?: unknown;
	path?: unknown;
	args?: unknown;
	inputResponses?: unknown;
	requestState?: unknown;
}

/** 脚本里一次 `tools.*` 调用的处理结果（父线程 → worker 的载荷） */
interface ScriptCallPayload {
	ok: boolean;
	[field: string]: unknown;
}

/** 单次调用的上限与累计预算：超限回错误而不是把 backend 内存吃掉 */
class ScriptBudget {
	private used = 0;

	/** 结算一次响应：返回是否仍在预算内（超限的响应不回给脚本） */
	charge(payload: ScriptCallPayload): boolean {
		const size = Buffer.byteLength(JSON.stringify(payload) ?? "");
		if (size > MAX_PAYLOAD_BYTES || this.used + size > MAX_SCRIPT_BYTES) return false;
		this.used += size;
		return true;
	}
}

/** 把脚本里的一次调用翻译成 McpService 的调用（任何失败都回 `{ok:false}`，不抛到脚本外） */
async function dispatchScriptCall(
	service: McpService,
	message: ScriptCallMessage,
	signal: AbortSignal | undefined,
): Promise<ScriptCallPayload> {
	try {
		if (message.op === "search") {
			const input = (message.input ?? {}) as { query?: unknown; server?: unknown; limit?: unknown };
			const found = await service.searchTools(typeof input.query === "string" ? input.query : "", {
				server: typeof input.server === "string" ? input.server : undefined,
				limit: typeof input.limit === "number" ? input.limit : undefined,
				signal,
			});
			return {
				ok: true,
				items: found.tools.map((tool) => ({
					path: `${tool.server}__${tool.name}`,
					name: tool.name,
					server: tool.server,
					description: tool.description ?? null,
				})),
				total: found.tools.length,
				failed: found.failed,
				pending: found.pending,
			};
		}
		if (typeof message.path !== "string") {
			return {
				ok: false,
				error: { code: "invalid_path", message: 'path must be a string like "server__tool"' },
			};
		}
		if (message.op === "describe") {
			const tool = await service.describeTool(message.path, signal);
			return {
				ok: true,
				path: `${tool.server}__${tool.name}`,
				name: tool.name,
				server: tool.server,
				description: tool.description ?? null,
				inputSchema: tool.inputSchema ?? null,
			};
		}
		const { server, tool } = parseToolPath(message.path);
		const result = await service.callRemoteTool(server, tool, message.args ?? {}, {
			inputResponses: recordOf(message.inputResponses),
			requestState: typeof message.requestState === "string" ? message.requestState : undefined,
			signal,
		});
		return {
			ok: true,
			result: {
				isError: result.isError,
				content: result.content,
				structured: result.structured ?? null,
				inputRequests: result.inputRequests ?? null,
				requestState: result.requestState ?? null,
			},
		};
	} catch (err) {
		return {
			ok: false,
			error: { code: "call_failed", message: err instanceof Error ? err.message : String(err) },
		};
	}
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export interface McpScriptOutcome {
	/** 脚本 return 值的文本投影；undefined → null */
	returnText: string | null;
	logs: string[];
	calls: McpScriptCallTrace[];
	timedOut: boolean;
}

/**
 * 跑一段脚本：建 worker → 双向 RPC → 收尾（无论成功/超时/中止都 terminate，绝不留孤儿线程）。
 * 日志与轨迹在父线程累积（worker 只负责转发），这样超时被 terminate 时已产出的痕迹也不丢。
 */
export async function runMcpScript(options: {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	dispatch: (message: ScriptCallMessage) => Promise<ScriptCallPayload>;
}): Promise<McpScriptOutcome> {
	// data: URL 的 `text/javascript` MIME 就让 Node 按 ESM 装载，无需（Node 类型里也没有）`type` 选项
	const worker = new Worker(workerUrl(), { workerData: { code: options.code } });
	const logs: string[] = [];
	const calls: McpScriptCallTrace[] = [];
	const budget = new ScriptBudget();
	let timedOut = false;
	let settled = false;

	const pushLog = (raw: string): void => {
		const text = raw.length > MAX_TEXT_CHARS ? `${raw.slice(0, MAX_TEXT_CHARS)}… (truncated)` : raw;
		if (logs.length >= MAX_LOG_LINES) {
			// 只留一条省略标记：脚本刷屏不能把上下文吃掉
			if (logs[logs.length - 1] !== "… more output suppressed") logs.push("… more output suppressed");
			return;
		}
		logs.push(text);
	};

	/** 脚本里一次 `tools.*` 调用的处理：派发 → 预算结算 → 回投（worker 侧 resolve 对应挂起） */
	async function handleCall(message: ScriptCallMessage): Promise<void> {
		const started = Date.now();
		const payload = await options.dispatch(message);
		const trace: McpScriptCallTrace = {
			op: message.op,
			target:
				typeof message.path === "string"
					? message.path
					: JSON.stringify(message.input ?? "")
							.slice(0, 120)
							.replace(/^"|"$/g, ""),
			ok: payload.ok === true,
			ms: Date.now() - started,
		};
		if (payload.ok !== true) {
			const error = recordOf(payload.error);
			trace.error = typeof error?.message === "string" ? error.message : "failed";
		}
		calls.push(trace);
		if (!budget.charge(payload)) {
			// 超预算：不回巨型载荷，只把事实告诉脚本（它据此收窄查询）
			worker.postMessage({
				kind: "result",
				id: message.id,
				payload: {
					ok: false,
					error: {
						code: "payload_too_large",
						message: `result exceeded the per-call budget (${MAX_PAYLOAD_BYTES} bytes) or the per-script budget (${MAX_SCRIPT_BYTES} bytes); narrow the query`,
					},
				},
			});
			return;
		}
		worker.postMessage({ kind: "result", id: message.id, payload });
	}

	// 三方外部结算（脚本 done / 超时 / signal 中止）都要清理定时器与监听器，故监听器全在 executor 内注册。
	// 不用 `Promise.withResolvers`：它属 ES2024，本仓 lib 是 ES2023（tsconfig.base.json）。
	const completion = new Promise<{ returnText: string | null }>((resolve, reject) => {
		const onAbort = () => fail(new Error("mcpScript aborted"));
		const finish = (): boolean => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			return true;
		};
		function fail(error: Error): void {
			if (finish()) reject(error);
		}

		const timer = setTimeout(() => {
			timedOut = true;
			fail(
				new Error(
					`mcpScript timed out after ${options.timeoutMs}ms; keep scripts bounded or raise timeoutMs`,
				),
			);
		}, options.timeoutMs);
		timer.unref();
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		worker.on("message", (message: Record<string, unknown>) => {
			if (settled) return;
			if (message.kind === "text") {
				pushLog(typeof message.text === "string" ? message.text : String(message.text));
				return;
			}
			if (message.kind === "done") {
				if (!finish()) return;
				resolve({ returnText: typeof message.text === "string" ? message.text : null });
				return;
			}
			if (message.kind === "error") {
				fail(new Error(typeof message.message === "string" ? message.message : "mcpScript failed"));
				return;
			}
			if (message.kind === "call") void handleCall(message as unknown as ScriptCallMessage);
		});
		worker.on("error", (err) => {
			fail(err instanceof Error ? err : new Error(String(err)));
		});
		worker.on("exit", (code) => {
			fail(new Error(`mcpScript worker exited with code ${code} before returning a value`));
		});
	});

	try {
		const outcome = await completion;
		log.debug("script finished", { calls: calls.length, timedOut, logs: logs.length });
		return { returnText: outcome.returnText, logs, calls, timedOut };
	} finally {
		// 成功/超时/中止都终止线程：脚本可能有未结算的 promise 或死循环，留着就是泄漏
		await worker.terminate();
	}
}

/**
 * `mcpScript` 工具：把脚本执行 + 远端调用派发 + 结果投影拼起来。
 * 零服务器时也不注册（见 pi-backend.buildCustomTools）——没有 MCP 可调时它只是个空壳。
 */
export function makeMcpScriptTool(service: McpService): ToolDefinition<typeof mcpScriptParams> {
	return {
		name: "mcpScript",
		label: "MCP Script",
		description:
			"Run JavaScript that makes several MCP calls in ONE request — loop, filter, chain, or fan out between them.\n" +
			"API inside the script (all async):\n" +
			"- await tools.search({ query, server? }) → { items: [{ path, name, server, description }], total, failed, pending }\n" +
			"- await tools.describe({ path }) → { name, server, description, inputSchema }\n" +
			"- await tools.call(path, args) → { ok: true, result: { isError, content, structured, inputRequests, requestState } } (or { ok: false, error })\n" +
			"- shorthand: await tools.<server>__<tool>(args)\n" +
			"- console.log(...) and emit(value) add text to the output; return a value to send it back as the result.\n" +
			"The path format is `<server>__<tool>` from tools.search. Use the mcp tool instead for a single search/describe/call.",
		promptSnippet: "mcpScript({ code })",
		promptGuidelines: [
			"Reach for mcpScript when one request needs several MCP calls with logic between them; a single call is cheaper via mcp.",
			"Inside mcpScript, discover tools with tools.search({ query }) before calling paths you have not seen.",
		],
		parameters: mcpScriptParams,
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<McpScriptDetails>> => {
			const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
			const outcome = await runMcpScript({
				code: params.code,
				timeoutMs,
				signal,
				dispatch: (message) => dispatchScriptCall(service, message, signal),
			});
			const content: (TextContent | ImageContent)[] = [];
			if (outcome.logs.length > 0) content.push({ type: "text", text: outcome.logs.join("\n") });
			content.push({
				type: "text",
				text: outcome.returnText ?? "(the script returned no value)",
			});
			const failed = outcome.calls.filter((call) => !call.ok);
			if (failed.length > 0) {
				content.push({
					type: "text",
					text: `${failed.length}/${outcome.calls.length} MCP calls failed: ${failed
						.map((call) => `${call.target} (${call.error ?? "failed"})`)
						.join("; ")}`,
				});
			}
			return {
				content,
				details: { calls: outcome.calls, logs: outcome.logs, timedOut: outcome.timedOut },
			};
		},
	};
}
