import type { McpServerView } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import { EMPTY_LOG_LINES, EMPTY_TOOLS, LOG_RENDER_TAIL, useMcpStore } from "../../../stores/mcp";
import { Button } from "../../ui/Button";

/**
 * 服务器行的三个就地展开区：测试结果 / 工具清单 / 日志尾部。
 * 单独成文件是因为三块各自持有懒加载状态与滚动容器，塞进 ServerRow 会变成一个 400 行的组件；
 * 数据全部来自 stores/mcp.ts（IPC 细节在 store 里），这里只负责渲染与触发。
 */

/** 测试连接结果：耗时 + 能力清单 + 计数 + 诊断日志（失败时红底展示原因） */
export function TestResultBlock({ server }: { server: McpServerView }) {
	const t = useT();
	const result = useMcpStore((s) => s.testResults[server.name]);
	const error = useMcpStore((s) => s.testErrors[server.name]);

	if (error) {
		return (
			<p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] break-all text-red-600">{error}</p>
		);
	}
	if (!result) return null;

	return (
		<div
			className={`mt-2 rounded-lg px-2.5 py-1.5 text-[11px] ${
				result.ok ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
			}`}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="font-medium">
					{result.ok ? t("settings.mcp.testResult.ok") : t("settings.mcp.testResult.failed")}
				</span>
				<span>{t("settings.mcp.testResult.duration", { ms: result.durationMs })}</span>
				{result.era && <span>{t(`settings.mcp.era.${result.era}`)}</span>}
				{result.protocolVersion && <span>{result.protocolVersion}</span>}
				{result.ok && (
					<span>
						{t("settings.mcp.testResult.counts", {
							tools: result.toolCount,
							resources: result.resourceCount,
							prompts: result.promptCount,
						})}
					</span>
				)}
			</div>
			{result.capabilities.length > 0 && (
				<p className="mt-1 break-all opacity-80">
					{t("settings.mcp.testResult.capabilities")}：{result.capabilities.join(" · ")}
				</p>
			)}
			{result.error && <p className="mt-1 break-all">{result.error}</p>}
			{result.logs.length > 0 && (
				<pre className="mt-1 max-h-32 overflow-auto rounded-md bg-surface/60 p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-ink-2">
					{result.logs.join("\n")}
				</pre>
			)}
		</div>
	);
}

/** 工具清单：展开时懒加载，点条目再展开 inputSchema 原文（JSON） */
export function ToolsBlock({ server }: { server: McpServerView }) {
	const t = useT();
	const tools = useMcpStore((s) => s.tools[server.name] ?? EMPTY_TOOLS);
	const loading = useMcpStore((s) => s.toolsLoading[server.name] === true);
	const error = useMcpStore((s) => s.toolsErrors[server.name]);
	const loaded = useMcpStore((s) => s.tools[server.name] !== undefined);
	const listTools = useMcpStore((s) => s.listTools);
	const [expanded, setExpanded] = useState<string | null>(null);

	// 只在「未缓存」时拉取：缓存被写操作清掉（changed 事件）后本 effect 会因 loaded 变 false 再拉一次
	useEffect(() => {
		if (!loaded) void listTools(server.name);
	}, [loaded, listTools, server.name]);

	return (
		<div className="mt-2 rounded-lg border border-border p-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-ink-faint">
					{t("settings.mcp.tools.count", { count: tools.length })}
				</span>
				<Button size="sm" disabled={loading} onClick={() => void listTools(server.name, true)}>
					{loading ? t("settings.mcp.tools.loading") : t("common.refresh")}
				</Button>
			</div>
			{error && <p className="mt-1 text-[11px] break-all text-red-600">{error}</p>}
			{!error && tools.length === 0 && !loading && (
				<p className="mt-1 text-[11px] text-ink-faint">{t("settings.mcp.tools.empty")}</p>
			)}
			<ul className="mt-1">
				{tools.map((tool) => (
					<li key={tool.name} className="border-t border-border/60 first:border-t-0">
						<button
							type="button"
							className="w-full py-1 text-left text-[11px] text-ink-2 hover:text-ink"
							onClick={() => setExpanded(expanded === tool.name ? null : tool.name)}
						>
							<span className="font-mono">{tool.name}</span>
							{tool.description && <span className="ml-1 text-ink-faint">{tool.description}</span>}
						</button>
						{expanded === tool.name && (
							<pre className="mb-1 max-h-40 overflow-auto rounded-md bg-canvas p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-ink-dim">
								{JSON.stringify(tool.inputSchema ?? null, null, 2)}
							</pre>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

/** 日志尾部：readLog 增量拉取 + log 事件实时追加；只渲染尾部若干行 */
export function LogsBlock({ server }: { server: McpServerView }) {
	const t = useT();
	const lines = useMcpStore((s) => s.logs[server.name] ?? EMPTY_LOG_LINES);
	const loading = useMcpStore((s) => s.logsLoading[server.name] === true);
	const error = useMcpStore((s) => s.logsErrors[server.name]);
	const loaded = useMcpStore((s) => s.logs[server.name] !== undefined);
	const readLog = useMcpStore((s) => s.readLog);
	const boxRef = useRef<HTMLPreElement>(null);
	const tail = lines.slice(-LOG_RENDER_TAIL);

	useEffect(() => {
		if (!loaded) void readLog(server.name, true);
	}, [loaded, readLog, server.name]);

	// 新行到达自动贴底：日志是时序信息，停在顶部会看到过期内容。
	// biome-ignore lint/correctness/useExhaustiveDependencies: lines.length 只是触发器（effect 体内不需要这个值）
	useEffect(() => {
		const box = boxRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [lines.length]);

	return (
		<div className="mt-2 rounded-lg border border-border p-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-ink-faint">
					{t("settings.mcp.logs.count", { count: lines.length })}
				</span>
				<Button size="sm" disabled={loading} onClick={() => void readLog(server.name)}>
					{loading ? t("settings.mcp.logs.loading") : t("common.refresh")}
				</Button>
			</div>
			{error && <p className="mt-1 text-[11px] break-all text-red-600">{error}</p>}
			<pre
				ref={boxRef}
				className="mt-1 max-h-40 overflow-auto rounded-md bg-canvas p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-ink-dim"
			>
				{tail.length ? tail.join("\n") : t("settings.mcp.logs.empty")}
			</pre>
		</div>
	);
}
