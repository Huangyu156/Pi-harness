/**
 * MCP 面向模型的工具层（`expose`）：单代理工具 `mcp` + 逐工具直投工具 `mcp__<server>__<tool>`。
 *
 * 曝光策略（与用户确认的方案一致）：**默认只注册 `mcp` 代理工具**（一个工具覆盖全部服务器的
 * 搜索/描述/调用/资源/提示，省 context），按服务器另开 `directTools` 时才注册直投工具。
 *
 * 权限边界的落点：本文件不判权限，也不做权限确认——所有工具调用都经内置权限门控扩展
 * （`permissions/extension.ts` 拿 `matchTextFor(toolName, input)` 求主体），故这里的参数命名
 * 必须与 `permissions/pattern.ts` 的 `mcpMatchSubject` 保持一致（`server` / `tool` / `resource` /
 * `prompt` / `describe` / `search`），否则规则键与记忆键对不上。
 *
 * 结果投影：MCP 的 image 块**原样进 content**（规范允许模型看图，`AgentToolResult.content` 支持
 * image），audio 与 resource/resource_link 转文本说明（模型端没有对应的内容类型，编造 base64
 * 进上下文只会烧 token）。
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpCallResult, McpContentBlock, McpInputRequest, McpToolInfo } from "@percho/shared";
import { type TSchema, Type, Unsafe } from "typebox";
import { createLogger } from "../log";
import { asRecord } from "./json";
import type { McpService } from "./service";

const log = createLogger("mcp-tools");

/** 单个 schema / 描述的文本上限（远端 schema 可能极大；截断而不是把它灌进上下文） */
const MAX_SCHEMA_CHARS = 8_000;
/** structuredContent 进文本的上限 */
const MAX_STRUCTURED_CHARS = 8_000;
/** 直投工具名上限（provider 侧的硬约束，超了直接不注册而不是截断成重名） */
const MAX_TOOL_NAME = 64;

/** JSON 对象透传（args / inputResponses / prompt.args 形状由远端工具自己定义，这里不假装知道字段） */
const JSON_OBJECT = Unsafe({ type: "object", additionalProperties: true });

function jsonObjectSchema(description: string): TSchema {
	return Unsafe({ ...JSON_OBJECT, description });
}

/** 工具名里允许的字符（provider 普遍只接受这个集合；其余字符会被拒或截断） */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_-]/g;

const mcpParams = Type.Object({
	search: Type.Optional(
		Type.String({
			description:
				"Search remote MCP tools by keyword across all enabled servers. Returns tool paths like <server>__<tool>.",
		}),
	),
	describe: Type.Optional(
		Type.String({
			description:
				"Describe one remote tool by path (<server>__<tool>): returns its description and input schema.",
		}),
	),
	server: Type.Optional(
		Type.String({
			description: "MCP server name (from mcp.json). Required for tool / resource / prompt calls.",
		}),
	),
	tool: Type.Optional(Type.String({ description: "Remote tool name to call (together with `server`)." })),
	args: Type.Optional(jsonObjectSchema("Arguments object for the remote tool.")),
	inputResponses: Type.Optional(
		jsonObjectSchema(
			"MRTR replay only: map of responses keyed by the `id`s a previous result returned in inputRequests.",
		),
	),
	requestState: Type.Optional(
		Type.String({
			description:
				"MRTR replay only: the opaque requestState from a previous result — pass it back byte-for-byte.",
		}),
	),
	resource: Type.Optional(Type.String({ description: "Resource URI to read (together with `server`)." })),
	prompt: Type.Optional(
		Type.Union(
			[
				Type.String(),
				Type.Object({ name: Type.String(), args: Type.Optional(jsonObjectSchema("Prompt arguments.")) }),
			],
			{ description: "Prompt name (together with `server`), or { name, args }." },
		),
	),
});

/** `mcp` 工具的结构化详情（进 jsonl 与 UI 渲染；不含 base64 图片，避免内容翻倍） */
export interface McpToolDetails {
	action: "search" | "describe" | "status" | "call" | "resource" | "prompt";
	server?: string;
	tool?: string;
	isError?: boolean;
	/** 内容块类型清单（UI 摘要） */
	blockTypes?: string[];
	hasStructured?: boolean;
	/** MRTR：服务器索要的额外输入（补齐后用同一参数再调一次） */
	inputRequests?: McpInputRequest[];
}

type ToolAction = McpToolDetails["action"];

/** 意图判定：一次只允许一个动作（多给就报错而不是猜——静默取第一个会把用户意图吞掉） */
function pickAction(params: {
	search?: unknown;
	describe?: unknown;
	tool?: unknown;
	resource?: unknown;
	prompt?: unknown;
}): ToolAction {
	const given: ToolAction[] = [];
	if (params.search !== undefined) given.push("search");
	if (params.describe !== undefined) given.push("describe");
	if (params.tool !== undefined) given.push("call");
	if (params.resource !== undefined) given.push("resource");
	if (params.prompt !== undefined) given.push("prompt");
	if (given.length > 1) {
		throw new Error(`mcp: pass exactly one action, got ${given.join(" + ")}`);
	}
	return given[0] ?? "status";
}

/** `server` 参数校验：调用类动作必须指明服务器（同名工具在不同服务器上语义完全不同） */
function requireServer(server: string | undefined, action: string): string {
	if (server === undefined || server.trim() === "") {
		throw new Error(`mcp: "${action}" requires "server"`);
	}
	return server;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit
		? text
		: `${text.slice(0, limit)}… (${text.length - limit} more chars truncated)`;
}

/**
 * MCP 内容块 → 模型内容。image 原样保留（模型能看图）；audio 与 resource 系转文本说明。
 * 返回 blockTypes 供 UI 摘要。
 *
 * 逐字段用 `typeof` 收窄而不是靠 `block.type` 判别联合：`McpContentBlock` 末尾有「未知类型原样保留」
 * 的兜底成员（`{ type: string; [key: string]: unknown }`），它带索引签名，会让 `switch (block.type)`
 * 的每个分支都退化成 `unknown`——所以这里先取宽松记录视图，再逐字段校验。
 */
function toContent(blocks: McpContentBlock[]): {
	content: (TextContent | ImageContent)[];
	blockTypes: string[];
} {
	const content: (TextContent | ImageContent)[] = [];
	const blockTypes: string[] = [];
	for (const block of blocks) {
		const record: Record<string, unknown> = block;
		const type = typeof record.type === "string" ? record.type : "unknown";
		blockTypes.push(type);
		const text = typeof record.text === "string" ? record.text : undefined;
		const data = typeof record.data === "string" ? record.data : undefined;
		const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
		if (type === "text" && text !== undefined) {
			content.push({ type: "text", text });
			continue;
		}
		if (type === "image" && data !== undefined && mimeType !== undefined) {
			content.push({ type: "image", data, mimeType });
			continue;
		}
		if (type === "audio" && data !== undefined) {
			content.push({
				type: "text",
				text: `[audio content omitted: ${mimeType ?? "unknown type"}, ${data.length} base64 chars]`,
			});
			continue;
		}
		if (type === "resource_link") {
			const uri = typeof record.uri === "string" ? record.uri : "(no uri)";
			const name = typeof record.name === "string" ? ` (${record.name})` : "";
			content.push({ type: "text", text: `[resource_link: ${uri}${name}]` });
			continue;
		}
		if (type === "resource") {
			const resource = asRecord(record.resource);
			const uri = typeof resource?.uri === "string" ? resource.uri : "(no uri)";
			const blob = typeof resource?.blob === "string" ? `[blob ${resource.blob.length} base64 chars]` : "";
			const inline = typeof resource?.text === "string" ? resource.text : blob;
			content.push({ type: "text", text: `[resource: ${uri}]\n${inline}`.trim() });
			continue;
		}
		content.push({ type: "text", text: `[${type} block: ${JSON.stringify(block).slice(0, 500)}]` });
	}
	return { content, blockTypes };
}

/**
 * 调用结果的完整投影：内容 + structuredContent + MRTR 回放指引。
 * inputRequests 非空时必须显式告诉模型「怎么回放」，否则它会当成失败重试（服务器拿到的是空输入）。
 */
function callResultText(result: McpCallResult): string {
	const parts: string[] = [];
	if (result.isError) parts.push("[remote tool error]");
	if (result.structured !== undefined) {
		parts.push(`structuredContent: ${truncate(JSON.stringify(result.structured), MAX_STRUCTURED_CHARS)}`);
	}
	if (result.inputRequests !== undefined && result.inputRequests.length > 0) {
		const asked = result.inputRequests
			.map(
				(request) =>
					`- id="${request.id}" method=${request.method} params=${truncate(JSON.stringify(request.params), 1000)}`,
			)
			.join("\n");
		parts.push(
			`The server needs more input before it can finish (MRTR). Respond by calling mcp again with the SAME arguments plus:\n` +
				`  inputResponses: { "<id>": <response value> }  // the ids below\n` +
				`  requestState: the exact string from details/this message (opaque, do not edit)\n` +
				`Requests:\n${asked}`,
		);
	}
	return parts.join("\n");
}

/** MRTR 指引里要回传的 requestState 原文（放在文本里，模型可见才好原样带回） */
function withRequestState(text: string, result: McpCallResult): string {
	if (result.requestState === undefined) return text;
	return `${text}\nrequestState (pass back verbatim): ${result.requestState}`;
}

function describeText(tool: McpToolInfo, path: string): string {
	const schema =
		tool.inputSchema === undefined
			? "(no input schema)"
			: truncate(JSON.stringify(tool.inputSchema, null, 2), MAX_SCHEMA_CHARS);
	return [
		`${path}${tool.title ? ` — ${tool.title}` : ""}`,
		tool.description ?? "(no description)",
		"",
		"Input schema:",
		schema,
	].join("\n");
}

/**
 * `mcp` 代理工具：一个工具覆盖全部服务器的搜索/描述/调用/资源/提示，外加无动作时的状态汇总。
 * 零服务器时不注册（见 pi-backend.buildCustomTools），免得空工具白占 context。
 */
export function makeMcpTool(service: McpService): ToolDefinition<typeof mcpParams> {
	return {
		name: "mcp",
		label: "MCP",
		description:
			"MCP gateway for the user's configured MCP servers. Pick exactly one action:\n" +
			"- search: find remote tools by keyword across enabled servers (returns paths `<server>__<tool>`)\n" +
			"- describe: show one remote tool's description and input schema (by path)\n" +
			"- tool + server (+ args): call one remote tool\n" +
			"- resource + server: read one remote resource\n" +
			"- prompt + server: render one remote prompt\n" +
			"With no action it lists the configured servers and their connection state.\n" +
			"For several MCP calls with logic between them (loop, filter, chain, fan out) use the mcpScript tool instead.",
		promptSnippet: "mcp({ search }) or mcp({ server, tool, args })",
		promptGuidelines: [
			"Use mcp({ search }) to discover remote tools before calling them; paths are `<server>__<tool>`.",
			"MCP tools are remote: prefer one precise call over exploratory ones, and batch multi-call work with mcpScript.",
		],
		parameters: mcpParams,
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> => {
			const action = pickAction(params);
			// Unsafe 透传 schema 让静态类型是 unknown：边界处收窄一次，后面全是工具层自己的类型
			const inputResponses = asRecord(params.inputResponses) ?? undefined;
			if (action === "search") {
				const found = await service.searchTools(params.search ?? "", {
					server: params.server,
					signal,
				});
				const lines = found.tools.map((tool) =>
					`${tool.server}__${tool.name}${tool.title ? ` (${tool.title})` : ""} — ${tool.description ?? ""}`.trimEnd(),
				);
				const notes: string[] = [];
				if (found.tools.length === 0) notes.push("No remote tool matched the query.");
				for (const failure of found.failed)
					notes.push(`Server "${failure.server}" unavailable: ${failure.error}`);
				if (found.pending.length > 0) {
					notes.push(`Still connecting (retry to include them): ${found.pending.join(", ")}`);
				}
				return {
					content: [{ type: "text", text: [...lines, ...notes].join("\n") }],
					details: { action, server: params.server },
				};
			}
			if (action === "describe") {
				const path = params.describe ?? "";
				const tool = await service.describeTool(path, signal);
				return {
					content: [{ type: "text", text: describeText(tool, path) }],
					details: { action, server: tool.server, tool: tool.name },
				};
			}
			if (action === "call") {
				const server = requireServer(params.server, "tool");
				const result = await service.callRemoteTool(server, params.tool ?? "", params.args ?? {}, {
					inputResponses,
					requestState: params.requestState,
					signal,
				});
				const projected = toContent(result.content);
				const text = withRequestState(callResultText(result), result);
				if (text !== "") projected.content.push({ type: "text", text });
				if (projected.content.length === 0) projected.content.push({ type: "text", text: "(no content)" });
				return {
					content: projected.content,
					details: {
						action,
						server,
						tool: params.tool,
						isError: result.isError,
						blockTypes: projected.blockTypes,
						hasStructured: result.structured !== undefined,
						inputRequests: result.inputRequests,
					},
				};
			}
			if (action === "resource") {
				const server = requireServer(params.server, "resource");
				const result = await service.readResource(server, params.resource ?? "", {
					inputResponses,
					requestState: params.requestState,
					signal,
				});
				const projected = toContent(result.content);
				return {
					content:
						projected.content.length > 0 ? projected.content : [{ type: "text", text: "(empty resource)" }],
					details: { action, server, blockTypes: projected.blockTypes, inputRequests: result.inputRequests },
				};
			}
			if (action === "prompt") {
				const server = requireServer(params.server, "prompt");
				const promptRecord = asRecord(params.prompt);
				const name =
					typeof params.prompt === "string"
						? params.prompt
						: typeof promptRecord?.name === "string"
							? promptRecord.name
							: "";
				const args = asRecord(promptRecord?.args) ?? undefined;
				const result = await service.getPrompt(server, name, args, {
					inputResponses,
					requestState: params.requestState,
					signal,
				});
				const lines: string[] = [];
				if (result.description !== null) lines.push(result.description);
				for (const message of result.messages) {
					const projected = toContent(message.content);
					const text = projected.content
						.map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
						.join("\n");
					lines.push(`--- ${message.role} ---\n${text}`);
				}
				if (result.inputRequests !== undefined && result.inputRequests.length > 0) {
					lines.push(
						`The server needs more input (MRTR); ids: ${result.inputRequests.map((request) => request.id).join(", ")}`,
					);
				}
				return {
					content: [{ type: "text", text: lines.join("\n\n") || "(empty prompt)" }],
					details: { action, server, inputRequests: result.inputRequests },
				};
			}
			const servers = await service.list();
			const lines = servers.map(
				(server) =>
					`${server.name} [${server.transport}/${server.state}]${server.era ? ` era=${server.era} protocol=${server.protocolVersion}` : ""}` +
					`${server.toolCount === null ? "" : ` tools=${server.toolCount}`} — ${server.summary}` +
					`${server.lastError === null ? "" : `\n    error: ${server.lastError}`}`,
			);
			return {
				content: [
					{
						type: "text",
						text: lines.length > 0 ? lines.join("\n") : "No MCP servers are configured.",
					},
				],
				details: { action: "status" },
			};
		},
	};
}

/**
 * 直投工具名：`mcp__<server>__<tool>`（与权限记忆键、`mcp` 代理工具的匹配主体同构）。
 * 服务器名/工具名里的非法字符替换为 `_`；超长直接放弃注册（截断会制造重名，比缺工具更坏）。
 */
function directToolName(server: string, tool: string): string | null {
	const name = `mcp__${server.replace(UNSAFE_NAME_CHARS, "_")}__${tool.replace(UNSAFE_NAME_CHARS, "_")}`;
	return name.length > MAX_TOOL_NAME ? null : name;
}

/** 远端 inputSchema 直接当参数 schema（`Unsafe` = 原样透传，不做 TypeBox 语义假设） */
function directToolParameters(inputSchema: unknown): TSchema {
	if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
		return Unsafe({ type: "object", additionalProperties: true });
	}
	return Unsafe(inputSchema as Record<string, unknown>);
}

function makeDirectTool(
	service: McpService,
	server: string,
	remote: McpToolInfo,
	name: string,
): ToolDefinition {
	return {
		name,
		label: `${remote.name} (${server})`,
		description:
			`MCP tool \`${remote.name}\` on server \`${server}\`${remote.title ? ` — ${remote.title}` : ""}.\n` +
			(remote.description ?? "(the server provides no description)") +
			"\nArguments are passed to the remote server as-is.",
		promptSnippet: `${name}({…})`,
		parameters: directToolParameters(remote.inputSchema),
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> => {
			const result = await service.callRemoteTool(server, remote.name, params, { signal });
			const projected = toContent(result.content);
			const text = callResultText(result);
			if (text !== "") projected.content.push({ type: "text", text });
			if (result.inputRequests !== undefined && result.inputRequests.length > 0) {
				// 直投工具的 schema 是远端原样透传，塞不下 MRTR 的额外字段：让模型换代理工具完成交互
				projected.content.push({
					type: "text",
					text: `To answer this request, call mcp({ server: "${server}", tool: "${remote.name}", args: <same args>, inputResponses, requestState }).`,
				});
			}
			if (projected.content.length === 0) projected.content.push({ type: "text", text: "(no content)" });
			return {
				content: projected.content,
				details: {
					action: "call",
					server,
					tool: remote.name,
					isError: result.isError,
					blockTypes: projected.blockTypes,
					hasStructured: result.structured !== undefined,
					inputRequests: result.inputRequests,
				},
			};
		},
	};
}

/**
 * 会话构造期的直投工具快照（同步）：只包含「已连上并缓存了工具清单」的服务器。
 * 未连上的服务器在后台预热（`McpService.warmDirectTools`），下一次新建会话才带上它们的工具。
 */
export function makeDirectMcpTools(service: McpService): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const used = new Set<string>();
	for (const { server, tools: remoteTools } of service.directToolSnapshot()) {
		for (const remote of remoteTools) {
			const name = directToolName(server, remote.name);
			if (name === null) {
				log.warn("direct tool name too long; skipped", { server, tool: remote.name });
				continue;
			}
			if (used.has(name)) {
				// 名字清洗后撞车（server/tool 名里含非法字符）：宁缺勿错，代理工具仍可调用
				log.warn("direct tool name collision; skipped", { server, tool: remote.name, name });
				continue;
			}
			used.add(name);
			tools.push(makeDirectTool(service, server, remote, name));
		}
	}
	log.debug("direct tools registered", { count: tools.length });
	return tools;
}
