import { existsSync } from "node:fs";
import type { PiBackend } from "@percho/backend";
import { MCP_CHANNELS } from "@percho/shared";
import { shell } from "electron";
import { registerInvokeHandlers } from "./invoke";

/**
 * MCP 域：服务器配置管理 + 连接自检 + 工具/资源浏览 + OAuth 登录 + 全平台配置导入。
 *
 * 凭据只上行（`upsertServer` 的 config 可含密钥），下行视图恒为脱敏的 `McpServerView`
 * （env/headers 值只出 `MCP_SECRET_MASK`）。状态/日志/OAuth 事件经 `mcp:event` 推渲染端
 * （见 main/ipc/index.ts 的 forward）。
 */
export function registerMcpIpc(backend: PiBackend): void {
	registerInvokeHandlers(MCP_CHANNELS, {
		listServers: () => backend.mcp.list(),
		upsertServer: ({ name, config }) => backend.mcp.upsert(name, config),
		removeServer: ({ name }) => backend.mcp.remove(name),
		setEnabled: ({ name, enabled }) => backend.mcp.setEnabled(name, enabled),
		setDirectTools: ({ name, enabled }) => backend.mcp.setDirectTools(name, enabled),
		testServer: ({ name }) => backend.mcp.test(name),
		listTools: ({ name }) => backend.mcp.listTools(name),
		listResources: ({ name }) => backend.mcp.listResources(name),
		callTool: ({ name, tool, args }) => backend.mcp.callTool(name, tool, args),
		readLog: ({ name, cursor }) => backend.mcp.readLog(name, cursor ?? 0),
		authStart: ({ name, flowId }) => backend.mcp.startAuth(name, flowId),
		authRespond: ({ flowId, promptId, value }) => backend.mcp.respondAuth(flowId, promptId, value),
		authCancel: ({ flowId }) => backend.mcp.cancelAuth(flowId),
		scanHostConfigs: () => backend.mcp.scanHostConfigs(),
		importServers: ({ picks }) => backend.mcp.importServers(picks),
		openConfig: async () => {
			// 不存在先落空骨架（否则系统编辑器会开一个不存在的路径）；打开失败把系统报错抛给渲染端
			const path = await backend.mcp.ensureUserConfigFile();
			if (!existsSync(path)) throw new Error(`MCP config file not found: ${path}`);
			const error = await shell.openPath(path);
			if (error) throw new Error(error);
		},
		reload: () => backend.mcp.reload(),
	});
}
