/**
 * 直投工具（`mcp__<server>__<tool>`）的命名与注册规则：名字清洗、超长放弃、撞名放弃、
 * 调用时用**远端原始工具名**（不是清洗后的名字）打到真实服务器上。
 */

import type { McpToolInfo } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import type { McpService } from "../src/mcp/service";
import { makeDirectMcpTools } from "../src/mcp/tools";

function remoteTool(name: string): McpToolInfo {
	return { server: "s", name, description: `${name} desc`, inputSchema: { type: "object" } };
}

/** 桩服务：只需要直投快照与远端调用两个入口（其余方法此测试用不到） */
function stubService(
	snapshot: Array<{ server: string; tools: McpToolInfo[] }>,
	onCall: (server: string, tool: string, args: unknown) => void = () => {},
): McpService {
	const stub = {
		directToolSnapshot: () => snapshot,
		callRemoteTool: async (server: string, tool: string, args: unknown) => {
			onCall(server, tool, args);
			return { isError: false, content: [{ type: "text", text: `${server}/${tool}` }] };
		},
	};
	// 边界断言：只喂本测试用到的那两个方法，其余成员在直投工具路径上不会被触碰
	return stub as unknown as McpService;
}

describe("直投工具命名与注册", () => {
	it("名字 = mcp__<server>__<tool>，非法字符清洗为下划线", () => {
		const tools = makeDirectMcpTools(
			stubService([{ server: "my server/v1", tools: [remoteTool("read:file")] }]),
		);
		expect(tools.map((tool) => tool.name)).toEqual(["mcp__my_server_v1__read_file"]);
	});

	it("清洗后撞名：只注册先到者（宁缺勿错，代理工具仍可调用）", () => {
		const tools = makeDirectMcpTools(
			stubService([
				{ server: "a/b", tools: [remoteTool("x")] },
				{ server: "a b", tools: [remoteTool("x")] },
			]),
		);
		expect(tools.map((tool) => tool.name)).toEqual(["mcp__a_b__x"]);
	});

	it("超过 provider 名字上限（64）直接放弃，不截断成重名", () => {
		const longServer = "s".repeat(40);
		const longTool = "t".repeat(40);
		const tools = makeDirectMcpTools(stubService([{ server: longServer, tools: [remoteTool(longTool)] }]));
		expect(tools).toEqual([]);
	});

	it("执行时用远端原始工具名与原始参数（清洗只影响工具名）", async () => {
		const calls: Array<{ server: string; tool: string; args: unknown }> = [];
		const tools = makeDirectMcpTools(
			stubService([{ server: "my server", tools: [remoteTool("read:file")] }], (server, tool, args) => {
				calls.push({ server, tool, args });
			}),
		);
		expect(tools[0]?.name).toBe("mcp__my_server__read_file");
		const result = await tools[0]?.execute?.("id", { path: "/tmp/x" }, undefined, undefined, {} as never);
		expect(calls).toEqual([{ server: "my server", tool: "read:file", args: { path: "/tmp/x" } }]);
		expect(result?.details).toMatchObject({ action: "call", server: "my server", tool: "read:file" });
	});

	it("远端 inputSchema 原样当参数 schema（不是包一层 object）", () => {
		const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
		const tools = makeDirectMcpTools(
			stubService([{ server: "s", tools: [{ ...remoteTool("search"), inputSchema: schema }] }]),
		);
		expect(tools[0]?.parameters).toMatchObject(schema);
	});

	it("远端没给 inputSchema 时回退到空对象 schema", () => {
		const tools = makeDirectMcpTools(stubService([{ server: "s", tools: [{ server: "s", name: "x" }] }]));
		expect(tools[0]?.parameters).toMatchObject({ type: "object" });
	});

	it("空快照 → 零工具（不会凭空注册）", () => {
		expect(makeDirectMcpTools(stubService([]))).toEqual([]);
	});

	it("上游抛错时不吞（注册期无异常，调用期异常原样上抛）", () => {
		const failing = {
			directToolSnapshot: () => [{ server: "s", tools: [remoteTool("boom")] }],
			callRemoteTool: vi.fn(async () => {
				throw new Error("remote exploded");
			}),
		} as unknown as McpService;
		const tools = makeDirectMcpTools(failing);
		return expect(tools[0]?.execute?.("id", {}, undefined, undefined, {} as never)).rejects.toThrow(
			"remote exploded",
		);
	});
});
