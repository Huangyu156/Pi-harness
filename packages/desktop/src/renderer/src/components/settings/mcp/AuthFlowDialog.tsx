import type { LoginAuthPrompt } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { Button } from "../../ui/Button";

/**
 * MCP OAuth 登录对话框（模型照 providers/LoginDialog）：渲染后端 `mcp:event` 的 auth 载荷。
 * 两类事件：`auth_url`（交给浏览器，附复制兜底）与 prompt（client_id / 授权码手输）；
 * 流程结束按 McpAuthResult 展示成功/取消/失败，取消不算错误。
 */
export function AuthFlowDialog() {
	const t = useT();
	const flow = useMcpStore((s) => s.authFlow);
	const respond = useMcpStore((s) => s.respondAuth);
	const cancel = useMcpStore((s) => s.cancelAuth);
	const dismiss = useMcpStore((s) => s.dismissAuth);
	const [copied, setCopied] = useState(false);

	// 面板卸载（关设置弹窗）= 取消进行中的授权：否则本地回调服务器会一直等到 5 分钟超时。
	// 结算态也一并清空，避免下次打开面板看到一个已经结束的旧流程。
	useEffect(
		() => () => {
			useMcpStore.getState().cancelAuth();
			useMcpStore.setState({ authFlow: null });
		},
		[],
	);

	if (!flow) return null;
	const { authUrl, pendingPrompt, result } = flow;
	const prompt = pendingPrompt?.prompt;
	const settled = !flow.running;

	const copyUrl = async () => {
		if (!authUrl) return;
		try {
			await navigator.clipboard.writeText(authUrl.url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// 剪贴板不可用：链接本身可点开，静默
			setCopied(false);
		}
	};

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="w-[440px] rounded-xl border border-border bg-surface p-4 shadow-dialog">
				<h3 className="text-sm font-semibold text-ink">
					{t("settings.mcp.auth.title", { name: flow.server })}
				</h3>

				{authUrl && (
					<div className="mt-3 rounded-lg bg-hover px-3 py-2.5">
						<p className="text-[11px] text-ink-2">{t("settings.mcp.auth.browserHint")}</p>
						<button
							type="button"
							className="mt-1 block w-full truncate text-left font-mono text-[11px] text-ink-dim underline underline-offset-2 hover:text-ink"
							onClick={() => void window.pi.openExternal({ url: authUrl.url })}
						>
							{authUrl.url}
						</button>
						<div className="mt-2 flex gap-2">
							<Button size="sm" onClick={() => void window.pi.openExternal({ url: authUrl.url })}>
								{t("settings.mcp.auth.open")}
							</Button>
							<Button size="sm" onClick={() => void copyUrl()}>
								{copied ? t("settings.mcp.auth.copied") : t("settings.mcp.auth.copy")}
							</Button>
						</div>
						{authUrl.instructions && (
							<p className="mt-1 text-[10px] text-ink-faint">{authUrl.instructions}</p>
						)}
					</div>
				)}

				{prompt?.type === "select" && (
					<div className="mt-3">
						<p className="text-[12px] text-ink-2">{prompt.message}</p>
						<div className="mt-2 flex flex-col items-stretch gap-1.5">
							{prompt.options.map((option) => (
								<Button
									key={option.id}
									variant="primary"
									className="justify-start text-left"
									onClick={() => void respond(option.id)}
								>
									{option.label}
									{option.description && (
										<span className="ml-1 text-[11px] opacity-70">{option.description}</span>
									)}
								</Button>
							))}
						</div>
					</div>
				)}

				{/* key=promptId：换提示时重挂载重置输入（与 LoginDialog 同一防串键做法） */}
				{prompt && prompt.type !== "select" && pendingPrompt && (
					<PromptInput key={pendingPrompt.promptId} prompt={prompt} onSubmit={respond} />
				)}

				{flow.running && !flow.error && (
					<div className="mt-3 flex items-center gap-2 text-[11px] text-ink-faint">
						<span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
						<span className="truncate">{flow.statusLine ?? t("settings.mcp.auth.waiting")}</span>
					</div>
				)}

				{flow.error && (
					<p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] break-all text-red-600">
						{t("settings.mcp.auth.failed")}：{flow.error}
					</p>
				)}

				{settled && result && (
					<p
						className={`mt-3 rounded-lg px-3 py-2 text-[12px] ${
							result.ok ? "bg-emerald-50 text-emerald-600" : "bg-hover text-ink-dim"
						}`}
					>
						{result.ok
							? t("settings.mcp.auth.ok")
							: result.cancelled
								? t("settings.mcp.auth.cancelled")
								: `${t("settings.mcp.auth.failed")}：${result.error ?? ""}`}
					</p>
				)}

				<div className="mt-4 flex justify-end">
					{flow.running && !flow.error ? (
						<Button onClick={cancel}>{t("common.cancel")}</Button>
					) : (
						<Button variant="primary" onClick={dismiss}>
							{t("common.close")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

/** 输入提示（client_id / 授权码 / secret）：本地输入态随 promptId 重挂载重置 */
function PromptInput({
	prompt,
	onSubmit,
}: {
	prompt: Exclude<LoginAuthPrompt, { type: "select" }>;
	onSubmit: (value: string) => void;
}) {
	const t = useT();
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const submit = () => {
		if (!input.trim()) return;
		onSubmit(input.trim());
	};

	return (
		<div className="mt-3">
			<p className="text-[12px] text-ink-2">{prompt.message}</p>
			<div className="mt-2 flex items-center gap-2">
				<input
					ref={inputRef}
					type={prompt.type === "secret" ? "password" : "text"}
					className="min-w-0 flex-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint"
					placeholder={prompt.placeholder}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
				/>
				<Button variant="primary" onClick={submit} disabled={!input.trim()}>
					{t("settings.mcp.auth.submit")}
				</Button>
			</div>
		</div>
	);
}
