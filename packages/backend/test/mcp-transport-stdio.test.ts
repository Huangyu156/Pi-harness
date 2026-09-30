/**
 * stdio 传输绑定测试：跑**真实子进程**（node + test/fixtures/mcp/echo-server.mjs），不用 mock。
 * 覆盖：往返帧、stderr 旁路、cancel 通知落地、进程退出错误、优雅 close、命令解析失败的可读报错，
 * 以及 Windows `.cmd` shim 解析（裸命令名 + 含空格的路径与实参）。
 */

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asRecord, recordArray, recordString } from "../src/mcp/json";
import type {
	McpTransport,
	McpTransportError,
	McpTransportOptions,
	TransportDelivery,
} from "../src/mcp/transport";
import { createStdioTransport } from "../src/mcp/transports/stdio";

const ECHO_SERVER = fileURLToPath(new URL("./fixtures/mcp/echo-server.mjs", import.meta.url));

type StdioOptions = Extract<McpTransportOptions, { kind: "stdio" }>;

/** 逐条记录传输的三条通道，并提供「等到某条件成立」的轮询（避免测试静默挂死） */
interface Recorder {
	deliveries: TransportDelivery[];
	errors: McpTransportError[];
	logs: string[];
	waitFor(predicate: () => boolean, label: string): Promise<void>;
}

function record(transport: McpTransport): Recorder {
	const deliveries: TransportDelivery[] = [];
	const errors: McpTransportError[] = [];
	const logs: string[] = [];
	transport.onMessage((delivery) => deliveries.push(delivery));
	transport.onError((error) => errors.push(error));
	transport.onLog((line) => logs.push(line));
	return {
		deliveries,
		errors,
		logs,
		async waitFor(predicate: () => boolean, label: string): Promise<void> {
			const deadline = Date.now() + 5_000;
			while (!predicate()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
				await delay(10, undefined, { ref: false });
			}
		},
	};
}

const transports: McpTransport[] = [];
const tempDirs: string[] = [];

/** 起一个传输并订阅三条通道：测试结束由 afterEach 统一 close */
async function startTransport(options: StdioOptions): Promise<{ transport: McpTransport; rec: Recorder }> {
	const transport = createStdioTransport(options);
	transports.push(transport);
	const rec = record(transport);
	await transport.start();
	return { transport, rec };
}

function echoOptions(overrides: Partial<StdioOptions> = {}): StdioOptions {
	return {
		kind: "stdio",
		command: process.execPath,
		args: [ECHO_SERVER],
		env: {},
		inheritEnv: true,
		...overrides,
	};
}

/** 取出投递里的 result（形状由 fixture 决定，用仓库的收窄工具读，不做整块类型断言） */
function resultOf(message: unknown): Record<string, unknown> {
	const result = asRecord(asRecord(message)?.result);
	if (result === null) throw new Error("delivery is not a JSON-RPC result response");
	return result;
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(transports.splice(0).map((transport) => transport.close()));
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stdio 传输", () => {
	it("往返请求与响应：initialize / tools/call 回显（含多字节字符）", async () => {
		const { transport, rec } = await startTransport(echoOptions());

		await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 1, "initialize 响应");

		const first = rec.deliveries[0];
		expect(first?.httpStatus).toBeUndefined(); // stdio 没有 httpStatus
		expect(first?.message).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: { protocolVersion: "2025-06-18", serverInfo: { name: "echo" } },
		});

		const params = { name: "echo", arguments: { text: "值 with multi-byte" } };
		await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params });
		await rec.waitFor(() => rec.deliveries.length >= 2, "tools/call 响应");

		const second = rec.deliveries[1]?.message;
		expect(second).toMatchObject({ id: 2 });
		const result = resultOf(second);
		const [block] = recordArray(result, "content") ?? [];
		const text = recordString(block, "text") ?? "null";
		expect(JSON.parse(text)).toEqual(params); // 多字节字符经 stdin/stdout 原样往返
		expect(rec.errors).toEqual([]);
	});

	it("env：inheritEnv=true 继承宿主并叠加 options.env；false 只带最小必要变量", async () => {
		vi.stubEnv("MCP_PARENT_MARKER", "from-parent");

		const inherited = await startTransport(echoOptions({ env: { MCP_MARKER: "from-options" } }));
		await inherited.transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		await inherited.rec.waitFor(() => inherited.rec.deliveries.length >= 1, "继承环境的响应");
		expect(resultOf(inherited.rec.deliveries[0]?.message).env).toEqual({
			marker: "from-options",
			parentMarker: "from-parent",
		});

		// 关掉继承后宿主变量不该泄漏给服务器，但 options.env 必须送达（不然 PATH 之类的必要项也无从注入）
		const isolated = await startTransport(
			echoOptions({ inheritEnv: false, env: { MCP_MARKER: "from-options" } }),
		);
		await isolated.transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		await isolated.rec.waitFor(() => isolated.rec.deliveries.length >= 1, "最小环境的响应");
		expect(resultOf(isolated.rec.deliveries[0]?.message).env).toEqual({
			marker: "from-options",
			parentMarker: null,
		});
	});

	it("stderr 走 onLog 旁路，不注入协议流", async () => {
		const { transport, rec } = await startTransport(echoOptions());

		await transport.send({
			jsonrpc: "2.0",
			method: "test/stderr",
			params: { text: "hello-from-stderr" },
		});
		await rec.waitFor(
			() => rec.logs.some((line) => line.includes("stderr-marker:hello-from-stderr")),
			"stderr 标记",
		);

		// stderr 行不能被当成消息投递，也不报错
		expect(rec.deliveries).toEqual([]);
		expect(rec.errors).toEqual([]);
	});

	it("cancel 把 notifications/cancelled 写给子进程", async () => {
		const { transport, rec } = await startTransport(echoOptions());

		// hang：服务器收到就不回，模拟在途请求
		await transport.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hang" } });
		await transport.cancel(7);
		await rec.waitFor(() => rec.logs.some((line) => line.includes("cancelled:7")), "取消通知落地");

		expect(rec.deliveries).toEqual([]); // hang 请求确实没被响应
		expect(rec.errors).toEqual([]);
	});

	it("取消未知 id / 进程未起时静默 no-op", async () => {
		const transport = createStdioTransport(echoOptions());
		transports.push(transport);
		// 未 start：不应抛
		await expect(transport.cancel(1)).resolves.toBeUndefined();
	});

	it("进程退出 → onError(failure=process)，带退出码与最后几行 stderr；之后 send 一律 reject", async () => {
		const { transport, rec } = await startTransport(echoOptions());

		await transport.send({ jsonrpc: "2.0", id: 3, method: "test/exit", params: {} });
		await rec.waitFor(() => rec.errors.length >= 1, "进程退出错误");

		const error = rec.errors[0];
		expect(error?.failure).toBe("process");
		expect(error?.message).toContain("exit code 7");
		expect(error?.message).toContain("fatal: exit requested"); // 最后几行 stderr 是诊断价值最高的部分
		await expect(transport.send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })).rejects.toThrow(
			/exited/u,
		);
	});

	it("close() 幂等：二次调用不抛，优雅关闭不报进程错误，close 后不再投递", async () => {
		const { transport, rec } = await startTransport(echoOptions());
		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		await rec.waitFor(() => rec.deliveries.length >= 1, "首个响应");

		await transport.close();
		await expect(transport.close()).resolves.toBeUndefined();
		// 子进程是我们自己关掉的：它的退出不算故障（不报 onError），也不允许再有投递
		await delay(300, undefined, { ref: false });
		expect(rec.errors).toEqual([]);
		expect(rec.deliveries).toHaveLength(1);
		await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).rejects.toThrow(
			/closed/u,
		);
	});

	it("找不到的命令：start() reject，错误可读且带解析过的路径", async () => {
		const missing = join(tmpdir(), "percho-mcp-missing-command-xyz");
		const transport = createStdioTransport(echoOptions({ command: missing, args: [] }));
		transports.push(transport);

		const error = await transport.start().then(
			() => null,
			(err: unknown) => err as McpTransportError,
		);
		expect(error?.failure).toBe("process");
		expect(error?.message).toContain("Command not found");
		expect(error?.message).toContain(missing);
	});

	it.skipIf(process.platform !== "win32")(
		"win32：裸命令名解析到 .cmd shim（路径与实参都含空格）",
		async () => {
			// 目录名与实参都带空格：拼 cmd.exe 命令行时少一层引号就会在这里炸
			const dir = await mkdtemp(join(tmpdir(), "percho mcp shim "));
			tempDirs.push(dir);
			// shim 里只出现 ASCII 与 %~dp0 相对路径：仓库路径含中文，而 cmd.exe 按 OEM 代码页读批处理，
			// 直接嵌绝对路径会被解码成乱码（这不是传输的问题，但会让本测试变成测环境）
			await copyFile(ECHO_SERVER, join(dir, "echo-server.mjs"));
			await writeFile(
				join(dir, "echo-server.cmd"),
				'@echo off\r\nnode "%~dp0echo-server.mjs" %*\r\n',
				"ascii",
			);

			const { transport, rec } = await startTransport(
				echoOptions({
					command: "echo-server", // 裸命令名：必须靠 PATH 扫描 + .cmd 补全
					args: ["--label", "hello world"],
					env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
				}),
			);

			await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
			await rec.waitFor(() => rec.deliveries.length >= 1, "经 .cmd shim 的响应");
			expect(rec.deliveries[0]?.message).toMatchObject({ result: { argv: ["--label", "hello world"] } });
		},
	);

	it.skipIf(process.platform !== "win32")("win32：PATH 里没有的裸命令名回退 cmd.exe 查找", async () => {
		// 回退路径：cmd.exe 自己找不到时以退出码收场（stderr 由 cmd 给出），不应该是 spawn 抛异常
		const { rec } = await startTransport(echoOptions({ command: "percho-no-such-command", args: [] }));
		await rec.waitFor(() => rec.errors.length >= 1, "回退后的进程退出错误");
		expect(rec.errors[0]?.failure).toBe("process");
	});
});
