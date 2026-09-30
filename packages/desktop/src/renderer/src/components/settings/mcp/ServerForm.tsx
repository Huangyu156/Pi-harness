import { MCP_SECRET_MASK, type McpTransportKind } from "@percho/shared";
import { type ReactNode, useState } from "react";
import { useT } from "../../../i18n";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { Tooltip } from "../../ui/Tooltip";
import { formError, type McpServerFormState } from "./form";

/** 传输三选一（选项中不翻译：就是配置里的 type 字面量） */
const TRANSPORTS: McpTransportKind[] = ["stdio", "http", "sse"];

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";
const textareaClass = `${inputClass} min-h-16 resize-y font-mono text-[11px] leading-relaxed`;

/**
 * 带标签的输入行（字段多，统一 label 与间距）。
 * 用 div 而非 label 包控件：控件是调用方传进来的 ReactNode，静态规则看不进 label（a11y/noLabelWithoutControl），
 * 且内部 fieldset 语义对这块表单没有增益——可访问名由各控件自己的 placeholder/aria 承担。
 */
function Field({
	label,
	hint,
	className = "",
	children,
}: {
	label: string;
	hint?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={`flex flex-col gap-1 ${className}`}>
			<span className="text-[11px] text-ink-dim">{label}</span>
			{children}
			{hint && <span className="text-[10px] leading-relaxed text-ink-faint">{hint}</span>}
		</div>
	);
}

/** 开关行：左文右控（多行说明会占满宽度，控件固定不换行） */
function SwitchRow({
	label,
	hint,
	checked,
	onCheckedChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="col-span-2 flex items-center justify-between gap-3 rounded-lg border border-border/60 px-2.5 py-1.5">
			<div className="min-w-0">
				<div className="text-[12px] text-ink">{label}</div>
				{hint && <p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">{hint}</p>}
			</div>
			<Switch checked={checked} onCheckedChange={onCheckedChange} />
		</div>
	);
}

/**
 * MCP 服务器新增/编辑表单（两种模式共用）。
 * 编辑时全字段来自 `view.config`（凭据值是 `***` 哨兵，原样提交即保持原值）；
 * 名称是配置与记忆键的主键，编辑态锁定。
 */
export function ServerForm({
	title,
	initial,
	lockName = false,
	onSubmit,
	onCancel,
}: {
	title: string;
	initial: McpServerFormState;
	lockName?: boolean;
	onSubmit: (form: McpServerFormState) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState(initial);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const invalid = formError(form);
	const isStdio = form.transport === "stdio";
	// 凭据字段：编辑态回填成 KEY=***，原样提交即保持原值（后端按哨兵还原磁盘上的值）
	const secretHint = t("settings.mcp.form.secretMaskHint", { mask: MCP_SECRET_MASK });

	const submit = async () => {
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(form);
		} catch (err) {
			// IPC 层错误（落盘失败/校验失败）就地展示，表单保持打开
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const nameInput = (
		<input
			className={inputClass}
			placeholder={t("settings.mcp.form.namePlaceholder")}
			value={form.name}
			disabled={lockName}
			onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
		/>
	);

	return (
		<div className="mt-2 rounded-xl border border-border-strong bg-surface p-3">
			<h3 className="text-[13px] font-medium text-ink">{title}</h3>
			<div className="mt-2 grid grid-cols-2 gap-2">
				<Field label={t("settings.mcp.form.name")}>
					{lockName ? (
						<Tooltip label={t("settings.mcp.form.nameLocked")} className="w-full">
							{nameInput}
						</Tooltip>
					) : (
						nameInput
					)}
				</Field>
				<div className="flex flex-col gap-1">
					<span className="text-[11px] text-ink-dim">{t("settings.mcp.form.transport")}</span>
					<div className="flex gap-1.5">
						{TRANSPORTS.map((kind) => (
							<button
								key={kind}
								type="button"
								className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${
									form.transport === kind
										? "border-ink bg-ink text-on-ink"
										: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
								}`}
								onClick={() => setForm((f) => ({ ...f, transport: kind }))}
							>
								{kind}
							</button>
						))}
					</div>
				</div>

				{isStdio ? (
					<>
						<Field label={t("settings.mcp.form.command")} className="col-span-2">
							<input
								className={inputClass}
								placeholder={t("settings.mcp.form.commandPlaceholder")}
								value={form.command}
								onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
							/>
						</Field>
						<Field label={t("settings.mcp.form.args")}>
							<textarea
								className={textareaClass}
								placeholder={t("settings.mcp.form.argsPlaceholder")}
								value={form.argsText}
								onChange={(e) => setForm((f) => ({ ...f, argsText: e.target.value }))}
							/>
						</Field>
						<Field label={t("settings.mcp.form.env")} hint={secretHint}>
							<textarea
								className={textareaClass}
								placeholder={t("settings.mcp.form.envPlaceholder")}
								value={form.envText}
								onChange={(e) => setForm((f) => ({ ...f, envText: e.target.value }))}
							/>
						</Field>
						<Field label={t("settings.mcp.form.cwd")}>
							<input
								className={inputClass}
								placeholder={t("settings.mcp.form.cwdPlaceholder")}
								value={form.cwd}
								onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
							/>
						</Field>
						<SwitchRow
							label={t("settings.mcp.form.inheritEnv")}
							hint={t("settings.mcp.form.inheritEnvHint")}
							checked={form.inheritEnv}
							onCheckedChange={(checked) => setForm((f) => ({ ...f, inheritEnv: checked }))}
						/>
					</>
				) : (
					<>
						<Field label={t("settings.mcp.form.url")} className="col-span-2">
							<input
								className={inputClass}
								placeholder={t("settings.mcp.form.urlPlaceholder")}
								value={form.url}
								onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
							/>
						</Field>
						<Field label={t("settings.mcp.form.auth")}>
							<select
								className={inputClass}
								value={form.authKind}
								onChange={(e) =>
									setForm((f) => ({
										...f,
										authKind: e.target.value as McpServerFormState["authKind"],
									}))
								}
							>
								{(["none", "header", "oauth"] as const).map((kind) => (
									<option key={kind} value={kind}>
										{t(`settings.mcp.form.authKind.${kind}`)}
									</option>
								))}
							</select>
						</Field>
						<Field label={t("settings.mcp.form.caFile")}>
							<input
								className={inputClass}
								placeholder={t("settings.mcp.form.caFilePlaceholder")}
								value={form.caFile}
								onChange={(e) => setForm((f) => ({ ...f, caFile: e.target.value }))}
							/>
						</Field>
						<Field label={t("settings.mcp.form.headers")} hint={secretHint} className="col-span-2">
							<textarea
								className={textareaClass}
								placeholder={t("settings.mcp.form.headersPlaceholder")}
								value={form.headersText}
								onChange={(e) => setForm((f) => ({ ...f, headersText: e.target.value }))}
							/>
						</Field>
						<SwitchRow
							label={t("settings.mcp.form.rejectUnauthorized")}
							hint={t("settings.mcp.form.rejectUnauthorizedHint")}
							checked={form.rejectUnauthorized}
							onCheckedChange={(checked) => setForm((f) => ({ ...f, rejectUnauthorized: checked }))}
						/>
					</>
				)}

				<div className="col-span-2 mt-1 border-t border-border pt-2 text-[11px] font-medium text-ink-dim">
					{t("settings.mcp.form.percho")}
				</div>
				<SwitchRow
					label={t("settings.mcp.form.lazy")}
					hint={t("settings.mcp.form.lazyHint")}
					checked={form.lazy}
					onCheckedChange={(checked) => setForm((f) => ({ ...f, lazy: checked }))}
				/>
				<SwitchRow
					label={t("settings.mcp.form.directTools")}
					hint={t("settings.mcp.directToolsHint")}
					checked={form.directTools}
					onCheckedChange={(checked) => setForm((f) => ({ ...f, directTools: checked }))}
				/>
				<Field label={t("settings.mcp.form.idleTimeout")}>
					<input
						className={inputClass}
						placeholder={t("settings.mcp.form.idleTimeoutPlaceholder")}
						value={form.idleTimeoutMsText}
						onChange={(e) => setForm((f) => ({ ...f, idleTimeoutMsText: e.target.value }))}
					/>
				</Field>
				<div />
				<Field label={t("settings.mcp.form.exclude")} hint={t("settings.mcp.form.excludeHint")}>
					<textarea
						className={textareaClass}
						placeholder={t("settings.mcp.form.excludePlaceholder")}
						value={form.excludeText}
						onChange={(e) => setForm((f) => ({ ...f, excludeText: e.target.value }))}
					/>
				</Field>
				<Field label={t("settings.mcp.form.ask")} hint={t("settings.mcp.form.askHint")}>
					<textarea
						className={textareaClass}
						placeholder={t("settings.mcp.form.askPlaceholder")}
						value={form.askText}
						onChange={(e) => setForm((f) => ({ ...f, askText: e.target.value }))}
					/>
				</Field>
			</div>

			{invalid && (
				<p className="mt-2 text-[11px] text-amber-500">{t(`settings.mcp.form.error.${invalid}`)}</p>
			)}
			{error && (
				<p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] break-all text-red-600">{error}</p>
			)}

			<div className="mt-2 flex justify-end gap-2">
				<Button onClick={onCancel}>{t("common.cancel")}</Button>
				<Button variant="primary" disabled={submitting || invalid !== null} onClick={() => void submit()}>
					{submitting ? t("settings.mcp.form.submitting") : t("common.save")}
				</Button>
			</div>
		</div>
	);
}
