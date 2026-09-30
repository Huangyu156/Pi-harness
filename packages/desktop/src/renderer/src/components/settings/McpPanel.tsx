import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcp";
import { useToastsStore } from "../../stores/toasts";
import { Button } from "../ui/Button";
import { AuthFlowDialog } from "./mcp/AuthFlowDialog";
import { EMPTY_MCP_FORM, formFromView, formToConfig, type McpServerFormState } from "./mcp/form";
import { ImportWizard } from "./mcp/ImportWizard";
import { ServerForm } from "./mcp/ServerForm";
import { ServerRow } from "./mcp/ServerRow";

/**
 * 设置 → MCP：服务器列表（启停/直投/测试/工具/日志/删除）+ 新增·编辑表单 + 导入向导 + OAuth 登录 + 底部工具条。
 *
 * 数据与 IPC 全在 stores/mcp.ts，本组件只管视图状态（表单开合、编辑目标）；
 * mcp:event 订阅在这里建立（面板随设置弹窗挂载/卸载）：status/log/notice/auth 是「打开时看得到」的实时性需求，
 * 全量列表则在打开时和 changed 事件后重取。
 */
export function McpPanel() {
	const t = useT();
	const servers = useMcpStore((s) => s.servers);
	const loading = useMcpStore((s) => s.serversLoading);
	const error = useMcpStore((s) => s.serversError);
	const notices = useMcpStore((s) => s.notices);
	const refresh = useMcpStore((s) => s.refresh);
	const upsert = useMcpStore((s) => s.upsert);
	const openConfig = useMcpStore((s) => s.openConfig);
	const reloadAll = useMcpStore((s) => s.reloadAll);
	const subscribeEvents = useMcpStore((s) => s.subscribeEvents);
	const dismissNotice = useMcpStore((s) => s.dismissNotice);
	const pushToast = useToastsStore((s) => s.push);
	const [adding, setAdding] = useState(false);
	const [editingName, setEditingName] = useState<string | null>(null);

	// 先订阅再拉列表：changed/status 事件可能早于首次 listServers 的响应到达
	useEffect(() => {
		const unsubscribe = subscribeEvents();
		void refresh();
		return unsubscribe;
	}, [subscribeEvents, refresh]);

	// 编辑目标在列表里消失（被删除/配置来源变更）时收起表单，避免对着空白提交
	useEffect(() => {
		if (editingName !== null && !servers.some((server) => server.name === editingName)) setEditingName(null);
	}, [editingName, servers]);

	const save = async (form: McpServerFormState) => {
		await upsert(form.name.trim(), formToConfig(form));
		setAdding(false);
		setEditingName(null);
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.mcp.title")}</h3>
					<div className="flex gap-2">
						<Button size="sm" disabled={loading} onClick={() => void refresh()}>
							{t("common.refresh")}
						</Button>
						<Button
							size="sm"
							variant="primary"
							onClick={() => {
								setEditingName(null);
								setAdding((open) => !open);
							}}
						>
							{t("settings.mcp.add")}
						</Button>
					</div>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.mcp.hint")}</p>
			</div>

			{/* 配置层提示（mcp.json 非法条目/损坏/扫描失败）：瞬时就地提示，不静默、不进日志区 */}
			{notices.map((notice) => (
				<div
					key={notice.id}
					className={`flex items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ${
						notice.level === "error" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"
					}`}
				>
					<div className="min-w-0">
						<p className="font-medium">{t("settings.mcp.noticeTitle")}</p>
						{/* message 是后端原文（含文件路径），不翻译也不改写 */}
						<p className="break-all whitespace-pre-wrap">{notice.message}</p>
					</div>
					<button
						type="button"
						className="shrink-0 px-1"
						onClick={() => dismissNotice(notice.id)}
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
			))}

			{error && (
				<p className="text-[11px] break-all text-red-600">{`${t("settings.mcp.loadFailed")}：${error}`}</p>
			)}

			<div className="flex flex-col gap-2">
				{servers.map((server) => (
					<div key={server.name}>
						<ServerRow
							server={server}
							editing={editingName === server.name}
							onEdit={() => {
								setAdding(false);
								setEditingName(editingName === server.name ? null : server.name);
							}}
						/>
						{editingName === server.name && (
							<ServerForm
								title={t("settings.mcp.form.edit")}
								initial={formFromView(server)}
								lockName
								onSubmit={save}
								onCancel={() => setEditingName(null)}
							/>
						)}
					</div>
				))}
				{loading && servers.length === 0 && (
					<p className="py-4 text-center text-[12px] text-ink-faint">{t("settings.loading")}</p>
				)}
				{!loading && servers.length === 0 && (
					<div className="rounded-xl border border-dashed border-border px-3 py-6 text-center">
						<p className="text-[12px] text-ink-dim">{t("settings.mcp.empty")}</p>
						<p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{t("settings.mcp.emptyHint")}</p>
					</div>
				)}
			</div>

			{adding && (
				<ServerForm
					title={t("settings.mcp.form.add")}
					initial={EMPTY_MCP_FORM}
					onSubmit={save}
					onCancel={() => setAdding(false)}
				/>
			)}

			<ImportWizard />

			<div className="flex items-center gap-2 border-t border-border pt-3">
				<Button
					size="sm"
					onClick={() =>
						void openConfig().catch((err: unknown) =>
							pushToast(
								"error",
								"toast.mcpConfigOpenFailed",
								err instanceof Error ? err.message : String(err),
							),
						)
					}
				>
					{t("settings.mcp.openConfig")}
				</Button>
				<Button
					size="sm"
					onClick={() =>
						void reloadAll().catch((err: unknown) =>
							pushToast("error", "toast.mcpReloadFailed", err instanceof Error ? err.message : String(err)),
						)
					}
				>
					{t("settings.mcp.reloadAll")}
				</Button>
			</div>

			<AuthFlowDialog />
		</div>
	);
}
