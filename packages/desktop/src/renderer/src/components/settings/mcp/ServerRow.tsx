import type { McpConnectionState, McpServerView } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { useToastsStore } from "../../../stores/toasts";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Switch } from "../../ui/Switch";
import { Tooltip } from "../../ui/Tooltip";
import { LogsBlock, TestResultBlock, ToolsBlock } from "./ServerDetails";

/** 状态点颜色（Tailwind 需要在源码里出现完整类名，不做字符串拼接） */
const DOT_CLASS: Record<McpConnectionState, string> = {
	disabled: "bg-ink-faint",
	idle: "bg-ink-dim",
	connecting: "bg-amber-500",
	ready: "bg-green-500",
	error: "bg-red-500",
};

/** 传输类型徽标（配置里 type 的字面量，不翻译） */
const TRANSPORT_LABEL: Record<McpServerView["transport"], string> = {
	stdio: "stdio",
	http: "http",
	sse: "sse",
};

/** 就地展开区：同一时刻只开一层，抽屉只有 ~500px 宽，叠开会把别的服务器挤出视口 */
type RowPane = "test" | "tools" | "logs" | null;

/**
 * 服务器行：状态 + 启停/直投开关 + 测试/工具/日志/编辑/删除 + OAuth 登录入口。
 * 行内不直接调 IPC（走 stores/mcp.ts），只有「结果就地展开」这类纯视图状态留在组件里。
 */
export function ServerRow({
	server,
	editing,
	onEdit,
}: {
	server: McpServerView;
	/** 编辑表单已在本行下方展开（行内高亮，避免看着像两台服务器） */
	editing: boolean;
	onEdit: () => void;
}) {
	const t = useT();
	const setEnabled = useMcpStore((s) => s.setEnabled);
	const setDirectTools = useMcpStore((s) => s.setDirectTools);
	const testServer = useMcpStore((s) => s.testServer);
	const removeServer = useMcpStore((s) => s.remove);
	const startAuth = useMcpStore((s) => s.startAuth);
	const testing = useMcpStore((s) => s.testing[server.name] === true);
	const authRunning = useMcpStore((s) => s.authFlow?.running === true && s.authFlow.server === server.name);
	const pushToast = useToastsStore((s) => s.push);
	const [pane, setPane] = useState<RowPane>(null);
	const [confirming, setConfirming] = useState(false);

	/** 开关类写操作：失败不静默（行内没有错误位，走全局 toast） */
	const toggle = async (action: () => Promise<void>) => {
		try {
			await action();
		} catch (error) {
			pushToast("error", "toast.mcpToggleFailed", error instanceof Error ? error.message : String(error));
		}
	};

	const openPane = (next: Exclude<RowPane, null>) => setPane(pane === next ? null : next);
	const meta: string[] = [];
	if (server.era) meta.push(t(`settings.mcp.era.${server.era}`));
	if (server.protocolVersion) meta.push(server.protocolVersion);
	if (server.toolCount !== null) meta.push(t("settings.mcp.toolCount", { count: server.toolCount }));

	return (
		<div
			className={`rounded-xl border p-3 ${editing ? "border-border-strong bg-hover/40" : "border-border"}`}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[server.state]}`} />
						<span className="truncate text-[13px] font-medium text-ink">{server.name}</span>
						<span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[10px] text-ink-dim">
							{t(`settings.mcp.source.${server.source}`)}
						</span>
						<span className="shrink-0 rounded-full bg-hover px-2 py-0.5 font-mono text-[10px] text-ink-dim">
							{TRANSPORT_LABEL[server.transport]}
						</span>
						<span className="shrink-0 text-[10px] text-ink-faint">
							{t(`settings.mcp.state.${server.state}`)}
						</span>
					</div>
					<p className="mt-1 truncate font-mono text-[11px] text-ink-dim">{server.summary}</p>
					{meta.length > 0 && <p className="mt-0.5 text-[10px] text-ink-faint">{meta.join(" · ")}</p>}
					{/* 凭据值永不下发，只列键名，给「这条配了哪些密钥」一个可见答案 */}
					{server.secretKeys.length > 0 && (
						<p className="mt-0.5 truncate text-[10px] text-ink-faint">
							{t("settings.mcp.secretKeys", { keys: server.secretKeys.join(", ") })}
						</p>
					)}
					{/* 只在 error 态展示：连接恢复后残留的旧错误不该继续占据行内空间 */}
					{server.state === "error" && server.lastError && (
						<p className="mt-1 text-[11px] break-all text-red-600">{server.lastError}</p>
					)}
				</div>
				<Tooltip label={t("settings.mcp.enabledHint")} align="end">
					<Switch
						checked={!server.disabled}
						onCheckedChange={(enabled) => void toggle(() => setEnabled(server.name, enabled))}
					/>
				</Tooltip>
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Tooltip label={t("settings.mcp.directToolsHint")}>
					<span className="flex items-center gap-1.5 text-[11px] text-ink-dim">
						{t("settings.mcp.directTools")}
						<Switch
							checked={server.percho.directTools}
							onCheckedChange={(enabled) => void toggle(() => setDirectTools(server.name, enabled))}
						/>
					</span>
				</Tooltip>
				<Button
					size="sm"
					disabled={testing}
					onClick={() => {
						setPane("test");
						void testServer(server.name);
					}}
				>
					{testing ? t("settings.mcp.testing") : t("settings.mcp.test")}
				</Button>
				<Button size="sm" onClick={() => openPane("tools")}>
					{t("settings.mcp.tools.label")}
				</Button>
				<Button size="sm" onClick={() => openPane("logs")}>
					{t("settings.mcp.logs.label")}
				</Button>
				<Button size="sm" onClick={onEdit}>
					{t("settings.mcp.edit")}
				</Button>
				{server.authKind === "oauth" && (
					<Button size="sm" disabled={authRunning} onClick={() => void startAuth(server.name)}>
						{server.hasOAuthToken ? t("settings.mcp.auth.relogin") : t("settings.mcp.auth.login")}
					</Button>
				)}
				<span className="flex-1" />
				<Button size="sm" tone="danger" onClick={() => setConfirming(true)}>
					{t("common.delete")}
				</Button>
			</div>

			{/* 直投的生效时机反直觉（下个新会话才注册工具），开着的时候把这句话留在行里 */}
			{server.percho.directTools && (
				<p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{t("settings.mcp.directToolsHint")}</p>
			)}

			{pane === "test" && <TestResultBlock server={server} />}
			{pane === "tools" && <ToolsBlock server={server} />}
			{pane === "logs" && <LogsBlock server={server} />}

			{confirming && (
				<ConfirmDialog
					danger
					autoFocusConfirm={false}
					title={t("settings.mcp.remove.title", { name: server.name })}
					description={t("settings.mcp.remove.desc")}
					confirmLabel={t("common.delete")}
					cancelLabel={t("common.cancel")}
					onConfirm={() => {
						setConfirming(false);
						void removeServer(server.name).catch((error: unknown) => {
							pushToast(
								"error",
								"toast.mcpRemoveFailed",
								error instanceof Error ? error.message : String(error),
							);
						});
					}}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</div>
	);
}
