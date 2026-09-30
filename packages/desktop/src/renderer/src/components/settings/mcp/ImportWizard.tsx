import type { McpImportPick } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { useToastsStore } from "../../../stores/toasts";
import { Button } from "../../ui/Button";

/** 选中键：host + path + name 三段用 NUL 连接（路径与服务器名里不会出现 NUL，避免分隔符歧义） */
function pickKey(host: string, path: string, name: string): string {
	return `${host}\u0000${path}\u0000${name}`;
}

/**
 * 导入向导：只读扫描各宿主的 MCP 配置文件（Claude Desktop / Claude Code / Cursor / VS Code / Cline /
 * Windsurf / Codex / 通用共享文件），多选后导入到 Percho 用户级配置。
 * 冲突（同名已存在）必须显式标红——导入是覆盖语义，用户得先看见会被谁顶掉。
 */
export function ImportWizard() {
	const t = useT();
	const candidates = useMcpStore((s) => s.importCandidates);
	const scanning = useMcpStore((s) => s.scanning);
	const scanError = useMcpStore((s) => s.scanError);
	const importing = useMcpStore((s) => s.importing);
	const scan = useMcpStore((s) => s.scanHostConfigs);
	const importServers = useMcpStore((s) => s.importServers);
	const pushToast = useToastsStore((s) => s.push);
	const [selected, setSelected] = useState<Record<string, true>>({});
	const selectedCount = Object.keys(selected).length;

	const toggle = (key: string) => {
		setSelected((previous) => {
			const next = { ...previous };
			if (next[key]) delete next[key];
			else next[key] = true;
			return next;
		});
	};

	const submit = async () => {
		const groups: McpImportPick[] = [];
		for (const candidate of candidates ?? []) {
			const names = candidate.servers
				.filter((server) => selected[pickKey(candidate.host, candidate.path, server.name)])
				.map((server) => server.name);
			if (names.length > 0) groups.push({ host: candidate.host, path: candidate.path, names });
		}
		try {
			await importServers(groups);
			setSelected({});
		} catch (error) {
			pushToast("error", "toast.mcpImportFailed", error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div className="rounded-xl border border-border p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.mcp.import.title")}</h3>
					<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.mcp.import.hint")}</p>
				</div>
				<Button size="sm" disabled={scanning} onClick={() => void scan()}>
					{scanning
						? t("settings.mcp.import.scanning")
						: candidates === null
							? t("settings.mcp.import.scan")
							: t("settings.mcp.import.rescan")}
				</Button>
			</div>

			{scanError && <p className="mt-2 text-[11px] break-all text-red-600">{scanError}</p>}
			{candidates !== null && candidates.length === 0 && (
				<p className="mt-2 text-[11px] text-ink-faint">{t("settings.mcp.import.empty")}</p>
			)}

			{candidates?.map((candidate) => (
				<div key={`${candidate.host}:${candidate.path}`} className="mt-2">
					<div className="flex items-baseline gap-2">
						<span className="shrink-0 text-[11px] font-medium text-ink-2">
							{t(`settings.mcp.import.host.${candidate.host}`)}
						</span>
						<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
							{candidate.path}
						</span>
					</div>
					<div className="mt-1 flex flex-col gap-1">
						{candidate.servers.map((server) => {
							const key = pickKey(candidate.host, candidate.path, server.name);
							return (
								<label
									key={key}
									className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2 py-1.5 hover:bg-hover"
								>
									<input
										type="checkbox"
										className="mt-0.5"
										checked={selected[key] === true}
										onChange={() => toggle(key)}
									/>
									<span className="min-w-0 flex-1">
										<span className="block text-[12px] text-ink">{server.name}</span>
										<span className="block truncate font-mono text-[10px] text-ink-faint">
											{server.summary}
										</span>
										{server.conflict && (
											<span className="block text-[10px] text-red-600">
												{t("settings.mcp.import.conflict")}
											</span>
										)}
									</span>
								</label>
							);
						})}
					</div>
				</div>
			))}

			{candidates !== null && candidates.length > 0 && (
				<div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
					<span className="text-[11px] text-ink-dim">
						{t("settings.mcp.import.selected", { count: selectedCount })}
					</span>
					<Button
						variant="primary"
						size="sm"
						disabled={importing || selectedCount === 0}
						onClick={() => void submit()}
					>
						{importing ? t("settings.mcp.import.importing") : t("settings.mcp.import.action")}
					</Button>
				</div>
			)}
		</div>
	);
}
