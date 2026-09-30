/**
 * stdio 传输绑定（规范 basic/transports/stdio）：子进程的 stdin/stdout 是双向 JSON-RPC 帧流，
 * stderr 只作为旁路日志（绝不注入协议流）。
 *
 * 这里只做「帧 + 生命周期」：单行 JSON → 投递，进程退出 → 报错。协议语义（世代探测、capabilities、
 * 重连）都在 client.ts / registry.ts。
 *
 * 三个必须踩住的坑（实现里都有对应分支，注释标了原因）：
 * 1. 裸命令名在 Windows 上 `spawn("npx")` 直接 ENOENT —— npm/npx 只有 `.cmd` shim，必须自己解析；
 * 2. 解析到 `.cmd`/`.bat` 后**不能**用 shell:false 直接 spawn —— Node v20.12.2 起抛 EINVAL（实测），
 *    只能经 cmd.exe 启动，且引号必须自己加（Node 的 `shell: true` 只按空格拼接实参，含空格的路径会被拆开）；
 * 3. 关闭要杀进程树 —— `.cmd` 启动时真正干活的是 cmd.exe 的孙子进程，只 kill 直接子进程会留孤儿。
 *
 * 异步等待一律用 `events.once` / `timers/promises`：本仓 tsconfig 的 lib 是 ES2023（没有
 * `Promise.withResolvers`），事件等待用这两者即可，不必手搓 Promise 执行器。
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../../log";
import { asRecord } from "../json";
import {
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type McpTransport,
	McpTransportError,
	type McpTransportOptions,
	type ServerMessage,
	type TransportDelivery,
} from "../transport";

const log = createLogger("mcp-stdio");

/**
 * 单条消息的防御上限（16MB，与 http.ts 的 body 上限一致）。
 * 以 UTF-16 码元计，多字节字符会更早触发：这是「别被畸形输出打爆内存」的护栏，不追求逐字节精确。
 */
const MAX_MESSAGE_CODE_UNITS = 16 * 1024 * 1024;

/** close() 先关 stdin 等子进程善终；超时才杀进程树（给服务器机会写完自己的清理日志） */
const EXIT_GRACE_MS = 800;

/** 杀完之后仍不退出就放弃等待，保证 close() 一定结算（避免宿主被卡住） */
const KILL_SETTLE_MS = 2_000;

/** 进程退出错误里附带的 stderr 尾部行数：诊断价值最高的就是最后几行 */
const STDERR_TAIL_LINES = 5;

/**
 * `inheritEnv: false` 时的最小必要变量集合。
 * 少了 PATH/PATHEXT/SystemRoot（Windows）或 HOME（POSIX）会让 node/npx 连自身路径都找不到；
 * 其余是与宿主无关的常规变量，保留只是为了让子进程的默认行为（临时目录、编码）可预期。
 */
const MINIMAL_ENV_KEYS = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"windir",
	"TEMP",
	"TMP",
	"COMSPEC",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"SystemDrive",
	"LANG",
	"LC_ALL",
];

/**
 * 子进程环境。
 * 默认继承宿主（`inheritEnv: true`）：宿主 env 里可能残留构建期变量——见
 * `packages/desktop/src/main/ui-plugins/build.ts` 的注释（ESBUILD_BINARY_PATH 会随 spawn 泄漏给包括 MCP 在内的
 * 所有子进程）——但 MCP 生态的默认语义就是继承宿主环境（各家 `mcpServers.env` 都是「附加」语义），
 * 所以默认仍是继承，用户要用干净环境时把 `inheritEnv` 关掉即可。
 */
function buildEnv(options: Extract<McpTransportOptions, { kind: "stdio" }>): NodeJS.ProcessEnv {
	if (options.inheritEnv) return { ...process.env, ...options.env };
	const env: NodeJS.ProcessEnv = {};
	for (const key of MINIMAL_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...options.env };
}

/**
 * 扩展名候选顺序：Windows 上 npm/npx 只提供 `.cmd` shim（没有对应 `.exe`），所以 `.cmd` 优先；
 * POSIX 上可执行文件本来就无扩展名，扩展名只是兜底。
 */
function extensionCandidates(name: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
	return [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`];
}

/**
 * 把配置里的 command 解析成可执行文件绝对路径；解析不到返回 null。
 * - 含路径分隔符：先看原样，再按扩展名候选补全（配置里写 `./bin/server` 很常见）；
 * - 裸命令名：逐个 PATH 目录 × 候选扩展名查找（Windows 一定要补 `.cmd`，否则 npx 这类只有 shim 的命令找不到）。
 */
function resolveCommandFile(command: string, env: NodeJS.ProcessEnv): string | null {
	if (command.includes("/") || command.includes("\\")) {
		if (existsSync(command)) return command;
		if (extname(command) === "") {
			for (const candidate of extensionCandidates(command, process.platform)) {
				if (existsSync(candidate)) return candidate;
			}
		}
		return null;
	}
	for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (dir === "") continue;
		for (const candidate of extensionCandidates(command, process.platform)) {
			const full = join(dir, candidate);
			if (existsSync(full)) return full;
		}
	}
	return null;
}

/**
 * cmd.exe 命令行拼装。
 * 最外层成对引号是 `/s` 语义的一部分：`cmd /s /c` 会剥掉整行首尾各一个引号，剩下的才是真正的命令行，
 * 形如 `""C:\path\server.cmd" "--port" "1 2""`。实参含空格或 cmd 元字符时补一对引号，
 * 内嵌双引号按 cmd 的习惯写成两个（`""`）。
 * 已知限制：实参里的 `%` 仍会被 cmd.exe 当变量引用处理，这里不转义（MCP 服务器参数里几乎不会出现，
 * 为此引入完整 cmd 转义规则得不偿失）。
 */
function buildCmdLine(target: string, args: string[]): string {
	const quote = (value: string): string => {
		if (!/[\s&|<>^"]/.test(value)) return value;
		return `"${value.replace(/"/g, '""')}"`;
	};
	return `""${target}"${args.map((arg) => ` ${quote(arg)}`).join("")}"`;
}

/** POSIX shell 兜底时的单引号转义：不引起来会被 sh 按空格与元字符拆开（`'` 用 `'\''` 收尾再续） */
function quotePosix(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

interface LaunchPlan {
	/** 实际 spawn 的文件（Windows 的 `.cmd`/`.bat` 是 cmd.exe） */
	file: string;
	args: string[];
	/** 是否交给 shell 解释（POSIX 的兜底路径） */
	shell: boolean;
	/** Windows 经 cmd.exe 启动：命令行引号由我们自己拼好，不能让 Node 再处理一遍 */
	verbatim: boolean;
	/** 诊断文案：解析到了什么（错误消息里带上，用户能立刻看出解析结果） */
	detail: string;
}

/**
 * 决定怎么启动：
 * - 解析到普通可执行文件（`.exe`/无扩展名）→ 不带 shell 直接 spawn（参数按数组传，Node 自己处理引号）；
 * - Windows 解析到 `.cmd`/`.bat` → 经 cmd.exe（Node 禁止直接 spawn 批处理，见文件头注释）；
 * - 裸命令名什么都没解析到 → 回退 shell 语义，让 cmd.exe / sh 用自己的规则再找一次；
 * - 显式路径（含分隔符）没解析到 → 不退 shell：直接 spawn 让它 ENOENT，
 *   这样 start() 能拿到「命令不存在 + 解析过的路径」这种可读错误，而不是被 shell 的 127 吞掉。
 */
function buildLaunchPlan(command: string, args: string[], env: NodeJS.ProcessEnv): LaunchPlan {
	const resolved = resolveCommandFile(command, env);
	const hasSeparator = command.includes("/") || command.includes("\\");
	if (process.platform !== "win32") {
		if (resolved !== null) return { file: resolved, args, shell: false, verbatim: false, detail: resolved };
		if (hasSeparator) return { file: command, args, shell: false, verbatim: false, detail: command };
		return {
			file: quotePosix(command),
			args: args.map(quotePosix),
			shell: true,
			verbatim: false,
			detail: `shell lookup of ${command}`,
		};
	}
	const isBatch = resolved !== null && /\.(cmd|bat)$/i.test(resolved);
	if (resolved !== null && !isBatch) {
		return { file: resolved, args, shell: false, verbatim: false, detail: resolved };
	}
	if (resolved === null && hasSeparator) {
		return { file: command, args, shell: false, verbatim: false, detail: command };
	}
	const target = resolved ?? command;
	return {
		file: env.COMSPEC ?? env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", buildCmdLine(target, args)],
		shell: false,
		verbatim: true,
		detail: resolved ?? `shell lookup of ${command}`,
	};
}

/**
 * 线上消息的形状校验：必须是 JSON-RPC 2.0 对象。
 * 服务器往 stdout 打日志（而不是走 stderr）是常见事故，这里判成噪声而不是投递给 client。
 */
function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	const record = asRecord(value);
	if (record === null || record.jsonrpc !== "2.0") return false;
	if (typeof record.method === "string") return true;
	return "id" in record && ("result" in record || "error" in record);
}

export function createStdioTransport(options: Extract<McpTransportOptions, { kind: "stdio" }>): McpTransport {
	const env = buildEnv(options);
	const messageHandlers = new Set<(delivery: TransportDelivery) => void>();
	const errorHandlers = new Set<(error: McpTransportError) => void>();
	const logHandlers = new Set<(line: string) => void>();

	let child: ChildProcess | null = null;
	let started = false;
	let closed = false;
	/** 进程级故障只报一次：退出后再 send 一律复用它（调用方能看到「进程已退出」而不是重连语义） */
	let processError: McpTransportError | null = null;
	const stderrTail: string[] = [];

	const emitMessage = (delivery: TransportDelivery): void => {
		if (closed) return;
		for (const handler of [...messageHandlers]) handler(delivery);
	};
	const emitError = (error: McpTransportError): void => {
		if (closed) return;
		for (const handler of [...errorHandlers]) handler(error);
	};
	const emitLog = (line: string): void => {
		if (closed) return;
		for (const handler of [...logHandlers]) handler(line);
	};

	/** 诊断文案：命令 + 实参 + cwd（三者任一错都会 ENOENT，错误里都给出来省得来回问） */
	const describeCommand = (): string => {
		const args = options.args.length > 0 ? ` ${options.args.join(" ")}` : "";
		const cwd = options.cwd === undefined ? "" : ` (cwd: ${options.cwd})`;
		return `"${options.command}${args}"${cwd}`;
	};

	const reportSpawnFailure = (err: Error, plan: LaunchPlan): McpTransportError => {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return new McpTransportError(
				`Command not found: ${describeCommand()}. Resolved to ${plan.detail}. ` +
					"Check the command and cwd fields of this MCP server.",
				{ failure: "process", cause: err },
			);
		}
		return new McpTransportError(`Failed to start ${describeCommand()} via ${plan.detail}: ${err.message}`, {
			failure: "process",
			cause: err,
		});
	};

	/** 解析失败 / 非 JSON 的输出：只进日志通道，不致命也不抛（服务器刷日志不能拖垮整条连接） */
	const reportNoise = (line: string): void => {
		log.warn("non JSON-RPC output from MCP server", { command: options.command, line: line.slice(0, 200) });
		emitLog(`[stdout] ${line.slice(0, 2000)}`);
	};

	const handleStdoutLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			reportNoise(line);
			return;
		}
		if (!isJsonRpcMessage(parsed)) {
			reportNoise(line);
			return;
		}
		// 服务端反向请求（带 id 的 method）也会投递：client 明确要拒绝这类消息（rejectServerRequest），
		// 只是 ServerMessage 类型描述的是常态方向，这里按协议事实原样交出。
		emitMessage({ message: parsed as ServerMessage });
	};

	const handleStderrLine = (line: string): void => {
		if (line.trim() === "") return;
		stderrTail.push(line);
		if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
		emitLog(line);
	};

	const attach = (proc: ChildProcess): void => {
		const stdoutDecoder = new StringDecoder("utf8");
		let stdoutBuffer = "";
		/** 超限丢弃后，行尾之前的内容都是那条被丢消息的残渣 */
		let droppingOversized = false;

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuffer += stdoutDecoder.write(chunk);
			if (droppingOversized) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline < 0) {
					stdoutBuffer = "";
					return;
				}
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				droppingOversized = false;
			}
			let index = stdoutBuffer.indexOf("\n");
			while (index >= 0) {
				// 容忍 \r\n：JSON.parse 见到尾部 \r 会报错，白白丢消息
				const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				if (line.trim() !== "") handleStdoutLine(line);
				index = stdoutBuffer.indexOf("\n");
			}
			if (stdoutBuffer.length > MAX_MESSAGE_CODE_UNITS) {
				log.warn("dropping oversized stdio message", {
					command: options.command,
					codeUnits: stdoutBuffer.length,
				});
				emitLog(`Dropped oversized MCP stdio message (>${MAX_MESSAGE_CODE_UNITS} code units)`);
				stdoutBuffer = "";
				droppingOversized = true;
			}
		});

		const stderrDecoder = new StringDecoder("utf8");
		let stderrBuffer = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += stderrDecoder.write(chunk);
			let index = stderrBuffer.indexOf("\n");
			while (index >= 0) {
				handleStderrLine(stderrBuffer.slice(0, index).replace(/\r$/, ""));
				stderrBuffer = stderrBuffer.slice(index + 1);
				index = stderrBuffer.indexOf("\n");
			}
		});

		// 不监听 'error' 会让 spawn 之后的写入失败变成未捕获异常，这里只记录（真正的故障由 'close' 汇报）
		proc.on("error", (err) => {
			log.warn("stdio child process error", { command: options.command, message: err.message });
		});

		// 用 'close'（stdio 全部排空）而不是 'exit'：这样服务器最后那条没换行的消息也能先投递，再报进程退出
		proc.on("close", (code, signal) => {
			if (closed) return; // 我们自己关的：不算故障，close() 已经解除全部订阅
			if (stderrBuffer.trim() !== "") handleStderrLine(stderrBuffer);
			if (stdoutBuffer.trim() !== "") handleStdoutLine(stdoutBuffer.replace(/\r$/, ""));
			stdoutBuffer = "";
			const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
			const tail = stderrTail.length === 0 ? "" : `. Last stderr lines:\n${stderrTail.join("\n")}`;
			processError = new McpTransportError(
				`MCP server process exited with ${reason}: ${describeCommand()}${tail}`,
				{ failure: "process" },
			);
			log.warn("stdio server exited", { command: options.command, code, signal });
			emitError(processError);
		});
	};

	const startProcess = async (): Promise<void> => {
		const plan = buildLaunchPlan(options.command, options.args, env);
		let proc: ChildProcess;
		try {
			proc = spawn(plan.file, plan.args, {
				cwd: options.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: plan.shell,
				// POSIX 下用独立进程组启动，close() 才能用 -pid 整组杀掉；Windows 走 taskkill /T
				detached: process.platform !== "win32",
				...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
			});
		} catch (err) {
			throw reportSpawnFailure(err instanceof Error ? err : new Error(String(err)), plan);
		}
		child = proc;
		attach(proc);
		log.info("spawning MCP server", { command: options.command, resolved: plan.detail, pid: proc.pid });
		try {
			// 'spawn' 才代表 exec 成功；ENOENT 等失败以 'error' 事件到达，events.once 会把它转成 reject
			await once(proc, "spawn");
		} catch (err) {
			if (child === proc) child = null;
			throw reportSpawnFailure(err instanceof Error ? err : new Error(String(err)), plan);
		}
	};

	const writeToStdin = async (line: string): Promise<void> => {
		const stdin = child?.stdin;
		if (stdin === null || stdin === undefined || stdin.destroyed) {
			throw processError ?? new Error("MCP server stdin is not writable");
		}
		// write() 返回 true = 数据已被流缓冲接纳（内核写入已发起）；false = 有积压，等 drain。
		// 用 'drain' 而不是 write 回调：写失败（EPIPE）同样以 'error' 事件出现，events.once 会把它转成 reject。
		if (stdin.write(line)) return;
		await once(stdin, "drain");
	};

	/** 关闭时先关 stdin 等善终，超时再杀进程树；Windows 用 taskkill /T，POSIX 用独立进程组 */
	const killProcessTree = async (proc: ChildProcess): Promise<void> => {
		const pid = proc.pid;
		if (pid === undefined) return;
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
			// taskkill 缺失/被策略拦下时 spawn 会报 'error'（没有 'close'），once 转成 reject，吞掉即可
			await once(killer, "close").catch(() => undefined);
			proc.kill("SIGKILL");
			return;
		}
		try {
			// 负 pid = 整个进程组（spawn 时 detached: true 建的），孙子进程一起收掉
			process.kill(-pid, "SIGKILL");
		} catch {
			// 没有独立进程组时只能杀直接子进程：孙进程可能残留（POSIX 上 detached 未生效的场景）
			proc.kill("SIGKILL");
		}
	};

	return {
		kind: "stdio",

		async start(): Promise<void> {
			if (closed) throw new Error("MCP stdio transport is closed");
			if (started) return; // 幂等：重复 start 不重复 spawn
			await startProcess();
			started = true;
		},

		async send(message: JsonRpcMessage): Promise<void> {
			if (closed) throw new Error("MCP stdio transport is closed");
			if (!started) throw new Error("MCP stdio transport is not started");
			if (processError !== null) throw processError;
			await writeToStdin(`${JSON.stringify(message)}\n`);
		},

		async cancel(id: JsonRpcId): Promise<void> {
			// 进程没起/已退出：没有取消可谈，静默（规范允许取消通知被丢弃）
			if (closed || !started || processError !== null) return;
			const notification: JsonRpcNotification = {
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, reason: "client cancelled" },
			};
			await writeToStdin(`${JSON.stringify(notification)}\n`).catch((err: unknown) => {
				log.warn("failed to send notifications/cancelled", { requestId: String(id), message: String(err) });
			});
		},

		onMessage(handler: (delivery: TransportDelivery) => void): () => void {
			messageHandlers.add(handler);
			return () => messageHandlers.delete(handler);
		},

		onError(handler: (error: McpTransportError) => void): () => void {
			errorHandlers.add(handler);
			return () => errorHandlers.delete(handler);
		},

		onLog(handler: (line: string) => void): () => void {
			logHandlers.add(handler);
			return () => logHandlers.delete(handler);
		},

		setProtocolVersion(): void {
			// stdio 没有协议版本头（MCP-Protocol-Version 只存在于 HTTP 绑定）：版本语义在 client 的握手消息里
		},

		setAuthHeaders(): void {
			// stdio 没有请求头：凭据只能通过 env / 服务器自己的配置文件提供
		},

		sessionId(): string | null {
			// stdio 没有绑定层会话标识：进程本身就是会话
			return null;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			// 先解除订阅：close 之后（包括 close 自己引发的进程退出）不允许再有任何投递
			messageHandlers.clear();
			errorHandlers.clear();
			logHandlers.clear();
			const proc = child;
			if (proc === null) return;
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			// 优雅路径：关 stdin → 服务器自己退出（MCP 服务器都把 stdin end 当停机信号）
			proc.stdin?.end();
			const killer = setTimeout(() => void killProcessTree(proc), EXIT_GRACE_MS);
			killer.unref?.();
			// 竞速保证 close() 一定结算：即使进程树杀不掉也只多等 KILL_SETTLE_MS
			await Promise.race([
				once(proc, "close").catch(() => undefined),
				delay(EXIT_GRACE_MS + KILL_SETTLE_MS, undefined, { ref: false }),
			]);
			clearTimeout(killer);
		},
	};
}
