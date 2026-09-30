/**
 * MCP OAuth 2.1 客户端（规范 specification/2026-07-28/basic/authorization，零依赖）。
 *
 * 为什么不用全局 fetch、也不引 OAuth 库：zero-dep 是仓库硬约束；HTTP 一律走 ../http 的
 * mcpHttpJson —— 它带 per-request TLS 选项（企业自签 CA 在 fetch 上透传不了）。
 *
 * 流程：受保护资源元数据（RFC 9728）→ AS 元数据（RFC 8414 / OIDC）→ 客户端注册（DCR 优先，
 * 不可用则让用户贴 client_id）→ PKCE S256 + loopback 回调（RFC 8252）→ 授权码换令牌。
 *
 * 生命周期约定：所有失败路径返回结果对象（不向调用方抛异常，UI 只分 cancelled / failed）；
 * 错误消息一律英文，且绝不带 token / code / code_verifier。
 */

import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "../../log";
import type { McpHttpRequestOptions, McpTlsOptions } from "../http";
import { mcpHttpJson } from "../http";
import { asRecord, recordArray, recordString } from "../json";
import type { McpCredentialStore, StoredCredential } from "./store";

const log = createLogger("mcp-oauth");

/** `mcpHttpJson` 的替身类型（测试注入点；生产固定走真实底座） */
type FetchJson = typeof mcpHttpJson;

export interface OAuthPromptContext {
	/** 向用户要一段输入（client_id / 授权码）；返回 null = 用户取消 */
	prompt: (kind: "client_id" | "manual_code" | "client_secret", message: string) => Promise<string | null>;
	/** 通知类事件（authorization URL / progress / info），由 UI 展示并可打开浏览器 */
	notify: (event: { type: "auth_url"; url: string } | { type: "progress"; message: string }) => void;
}

/** 授权码回调的等待上限；超时按「用户取消」处理（规范未规定，5 分钟是浏览器登录的常识下界） */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
/** 续期余量：避免「刚判定未过期、请求发出去已过期」 */
const EXPIRY_SKEW_MS = 60_000;
/** AS 没回 expires_in 时的估计时长（RFC 6749 里它可选；按 1 小时估计，避免每次调用都刷令牌） */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * PKCE S256 challenge（RFC 7636 §4.2）：base64url(SHA-256(verifier))，无 padding。
 * 导出为纯函数是为了能用 RFC 7636 附录 B 的已知向量断言（流程测试只能证明自洽）。
 */
export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 401 + `WWW-Authenticate: Bearer` 表示需要 OAuth（RFC 6750 §3）。
 * 不要求带 `resource_metadata`：MCP 规范推荐它用于发现 PRM，但只在根路径暴露 well-known 的
 * 服务器不带也能探测成功，硬要求会让它们永远触发不了登录。
 */
export function isAuthorizationRequired(status: number, wwwAuthenticate: string | undefined): boolean {
	if (status !== 401 || wwwAuthenticate === undefined) return false;
	// 头里可能并列多个 challenge（`Basic realm="x", Bearer`），只认独立的 Bearer
	return /(?:^|,)\s*bearer\b/i.test(wwwAuthenticate);
}

/** 单次 JSON 请求；网络/TLS/非 JSON 响应都归为 null（调用方按候选列表继续或判失败） */
async function tryFetchJson(
	fetchJson: FetchJson,
	request: McpHttpRequestOptions,
): Promise<{ status: number; json: unknown } | null> {
	try {
		return await fetchJson(request);
	} catch (err) {
		log.debug("MCP OAuth 请求失败", request.method, request.url, errorMessage(err));
		return null;
	}
}

function postForm(tokenEndpoint: string, body: URLSearchParams, signal: AbortSignal, tls?: McpTlsOptions) {
	return {
		url: tokenEndpoint,
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: body.toString(),
		signal,
		tls,
	} satisfies McpHttpRequestOptions;
}

interface ProtectedResource {
	authorizationServer: string;
	/** AS 声明的 canonical resource 优先；RFC 8707 要求把它带进授权与令牌请求 */
	resource: string;
	scopes: string[];
}

/**
 * RFC 9728 受保护资源元数据发现。先试 origin 根，再试「资源路径前缀变体」——规范对带路径的
 * 资源要求 path-insertion 形式，早期服务器又常只部署在根上，两种都试是互操作性要求（代价一次 404）。
 */
async function discoverProtectedResource(
	fetchJson: FetchJson,
	resourceUrl: string,
	signal: AbortSignal,
	tls?: McpTlsOptions,
): Promise<ProtectedResource | null> {
	const target = new URL(resourceUrl);
	const root = `${target.origin}/.well-known/oauth-protected-resource`;
	const candidates = target.pathname === "/" ? [root] : [root, `${root}${target.pathname}`];
	for (const url of candidates) {
		const result = await tryFetchJson(fetchJson, {
			url,
			method: "GET",
			headers: { accept: "application/json" },
			signal,
			tls,
		});
		if (result === null || result.status !== 200) continue;
		const { json } = result;
		const servers = recordArray(json, "authorization_servers") ?? [];
		const authorizationServer = servers.find(
			(entry): entry is string => typeof entry === "string" && entry !== "",
		);
		if (authorizationServer === undefined) continue;
		const scopes = (recordArray(json, "scopes_supported") ?? []).filter(
			(scope): scope is string => typeof scope === "string",
		);
		const declaredResource = recordString(json, "resource");
		return {
			authorizationServer,
			resource: declaredResource === undefined || declaredResource === "" ? resourceUrl : declaredResource,
			scopes,
		};
	}
	return null;
}

interface AuthServerMetadata {
	/** AS 自报的 issuer（RFC 8414 issuer / OIDC issuer）；RFC 9207 的 iss 必须与它精确相等 */
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	/** 已声明的不支持 S256 = 无法安全继续（PKCE 是 OAuth 2.1 的 MUST） */
	pkceS256: boolean;
}

/** 候选 well-known 路径：RFC 8414 的 path-insertion 形式 + OIDC 的根路径形式（去重后依次尝试） */
function wellKnownCandidates(issuer: string): string[] {
	const base = new URL(issuer);
	const suffix = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
	return [
		`${base.origin}/.well-known/oauth-authorization-server${suffix}`,
		`${base.origin}/.well-known/openid-configuration${suffix}`,
		`${base.origin}/.well-known/openid-configuration`,
	];
}

/** RFC 8414 / OIDC 元数据发现；endpoint 允许相对路径（按 issuer 解析，宽松于规范但不误判） */
async function discoverAuthServer(
	fetchJson: FetchJson,
	authorizationServer: string,
	signal: AbortSignal,
	tls?: McpTlsOptions,
): Promise<AuthServerMetadata | null> {
	const seen = new Set<string>();
	for (const url of wellKnownCandidates(authorizationServer)) {
		if (seen.has(url)) continue;
		seen.add(url);
		const result = await tryFetchJson(fetchJson, {
			url,
			method: "GET",
			headers: { accept: "application/json" },
			signal,
			tls,
		});
		if (result === null || result.status !== 200) continue;
		const { json } = result;
		const authorizationEndpoint = recordString(json, "authorization_endpoint");
		const tokenEndpoint = recordString(json, "token_endpoint");
		if (authorizationEndpoint === undefined || tokenEndpoint === undefined) continue;
		const declaredIssuer = recordString(json, "issuer");
		const registrationEndpoint = recordString(json, "registration_endpoint");
		const methods = recordArray(json, "code_challenge_methods_supported");
		return {
			issuer: declaredIssuer === undefined || declaredIssuer === "" ? authorizationServer : declaredIssuer,
			authorizationEndpoint: new URL(authorizationEndpoint, authorizationServer).toString(),
			tokenEndpoint: new URL(tokenEndpoint, authorizationServer).toString(),
			registrationEndpoint:
				registrationEndpoint === undefined
					? undefined
					: new URL(registrationEndpoint, authorizationServer).toString(),
			// 字段缺省按「支持 S256」处理：多数 MCP 服务器省略它，硬要求会让它们永远登录不了
			pkceS256: methods === undefined || methods.includes("S256"),
		};
	}
	return null;
}

type ClientResolution =
	| { kind: "client"; clientId: string; clientSecret?: string }
	| { kind: "cancelled" }
	| { kind: "error"; error: string };

/**
 * 客户端注册：优先 DCR（RFC 7591）。服务器不支持（无 registration_endpoint 或注册被拒）时退化为
 * 让用户贴一个现成 client_id —— 2026-07-28 规范允许仅支持 Client ID Metadata Documents 的服务器，
 * 它们不提供 DCR，但没有 client_id 就无法继续。
 */
async function resolveClient(options: {
	fetchJson: FetchJson;
	metadata: AuthServerMetadata;
	redirectUri: string;
	ctx: OAuthPromptContext;
	signal: AbortSignal;
	tls?: McpTlsOptions;
}): Promise<ClientResolution> {
	const { fetchJson, metadata, redirectUri, ctx, signal, tls } = options;
	if (metadata.registrationEndpoint !== undefined) {
		const result = await tryFetchJson(fetchJson, {
			url: metadata.registrationEndpoint,
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				client_name: "Percho",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				// 规范 2026-07-28：native 应用必须显式声明 application_type，否则服务器按 web 处理
				application_type: "native",
			}),
			signal,
			tls,
		});
		const clientId = result === null ? undefined : recordString(result.json, "client_id");
		if (result !== null && result.status >= 200 && result.status < 300 && clientId !== undefined) {
			const clientSecret = recordString(result.json, "client_secret");
			return {
				kind: "client",
				clientId,
				clientSecret: clientSecret === undefined || clientSecret === "" ? undefined : clientSecret,
			};
		}
		log.info("MCP DCR 不可用，改为让用户提供 client_id", metadata.registrationEndpoint, result?.status);
	}
	const clientId = await ctx.prompt(
		"client_id",
		"Dynamic client registration is unavailable. Enter the OAuth client ID to use for Percho.",
	);
	if (clientId === null) return { kind: "cancelled" };
	if (clientId.trim() === "") return { kind: "error", error: "No OAuth client ID provided" };
	return { kind: "client", clientId: clientId.trim() };
}

export type CallbackOutcome =
	| { kind: "code"; code: string; iss?: string }
	| { kind: "error"; error: string }
	| { kind: "cancelled" };

export interface LoopbackCallback {
	redirectUri: string;
	/** 等一次投递（首次回调即结算，随后服务器自行关闭）；close 后未结算的等待按 cancelled 结算 */
	wait(): Promise<CallbackOutcome>;
	/** 幂等关闭 */
	close(): void;
}

/** 依次尝试候选端口；全失败返回 null（调用方转「手动粘贴 code」） */
async function listenLoopback(ports: number[]): Promise<Server | null> {
	for (const port of ports) {
		const server = createServer();
		try {
			server.listen(port, "127.0.0.1");
			// events.once 在 listening 前收到 error（EADDRINUSE 等）会 reject，正好当「换下一个候选」
			await once(server, "listening");
			return server;
		} catch (err) {
			log.debug("MCP OAuth 回调端口不可用", port, errorMessage(err));
			server.close();
		}
	}
	return null;
}

/** manual 模式（绑定失败）下的 loopback URI：只作形式上的一致性锚点，没有东西在监听它 */
function unboundRedirectUri(): string {
	return `http://127.0.0.1:${49152 + Math.floor(Math.random() * 16384)}/callback`;
}

/**
 * 起本地回调服务器（RFC 8252 §7.3 loopback）：只绑 127.0.0.1、端口 0 由内核分配。
 * 返回 null = 所有候选端口都绑不上，调用方改为让用户从浏览器地址栏复制 code —— 此时
 * redirect_uri 仍必须是同一个值（换令牌会做 redirect_uri 一致性校验）。
 */
export async function startCallbackServer(options: {
	/** 期望的 state（CSRF），回调必须原样回显 */
	state: string;
	/** 候选端口，默认 [0]（内核随机分配）；测试用它构造「端口被占」场景 */
	ports?: number[];
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<LoopbackCallback | null> {
	const server = await listenLoopback(options.ports ?? [0]);
	if (server === null) return null;
	const { port } = server.address() as AddressInfo;
	const redirectUri = `http://127.0.0.1:${port}/callback`;

	// 不预建 promise：等待方可能晚于结算到达（manual 回退 / 已 abort），late wait 必须拿到已结算结果
	const waiters: Array<(outcome: CallbackOutcome) => void> = [];
	let outcome: CallbackOutcome | null = null;
	let closed = false;
	let timer: NodeJS.Timeout | undefined;

	/** 幂等结算：回调 / 超时 / abort 竞态时首次到达者生效，其余静默丢弃 */
	const settle = (value: CallbackOutcome): void => {
		if (outcome !== null) return;
		outcome = value;
		for (const waiter of waiters.splice(0)) waiter(value);
		close();
	};

	/** 幂等关闭；未结算的等待按「用户取消」结算（否则调用方会永久挂起） */
	const close = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		options.signal?.removeEventListener("abort", onAbort);
		// close 只停止接受新连接：响应写完的 socket 靠 connection: close 自行收尾
		server.close();
		settle({ kind: "cancelled" });
	};

	const onAbort = (): void => {
		settle({ kind: "cancelled" });
	};

	server.on("request", (req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const send = (status: number, body: string): void => {
			res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
			res.end(body);
		};
		if (url.pathname !== "/callback") {
			send(404, "Not found");
			return;
		}
		const error = url.searchParams.get("error");
		if (error !== null) {
			send(400, `Authorization failed: ${error}. You can close this window.`);
			settle({ kind: "error", error: `Authorization server returned ${error}` });
			return;
		}
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (code === null) {
			send(400, "Missing authorization code. You can close this window.");
			settle({ kind: "error", error: "Authorization callback is missing the code parameter" });
			return;
		}
		if (state !== options.state) {
			send(400, "State mismatch. You can close this window.");
			settle({ kind: "error", error: "Authorization response state does not match the request" });
			return;
		}
		send(200, "Authentication complete. You can close this window and return to Percho.");
		settle({ kind: "code", code, iss: url.searchParams.get("iss") ?? undefined });
	});

	server.on("error", (err) => {
		log.warn("MCP OAuth 回调服务器出错", errorMessage(err));
		settle({ kind: "error", error: `Callback server failed: ${errorMessage(err)}` });
	});

	timer = setTimeout(() => settle({ kind: "cancelled" }), options.timeoutMs ?? CALLBACK_TIMEOUT_MS);
	timer.unref?.();
	if (options.signal !== undefined) {
		if (options.signal.aborted) settle({ kind: "cancelled" });
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	return {
		redirectUri,
		wait: async () => {
			if (outcome !== null) return outcome;
			// 这里必须手工造 promise：等待方由回调/超时/abort 三方之一来结算，且仓库 lib 是 ES2023
			// （没有 Promise.withResolvers 的类型声明，用它会让 tsc 报 TS2550）
			return new Promise<CallbackOutcome>((resolve) => {
				waiters.push(resolve);
			});
		},
		close,
	};
}

/** 用户从地址栏粘回来的可能是裸 code、完整回调 URL 或查询串：能取参数就取，取不到当裸 code */
function parseManualInput(text: string): { code: string; iss?: string; state?: string } | { error: string } {
	const looksLikeUrl = /^(https?:)?\/\//.test(text) || /[?&](code|error)=/.test(text);
	if (!looksLikeUrl) return { code: text };
	const withoutHash = text.slice(0, text.indexOf("#") === -1 ? undefined : text.indexOf("#"));
	const query = withoutHash.slice(withoutHash.indexOf("?") + 1);
	const params = new URLSearchParams(query);
	const error = params.get("error");
	if (error !== null) return { error: `Authorization server returned ${error}` };
	const code = params.get("code");
	if (code === null || code === "") return { error: "No authorization code found in the pasted value" };
	return { code, iss: params.get("iss") ?? undefined, state: params.get("state") ?? undefined };
}

async function promptManualCode(ctx: OAuthPromptContext, expectedState: string): Promise<CallbackOutcome> {
	const input = await ctx.prompt(
		"manual_code",
		"Listening on a local port failed. Complete authorization in the browser, then paste the code " +
			"(or the full redirect URL) from the address bar.",
	);
	if (input === null) return { kind: "cancelled" };
	const trimmed = input.trim();
	if (trimmed === "") return { kind: "error", error: "No authorization code provided" };
	const parsed = parseManualInput(trimmed);
	if ("error" in parsed) return { kind: "error", error: parsed.error };
	// 粘整条 URL 时 state 仍可校验（CSRF）；裸 code 无从校验 —— 这是 RFC 8252 手动复制的固有取舍
	if (parsed.state !== undefined && parsed.state !== expectedState) {
		return { kind: "error", error: "Authorization response state does not match the request" };
	}
	return { kind: "code", code: parsed.code, iss: parsed.iss };
}

type TokenOutcome =
	| { kind: "token"; accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }
	/** 有状态码的失败（errorCode = 响应体里的 OAuth error） */
	| { kind: "rejected"; status: number; errorCode?: string };

/** 令牌端点 POST；返回 null = 传输层失败（网络/超时/非 JSON） */
async function requestToken(options: {
	fetchJson: FetchJson;
	tokenEndpoint: string;
	body: URLSearchParams;
	signal: AbortSignal;
	tls?: McpTlsOptions;
}): Promise<TokenOutcome | null> {
	const result = await tryFetchJson(
		options.fetchJson,
		postForm(options.tokenEndpoint, options.body, options.signal, options.tls),
	);
	if (result === null) return null;
	const { status, json } = result;
	const accessToken = recordString(json, "access_token");
	if (status >= 200 && status < 300 && accessToken !== undefined && accessToken !== "") {
		const expiresIn = asRecord(json)?.expires_in;
		return {
			kind: "token",
			accessToken,
			refreshToken: recordString(json, "refresh_token"),
			expiresIn: typeof expiresIn === "number" ? expiresIn : undefined,
			scope: recordString(json, "scope"),
		};
	}
	return { kind: "rejected", status, errorCode: recordString(json, "error") };
}

/** 把令牌结果折算成落盘凭据（refresh 时保留既有字段，只覆盖令牌相关项） */
function credentialFromToken(
	base: Pick<
		StoredCredential,
		"issuer" | "resource" | "clientId" | "clientSecret" | "tokenEndpoint" | "scope"
	>,
	token: Extract<TokenOutcome, { kind: "token" }>,
	previousRefreshToken?: string,
): StoredCredential {
	return {
		kind: "oauth",
		issuer: base.issuer,
		resource: base.resource,
		clientId: base.clientId,
		clientSecret: base.clientSecret,
		accessToken: token.accessToken,
		refreshToken: token.refreshToken ?? previousRefreshToken,
		expiresAt: Date.now() + (token.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
		tokenEndpoint: base.tokenEndpoint,
		// 刷新响应允许省略 scope（RFC 6749 §5.1）：省略时沿用原 scope，否则会把授权范围越刷越窄
		scope: token.scope ?? base.scope,
	};
}

export async function runOAuthLogin(options: {
	server: string;
	resourceUrl: string;
	store: McpCredentialStore;
	ctx: OAuthPromptContext;
	signal: AbortSignal;
	fetchJson?: typeof mcpHttpJson; // 测试注入点
	/** 回调服务器的候选端口（测试注入点，用于构造「端口被占 → 手动粘贴」）；缺省内核随机分配 */
	callbackPorts?: number[];
	/** 与 HTTP 传输共用 TLS 选项（自签 CA 的 AS 才有意义） */
	tls?: McpTlsOptions;
}): Promise<{ ok: boolean; cancelled: boolean; error: string | null }> {
	const { server, resourceUrl, store, ctx, signal } = options;
	const fetchJson: FetchJson = options.fetchJson ?? mcpHttpJson;
	const tls = options.tls;
	const failed = (error: string) => ({ ok: false, cancelled: false, error });
	const cancelled = () => ({ ok: false, cancelled: true, error: null });
	let callback: LoopbackCallback | null = null;
	// 已 abort 就别再发任何请求（否则失败原因会变成网络错误，语义从「取消」退化成「失败」）
	if (signal.aborted) return cancelled();

	try {
		ctx.notify({ type: "progress", message: "Discovering the authorization server for this MCP server" });
		const resource = await discoverProtectedResource(fetchJson, resourceUrl, signal, tls);
		if (resource === null) {
			if (signal.aborted) return cancelled();
			return failed("Could not find the OAuth protected resource metadata for this MCP server");
		}
		const metadata = await discoverAuthServer(fetchJson, resource.authorizationServer, signal, tls);
		if (metadata === null) {
			if (signal.aborted) return cancelled();
			return failed("Could not find the OAuth authorization server metadata");
		}
		if (!metadata.pkceS256) return failed("The authorization server does not support PKCE S256");

		// 32 字节 = 43 个 base64url 字符，正好落在 RFC 7636 的 43~128 区间；state 只需不可预测
		const verifier = randomBytes(32).toString("base64url");
		const state = randomBytes(16).toString("base64url");
		callback = await startCallbackServer({ state, signal, ports: options.callbackPorts });
		if (callback === null) log.info("MCP OAuth 回调端口不可用，改用手动粘贴 code", server);
		const redirectUri = callback?.redirectUri ?? unboundRedirectUri();

		ctx.notify({ type: "progress", message: "Registering Percho with the authorization server" });
		const client = await resolveClient({ fetchJson, metadata, redirectUri, ctx, signal, tls });
		if (client.kind === "cancelled") return cancelled();
		if (client.kind === "error") return failed(client.error);

		const authorizeUrl = new URL(metadata.authorizationEndpoint);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", client.clientId);
		authorizeUrl.searchParams.set("redirect_uri", redirectUri);
		authorizeUrl.searchParams.set("state", state);
		authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		// RFC 8707：资源指示符，AS 据此把令牌受众绑定到本 MCP 服务器
		authorizeUrl.searchParams.set("resource", resource.resource);
		if (resource.scopes.length > 0) authorizeUrl.searchParams.set("scope", resource.scopes.join(" "));

		ctx.notify({ type: "auth_url", url: authorizeUrl.toString() });
		ctx.notify({ type: "progress", message: "Waiting for authorization in the browser" });
		const outcome = callback === null ? await promptManualCode(ctx, state) : await callback.wait();
		callback?.close();
		callback = null;

		if (outcome.kind === "cancelled") return cancelled();
		if (outcome.kind === "error") return failed(outcome.error);
		// RFC 9207：AS 回了 iss 就必须与记录的 issuer 精确相等，否则令牌可能来自另一个 AS
		if (outcome.iss !== undefined && outcome.iss !== metadata.issuer) {
			return failed(`Authorization response issuer mismatch: expected ${metadata.issuer}`);
		}

		ctx.notify({ type: "progress", message: "Exchanging the authorization code for an access token" });
		const exchange = (clientSecret: string | undefined) => {
			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code: outcome.code,
				redirect_uri: redirectUri,
				client_id: client.clientId,
				code_verifier: verifier,
				resource: resource.resource,
			});
			if (clientSecret !== undefined) body.set("client_secret", clientSecret);
			return requestToken({
				fetchJson,
				tokenEndpoint: metadata.tokenEndpoint,
				body,
				signal,
				tls,
			});
		};
		let token = await exchange(client.clientSecret);
		let clientSecret = client.clientSecret;
		if (token?.kind === "rejected" && (token.status === 401 || token.errorCode === "invalid_client")) {
			// 机密客户端（手工贴的 client_id 常见）需要 client_secret；只问一次再重试
			const secret = await ctx.prompt(
				"client_secret",
				"The authorization server rejected the client credentials. Enter the client secret for this " +
					"client ID, or cancel to abort.",
			);
			if (secret === null) return cancelled();
			clientSecret = secret.trim() === "" ? undefined : secret.trim();
			token = await exchange(clientSecret);
		}
		if (token === null) return failed("Token request failed (network error or timeout)");
		if (token.kind === "rejected") {
			const detail = token.errorCode === undefined ? "" : ` (${token.errorCode})`;
			return failed(`Token request was rejected with status ${token.status}${detail}`);
		}

		await store.setForServer(
			server,
			credentialFromToken(
				{
					issuer: metadata.issuer,
					resource: resource.resource,
					clientId: client.clientId,
					clientSecret,
					tokenEndpoint: metadata.tokenEndpoint,
				},
				token,
			),
		);
		log.info("MCP OAuth 登录成功", server, metadata.issuer);
		return { ok: true, cancelled: false, error: null };
	} catch (err) {
		log.warn("MCP OAuth 登录失败", server, errorMessage(err));
		return failed(errorMessage(err));
	} finally {
		callback?.close();
	}
}

/**
 * 取可直接使用的 `authorization` 请求头值。
 *
 * 返回值语义（pin 死）：**完整头值**，形如 `Bearer <access_token>`，不是裸 token ——
 * registry 的 authHeader 会被 client 原样塞进 `setAuthHeaders({ authorization: header })`，
 * 传输层不做任何前缀拼装。未过期直接用；过期且能续期则刷新；否则 null（上层据此提示重新登录）。
 * 不抛异常 —— 调用方是每次工具调用的热路径，失败只表示「这次没有凭据」。
 */
export async function acquireAccessToken(options: {
	server: string;
	resourceUrl: string;
	store: McpCredentialStore;
	signal: AbortSignal;
	fetchJson?: typeof mcpHttpJson;
	tls?: McpTlsOptions;
}): Promise<string | null> {
	const { server, resourceUrl, store, signal } = options;
	const fetchJson: FetchJson = options.fetchJson ?? mcpHttpJson;
	let stored: StoredCredential | null;
	try {
		stored = await store.getForServer(server);
	} catch (err) {
		log.warn("读取 MCP 凭据失败", server, errorMessage(err));
		return null;
	}
	if (stored === null) return null;
	if (stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) return `Bearer ${stored.accessToken}`;
	if (stored.refreshToken === undefined) return null;

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: stored.refreshToken,
		client_id: stored.clientId,
		resource: stored.resource ?? resourceUrl,
	});
	if (stored.clientSecret !== undefined) body.set("client_secret", stored.clientSecret);
	const token = await requestToken({
		fetchJson,
		tokenEndpoint: stored.tokenEndpoint,
		body,
		signal,
		tls: options.tls,
	});
	if (token === null) {
		log.debug("MCP 令牌刷新请求失败（保留凭据，等下次再试）", server);
		return null;
	}
	if (token.kind === "token") {
		try {
			await store.setForServer(server, credentialFromToken(stored, token, stored.refreshToken));
		} catch (err) {
			log.warn("刷新后的 MCP 凭据保存失败", server, errorMessage(err));
		}
		log.info("MCP 访问令牌已刷新", server, stored.issuer);
		return `Bearer ${token.accessToken}`;
	}
	// 400 invalid_grant（刷新令牌失效/被撤销）与 401 invalid_client（客户端被注销）都不可自愈：
	// 清掉凭据让上层走完整登录；5xx 等瞬时故障保留凭据，避免用户被迫重新授权。
	const terminal =
		token.status === 400 ||
		token.status === 401 ||
		token.errorCode === "invalid_grant" ||
		token.errorCode === "invalid_client";
	if (!terminal) {
		log.debug("MCP 令牌刷新被拒（疑似瞬时故障，保留凭据）", server, token.status, token.errorCode);
		return null;
	}
	log.info("MCP 令牌刷新被拒，清除该服务器的凭据", server, stored.issuer, token.status, token.errorCode);
	try {
		await store.clearServer(server);
	} catch (err) {
		log.warn("清除 MCP 凭据失败", server, errorMessage(err));
	}
	return null;
}
