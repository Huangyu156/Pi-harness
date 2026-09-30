/**
 * stdio 测试替身：逐行读 stdin 的 JSON-RPC，按方法回固定结果。
 *
 * 支持的方法：initialize / server/discover / tools/list / tools/call（回显 params；name=hang 时故意不回，
 * 供 cancel 测试）、test/stderr（往 stderr 打标记，供 onLog 测试）、test/exit（自杀，供进程退出测试）。
 * 收到 notifications/cancelled 时往 stderr 打 `cancelled:<requestId>`：测试据此断言取消通知真的写到了子进程。
 * stdin 关闭即退出：验证传输 close() 走的是「先关 stdin 等善终」而不是上来就杀。
 */
import { StringDecoder } from "node:string_decoder";

process.stderr.write("echo-server ready\n");

const decoder = new StringDecoder("utf8");
let buffer = "";

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stderr.write(`bad json: ${line.slice(0, 80)}\n`);
		return;
	}
	if (message === null || typeof message !== "object") return;
	if (message.method === "notifications/cancelled") {
		process.stderr.write(`cancelled:${message.params?.requestId}\n`);
		return;
	}
	if (message.method === "test/stderr") {
		process.stderr.write(`stderr-marker:${message.params?.text ?? ""}\n`);
		return;
	}
	const id = message.id;
	if (id === undefined || id === null) return; // 其它通知不响应
	switch (message.method) {
		case "initialize":
			write({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "echo", version: "1.0.0" },
					argv: process.argv.slice(2),
					env: {
						marker: process.env.MCP_MARKER ?? null,
						parentMarker: process.env.MCP_PARENT_MARKER ?? null,
					},
				},
			});
			return;
		case "server/discover":
			write({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2026-07-28",
					capabilities: { tools: {} },
					serverInfo: { name: "echo", version: "1.0.0" },
					resultType: "complete",
					argv: process.argv.slice(2),
					env: {
						marker: process.env.MCP_MARKER ?? null,
						parentMarker: process.env.MCP_PARENT_MARKER ?? null,
					},
				},
			});
			return;
		case "tools/list":
			write({
				jsonrpc: "2.0",
				id,
				result: {
					tools: [
						{ name: "echo", description: "echo back", inputSchema: { type: "object" } },
						{ name: "hang", description: "never answers", inputSchema: { type: "object" } },
					],
				},
			});
			return;
		case "tools/call":
			if (message.params?.name === "hang") return; // 永不响应：cancel 测试用
			write({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: JSON.stringify(message.params ?? null) }],
					isError: false,
				},
			});
			return;
		case "test/exit":
			// 先让 stderr 落到管道里再退出，否则「错误里带最后几行 stderr」的断言拿不到内容
			process.stderr.write("fatal: exit requested\n");
			setTimeout(() => process.exit(7), 20);
			return;
		default:
			write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
}

process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (line.trim() !== "") handle(line);
		index = buffer.indexOf("\n");
	}
});

process.stdin.on("end", () => process.exit(0));
