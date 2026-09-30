import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initLogging } from "../src/log";
import type { OAuthPromptContext } from "../src/mcp/auth/oauth";
import {
	acquireAccessToken,
	isAuthorizationRequired,
	pkceChallenge,
	runOAuthLogin,
	startCallbackServer,
} from "../src/mcp/auth/oauth";
import type { McpCredentialStore, StoredCredential } from "../src/mcp/auth/store";
import { makeMcpCredentialStore } from "../src/mcp/auth/store";
import { asRecord } from "../src/mcp/json";

/**
 * MCP OAuth 客户端测试：全部走真实网络 —— 本地 node:http 假授权服务器（node:http，不是 mock）
 * 与真实 loopback 回调服务器。浏览器侧由测试用 fetch 模拟：请求授权 URL 拿 302，再把回调打回本地。
 */

/** loopback 回调地址形态（RFC 8252 §7.3：只绑 127.0.0.1，端口由内核分配） */
const CALLBACK_URI = /^http:\/\/127\.0\.0\.1:\d+\/callback$/;

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "percho-mcp-oauth-"));
	dirs.push(dir);
	return dir;
}

function firstOf<T>(items: T[], what: string): T {
	const [first] = items;
	if (first === undefined) throw new Error(`Expected at least one ${what}`);
	return first;
}

/** 起一个内核分配端口的本地服务，返回 base URL 供测试拼接路径 */
async function listenRandomPort(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

/** IncomingMessage 是 async iterable，直接收流；POST 表单与 JSON body 都走这里 */
async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function readLogs(dir: string): Promise<string> {
	const logDir = join(dir, "logs");
	const files = await readdir(logDir);
	const texts = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
	return texts.join("");
}

interface RecordedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	form: URLSearchParams;
}

interface FakeAuthServerOptions {
	/** DCR：dcr 正常、absent 不暴露端点、rejected 端点返回 400 */
	registration?: "dcr" | "absent" | "rejected";
	/** 受保护资源元数据部署位置：root 根路径、path 仅资源路径前缀、none 都没有 */
	prmAt?: "root" | "path" | "none";
	/** AS 元数据部署形态：rfc8414 或仅 OIDC 变体；none = 都不提供 */
	metadataAt?: "rfc8414" | "oidc" | "none";
	/** 授权响应里的 iss：缺省 = 真实 origin；null = 不带 iss 字段 */
	redirectIssuer?: string | null;
	/** PKCE 方法声明；缺省 ["S256"] */
	pkceMethods?: string[];
	/** 换令牌要求 client_secret（用于验证「提示输入 secret 后重试」） */
	requiresClientSecret?: boolean;
	/** refresh_token 的失败响应；缺省成功并轮换 refresh token */
	refreshFailure?: { status: number; error: string };
	/** 受保护资源元数据里省略 resource（验证客户端回退到配置的 resourceUrl） */
	omitDeclaredResource?: boolean;
}

interface FakeAuthServer {
	origin: string;
	requests: RecordedRequest[];
	registrationBody: unknown;
	authorizationQuery: URLSearchParams | null;
	lastRedirect: string | null;
	tokenRequests: URLSearchParams[];
	close(): Promise<void>;
}

/** 本地假授权服务器：PRM / AS 元数据 / DCR / 授权端点 / 令牌端点，并记录收到的每个请求 */
async function startFakeAuthServer(options: FakeAuthServerOptions = {}): Promise<FakeAuthServer> {
	const server = createServer();
	const pendingCodes = new Map<
		string,
		{ challenge: string; redirectUri: string; clientId: string; scope: string | null }
	>();
	let issuedCodes = 0;

	const state: FakeAuthServer = {
		origin: "",
		requests: [],
		registrationBody: null,
		authorizationQuery: null,
		lastRedirect: null,
		tokenRequests: [],
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};

	const protectedResourceDocument = (): Record<string, unknown> => ({
		authorization_servers: [state.origin],
		scopes_supported: ["mcp:tools", "mcp:read"],
		...(options.omitDeclaredResource === true ? {} : { resource: `${state.origin}/canonical` }),
	});

	const authServerDocument = (): Record<string, unknown> => ({
		issuer: state.origin,
		authorization_endpoint: `${state.origin}/authorize`,
		token_endpoint: `${state.origin}/token`,
		code_challenge_methods_supported: options.pkceMethods ?? ["S256"],
		...(options.registration === "absent" ? {} : { registration_endpoint: `${state.origin}/register` }),
	});

	const handleAuthorize = (url: URL, res: ServerResponse): void => {
		state.authorizationQuery = url.searchParams;
		const redirectUri = url.searchParams.get("redirect_uri") ?? "";
		const challenge = url.searchParams.get("code_challenge") ?? "";
		const clientId = url.searchParams.get("client_id") ?? "";
		if (
			url.searchParams.get("response_type") !== "code" ||
			url.searchParams.get("code_challenge_method") !== "S256" ||
			challenge === "" ||
			clientId === "" ||
			redirectUri === ""
		) {
			respondJson(res, 400, { error: "invalid_request" });
			return;
		}
		issuedCodes += 1;
		const code = `code-${issuedCodes}`;
		pendingCodes.set(code, {
			challenge,
			redirectUri,
			clientId,
			scope: url.searchParams.get("scope"),
		});
		const target = new URL(redirectUri);
		target.searchParams.set("code", code);
		target.searchParams.set("state", url.searchParams.get("state") ?? "");
		// RFC 9207：缺省回真实 iss；测试可显式传 null 造「不带 iss」的响应
		const iss = options.redirectIssuer === undefined ? state.origin : options.redirectIssuer;
		if (iss !== null) target.searchParams.set("iss", iss);
		state.lastRedirect = target.toString();
		res.writeHead(302, { location: target.toString(), "content-length": "0" });
		res.end();
	};

	const handleToken = (form: URLSearchParams, res: ServerResponse): void => {
		state.tokenRequests.push(form);
		if (form.get("grant_type") === "refresh_token") {
			if (options.refreshFailure !== undefined) {
				respondJson(res, options.refreshFailure.status, { error: options.refreshFailure.error });
				return;
			}
			// 故意不回 scope：刷新响应允许省略它，客户端必须沿用原 scope
			respondJson(res, 200, {
				access_token: "access-refreshed",
				token_type: "Bearer",
				expires_in: 1800,
				refresh_token: "refresh-rotated",
			});
			return;
		}
		const code = form.get("code") ?? "";
		const pending = pendingCodes.get(code);
		if (pending === undefined) {
			respondJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
			return;
		}
		if (form.get("client_id") !== pending.clientId || form.get("redirect_uri") !== pending.redirectUri) {
			respondJson(res, 400, { error: "invalid_grant", error_description: "client or redirect mismatch" });
			return;
		}
		const verifier = form.get("code_verifier") ?? "";
		if (verifier === "" || pkceChallenge(verifier) !== pending.challenge) {
			respondJson(res, 400, { error: "invalid_grant", error_description: "pkce verification failed" });
			return;
		}
		if (options.requiresClientSecret === true && form.get("client_secret") !== "the-secret") {
			// 客户端凭据失败时不清 code：真实 AS 允许带 secret 重试
			respondJson(res, 401, { error: "invalid_client" });
			return;
		}
		pendingCodes.delete(code);
		respondJson(res, 200, {
			access_token: "access-issued",
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: "refresh-issued",
			...(pending.scope === null ? {} : { scope: pending.scope }),
		});
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", state.origin);
		const raw = await readBody(req);
		state.requests.push({
			method: req.method ?? "",
			path: url.pathname,
			query: url.searchParams,
			form: new URLSearchParams(raw),
		});
		if (url.pathname === "/.well-known/oauth-protected-resource") {
			if (options.prmAt === "path" || options.prmAt === "none") respondJson(res, 404, { error: "not_found" });
			else respondJson(res, 200, protectedResourceDocument());
			return;
		}
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
			if (options.prmAt === "none") respondJson(res, 404, { error: "not_found" });
			else respondJson(res, 200, protectedResourceDocument());
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			if (options.metadataAt === "oidc" || options.metadataAt === "none") {
				respondJson(res, 404, { error: "not_found" });
			} else {
				respondJson(res, 200, authServerDocument());
			}
			return;
		}
		if (url.pathname === "/.well-known/openid-configuration") {
			if (options.metadataAt === "none") respondJson(res, 404, { error: "not_found" });
			else respondJson(res, 200, authServerDocument());
			return;
		}
		if (url.pathname === "/register") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
			state.registrationBody = parsed;
			if (options.registration === "rejected") respondJson(res, 400, { error: "invalid_client_metadata" });
			else respondJson(res, 201, { client_id: "dcr-client" });
			return;
		}
		if (url.pathname === "/authorize") {
			handleAuthorize(url, res);
			return;
		}
		if (url.pathname === "/token") {
			handleToken(new URLSearchParams(raw), res);
			return;
		}
		respondJson(res, 404, { error: "not_found" });
	};

	server.on("request", (req, res) => {
		void handle(req, res);
	});
	servers.push(server);
	state.origin = await listenRandomPort(server);
	return state;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
	const text = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

interface TestContext {
	ctx: OAuthPromptContext;
	authUrls: string[];
	progress: string[];
	prompts: Array<{ kind: string; message: string }>;
}

/** 收集 notify/prompt 的假 UI；answer 决定每次 prompt 的返回值（null = 用户取消） */
function makeContext(
	answer: (kind: "client_id" | "manual_code" | "client_secret", message: string) => Promise<string | null>,
): TestContext {
	const authUrls: string[] = [];
	const progress: string[] = [];
	const prompts: Array<{ kind: string; message: string }> = [];
	return {
		ctx: {
			prompt: async (kind, message) => {
				prompts.push({ kind, message });
				return answer(kind, message);
			},
			notify: (event) => {
				if (event.type === "auth_url") authUrls.push(event.url);
				else progress.push(event.message);
			},
		},
		authUrls,
		progress,
		prompts,
	};
}

/** 模拟浏览器打开授权 URL：拿 302 的 Location（回调 URL），不跟随 */
async function authorizeRedirect(authUrl: string): Promise<string> {
	const response = await fetch(authUrl, { redirect: "manual" });
	const location = response.headers.get("location");
	await response.arrayBuffer();
	if (location === null) {
		throw new Error(`Authorization endpoint did not redirect (status ${response.status})`);
	}
	return location;
}

/** 模拟浏览器落到 loopback 回调（返回回调服务器给浏览器的状态码） */
async function deliverCallback(location: string): Promise<number> {
	const response = await fetch(location);
	await response.arrayBuffer();
	return response.status;
}

/** 等 UI 拿到 auth_url，再完成「打开授权页 → 回调」两步 */
async function completeBrowserFlow(ui: TestContext, what = "authorization URL"): Promise<number> {
	await vi.waitFor(() => expect(ui.authUrls).toHaveLength(1), { timeout: 5_000 });
	const location = await authorizeRedirect(firstOf(ui.authUrls, what));
	return deliverCallback(location);
}

function storedCredential(origin: string, overrides: Partial<StoredCredential> = {}): StoredCredential {
	return {
		kind: "oauth",
		issuer: origin,
		resource: `${origin}/canonical`,
		clientId: "dcr-client",
		accessToken: "access-old",
		refreshToken: "refresh-old",
		expiresAt: Date.now() + 3_600_000,
		tokenEndpoint: `${origin}/token`,
		scope: "mcp:tools",
		...overrides,
	};
}

interface ManualFlow {
	fake: FakeAuthServer;
	store: McpCredentialStore;
	ui: TestContext;
	login: Promise<{ ok: boolean; cancelled: boolean; error: string | null }>;
}

/**
 * 「回调端口被占 → 手动粘贴」场景的装配：先占住端口让 loopback 绑定失败，再在 prompt("manual_code")
 * 里扮演用户去浏览器完成授权（等 auth_url → 请求授权端点 → 把 code 或整条回调 URL 粘回来）。
 */
async function startManualLogin(paste: "bare-code" | "full-url" | "stale-state"): Promise<ManualFlow> {
	const occupied = createServer();
	servers.push(occupied);
	const occupiedPort = Number(new URL(await listenRandomPort(occupied)).port);

	const fake = await startFakeAuthServer();
	const store = makeMcpCredentialStore(await newAgentDir());
	const ui = makeContext(async (kind) => {
		if (kind !== "manual_code") return null;
		await vi.waitFor(() => expect(ui.authUrls).toHaveLength(1), { timeout: 5_000 });
		const location = await authorizeRedirect(firstOf(ui.authUrls, "authorization URL"));
		if (paste === "bare-code") return new URL(location).searchParams.get("code");
		if (paste === "stale-state") {
			const tampered = new URL(location);
			tampered.searchParams.set("state", "stale");
			return tampered.toString();
		}
		return location;
	});
	const login = runOAuthLogin({
		server: "fs",
		resourceUrl: `${fake.origin}/mcp`,
		store,
		ctx: ui.ctx,
		signal: new AbortController().signal,
		callbackPorts: [occupiedPort],
	});
	return { fake, store, ui, login };
}

describe("pkceChallenge", () => {
	it("RFC 7636 附录 B 已知向量", () => {
		expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});
});

describe("isAuthorizationRequired", () => {
	it("401 + Bearer challenge 判为需要授权", () => {
		expect(isAuthorizationRequired(401, "Bearer")).toBe(true);
		expect(isAuthorizationRequired(401, 'Bearer realm="mcp"')).toBe(true);
		expect(
			isAuthorizationRequired(
				401,
				'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
			),
		).toBe(true);
		// 头里可能并列多个 challenge
		expect(isAuthorizationRequired(401, 'Basic realm="x", Bearer error="invalid_token"')).toBe(true);
	});

	it("非 401、无头、非 Bearer challenge 都判为否", () => {
		expect(isAuthorizationRequired(200, "Bearer")).toBe(false);
		expect(isAuthorizationRequired(403, "Bearer")).toBe(false);
		expect(isAuthorizationRequired(401, undefined)).toBe(false);
		expect(isAuthorizationRequired(401, 'Basic realm="x"')).toBe(false);
		expect(isAuthorizationRequired(401, "NotBearer")).toBe(false);
	});
});

describe("runOAuthLogin", () => {
	it("DCR + PKCE + loopback 回调跑通，令牌按 issuer 落盘且不进日志", async () => {
		const fake = await startFakeAuthServer();
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		initLogging(join(dir, "logs"), "debug");
		const resourceUrl = `${fake.origin}/mcp`;
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });

		// DCR 请求体：native 应用必须声明 application_type（规范 2026-07-28）
		expect(fake.registrationBody).toMatchObject({
			client_name: "Percho",
			application_type: "native",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		});
		const registered = asRecord(fake.registrationBody) ?? {};
		expect(registered.redirect_uris).toEqual([expect.stringMatching(CALLBACK_URI)]);

		// 授权请求：PKCE S256 + RFC 8707 resource（用 PRM 声明的 canonical resource）
		const authorize = fake.authorizationQuery;
		expect(authorize).not.toBeNull();
		expect(authorize?.get("code_challenge_method")).toBe("S256");
		expect(authorize?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(authorize?.get("resource")).toBe(`${fake.origin}/canonical`);
		expect(authorize?.get("scope")).toBe("mcp:tools mcp:read");
		expect(authorize?.get("redirect_uri")).toMatch(CALLBACK_URI);

		// 换令牌：假 AS 校验了 verifier 与 challenge 自洽（PKCE 的真实端到端验证）
		const exchange = firstOf(fake.tokenRequests, "token request");
		expect(exchange.get("grant_type")).toBe("authorization_code");
		expect(exchange.get("client_id")).toBe("dcr-client");
		expect(exchange.get("redirect_uri")).toBe(authorize?.get("redirect_uri"));
		expect(exchange.get("resource")).toBe(`${fake.origin}/canonical`);
		expect(exchange.get("client_secret")).toBeNull();
		const verifier = exchange.get("code_verifier") ?? "";
		expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
		expect(pkceChallenge(verifier)).toBe(authorize?.get("code_challenge"));

		const credential = await store.getForServer("fs");
		expect(credential).toMatchObject({
			kind: "oauth",
			issuer: fake.origin,
			resource: `${fake.origin}/canonical`,
			clientId: "dcr-client",
			accessToken: "access-issued",
			refreshToken: "refresh-issued",
			tokenEndpoint: `${fake.origin}/token`,
			scope: "mcp:tools mcp:read",
		});
		expect(credential?.clientSecret).toBeUndefined();
		expect(Math.abs((credential?.expiresAt ?? 0) - (Date.now() + 3_600_000))).toBeLessThan(5_000);

		// 凭据绝不进日志（先证明日志确实被捕获，避免 not.toContain 落空）
		const logs = await readLogs(dir);
		expect(logs).toContain("MCP OAuth 登录成功");
		expect(logs).not.toContain("access-issued");
		expect(logs).not.toContain("refresh-issued");
		expect(logs).not.toContain(verifier);
	});

	it("授权响应不带 iss 时也接受（RFC 9207 的 iss 是可选的）", async () => {
		const fake = await startFakeAuthServer({ redirectIssuer: null });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(await store.getForServer("fs")).toMatchObject({ accessToken: "access-issued" });
	});

	it("iss 与 AS 元数据不一致时失败，且不兑换令牌、不落盘", async () => {
		const fake = await startFakeAuthServer({ redirectIssuer: "https://evil.example" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		const result = await login;
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(false);
		expect(result.error).toEqual(expect.stringContaining("issuer mismatch"));
		expect(fake.tokenRequests).toHaveLength(0);
		expect(await store.getForServer("fs")).toBeNull();
	});

	it("AS 不提供 DCR 时用 prompt 拿到的 client_id 完成流程", async () => {
		const fake = await startFakeAuthServer({ registration: "absent", omitDeclaredResource: true });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const resourceUrl = `${fake.origin}/mcp`;
		const ui = makeContext(async (kind) => (kind === "client_id" ? "manual-client" : null));
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(ui.prompts.map((prompt) => prompt.kind)).toEqual(["client_id"]);
		expect(fake.requests.some((request) => request.path === "/register")).toBe(false);
		expect(firstOf(fake.tokenRequests, "token request").get("client_id")).toBe("manual-client");
		// PRM 没声明 resource 时回退到配置里的服务器 URL
		expect(fake.authorizationQuery?.get("resource")).toBe(resourceUrl);
		expect(await store.getForServer("fs")).toMatchObject({
			clientId: "manual-client",
			resource: resourceUrl,
		});
	});

	it("DCR 端点被拒（400）时同样回退到 prompt", async () => {
		const fake = await startFakeAuthServer({ registration: "rejected" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async (kind) => (kind === "client_id" ? "manual-client" : null));
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(fake.requests.some((request) => request.path === "/register")).toBe(true);
		expect(ui.prompts.map((prompt) => prompt.kind)).toEqual(["client_id"]);
		expect(await store.getForServer("fs")).toMatchObject({ clientId: "manual-client" });
	});

	it("令牌端拒绝客户端凭据时提示输入 client_secret 并重试", async () => {
		const fake = await startFakeAuthServer({ registration: "absent", requiresClientSecret: true });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async (kind) => {
			if (kind === "client_id") return "manual-client";
			if (kind === "client_secret") return "the-secret";
			return null;
		});
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(ui.prompts.map((prompt) => prompt.kind)).toEqual(["client_id", "client_secret"]);
		expect(fake.tokenRequests).toHaveLength(2);
		expect(firstOf(fake.tokenRequests, "first token request").get("client_secret")).toBeNull();
		expect(fake.tokenRequests[1]?.get("client_secret")).toBe("the-secret");
		expect(await store.getForServer("fs")).toMatchObject({ clientSecret: "the-secret" });
	});

	it("用户在 prompt 里取消得到 cancelled:true（不发授权请求、不落盘）", async () => {
		const fake = await startFakeAuthServer({ registration: "absent" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const result = await runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(result).toEqual({ ok: false, cancelled: true, error: null });
		expect(ui.prompts.map((prompt) => prompt.kind)).toEqual(["client_id"]);
		expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);
		expect(await store.getForServer("fs")).toBeNull();
	});

	it("等待授权期间 abort 得到 cancelled:true", async () => {
		const fake = await startFakeAuthServer();
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const controller = new AbortController();
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: controller.signal,
		});

		await vi.waitFor(() => expect(ui.authUrls).toHaveLength(1), { timeout: 5_000 });
		controller.abort();
		expect(await login).toEqual({ ok: false, cancelled: true, error: null });
		expect(await store.getForServer("fs")).toBeNull();
	});

	it("已 abort 的 signal 直接返回 cancelled，不发任何请求", async () => {
		const fake = await startFakeAuthServer();
		const dir = await newAgentDir();
		const controller = new AbortController();
		controller.abort();
		const result = await runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store: makeMcpCredentialStore(dir),
			ctx: makeContext(async () => null).ctx,
			signal: controller.signal,
		});

		expect(result).toEqual({ ok: false, cancelled: true, error: null });
		expect(fake.requests).toHaveLength(0);
	});

	it("回调端口被占时回退到手动粘贴 code（redirect_uri 仍与授权请求一致）", async () => {
		const flow = await startManualLogin("bare-code");
		expect(await flow.login).toEqual({ ok: true, cancelled: false, error: null });
		expect(flow.ui.prompts.map((prompt) => prompt.kind)).toEqual(["manual_code"]);
		const exchange = firstOf(flow.fake.tokenRequests, "token request");
		expect(exchange.get("code")).toBe("code-1");
		expect(exchange.get("redirect_uri")).toBe(flow.fake.authorizationQuery?.get("redirect_uri"));
		expect(exchange.get("resource")).toBe(`${flow.fake.origin}/canonical`);
		expect(await flow.store.getForServer("fs")).toMatchObject({ accessToken: "access-issued" });
	});

	it("手动粘贴整条回调 URL 时也能取出 code 与 iss", async () => {
		const flow = await startManualLogin("full-url");
		expect(await flow.login).toEqual({ ok: true, cancelled: false, error: null });
		expect(firstOf(flow.fake.tokenRequests, "token request").get("code")).toBe("code-1");
		expect(await flow.store.getForServer("fs")).toMatchObject({ accessToken: "access-issued" });
	});

	it("手动粘贴的 URL 里 state 不匹配时判失败（CSRF 防护）", async () => {
		const flow = await startManualLogin("stale-state");
		const result = await flow.login;
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(false);
		expect(result.error).toEqual(expect.stringContaining("state"));
		expect(flow.fake.tokenRequests).toHaveLength(0);
		expect(await flow.store.getForServer("fs")).toBeNull();
	});

	it("受保护资源元数据只部署在资源路径前缀下也能发现", async () => {
		const fake = await startFakeAuthServer({ prmAt: "path" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(
			fake.requests.some((request) => request.path === "/.well-known/oauth-protected-resource/mcp"),
		).toBe(true);
	});

	it("AS 元数据只在 OIDC 变体下提供时也能发现", async () => {
		const fake = await startFakeAuthServer({ metadataAt: "oidc" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const login = runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(await completeBrowserFlow(ui)).toBe(200);
		expect(await login).toEqual({ ok: true, cancelled: false, error: null });
		expect(fake.requests.some((request) => request.path === "/.well-known/openid-configuration")).toBe(true);
	});

	it("发现失败时返回错误对象（不抛异常、不落盘）", async () => {
		const withoutPrm = await startFakeAuthServer({ prmAt: "none" });
		const withoutMetadata = await startFakeAuthServer({ metadataAt: "none" });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const signal = new AbortController().signal;

		expect(
			await runOAuthLogin({
				server: "fs",
				resourceUrl: `${withoutPrm.origin}/mcp`,
				store,
				ctx: makeContext(async () => null).ctx,
				signal,
			}),
		).toEqual({
			ok: false,
			cancelled: false,
			error: "Could not find the OAuth protected resource metadata for this MCP server",
		});
		expect(
			await runOAuthLogin({
				server: "fs",
				resourceUrl: `${withoutMetadata.origin}/mcp`,
				store,
				ctx: makeContext(async () => null).ctx,
				signal,
			}),
		).toEqual({
			ok: false,
			cancelled: false,
			error: "Could not find the OAuth authorization server metadata",
		});
		expect(await store.getForServer("fs")).toBeNull();
	});

	it("AS 声明不支持 S256 时拒绝登录（PKCE 无法安全降级）", async () => {
		const fake = await startFakeAuthServer({ pkceMethods: ["plain"] });
		const dir = await newAgentDir();
		const store = makeMcpCredentialStore(dir);
		const ui = makeContext(async () => null);
		const result = await runOAuthLogin({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			ctx: ui.ctx,
			signal: new AbortController().signal,
		});

		expect(result).toEqual({
			ok: false,
			cancelled: false,
			error: "The authorization server does not support PKCE S256",
		});
		expect(ui.authUrls).toEqual([]);
		expect(fake.requests.some((request) => request.path === "/authorize")).toBe(false);
	});
});

describe("startCallbackServer", () => {
	it("投递 code 与 iss，回调地址只绑 127.0.0.1", async () => {
		const callback = await startCallbackServer({ state: "state-1" });
		if (callback === null) throw new Error("callback server did not start");
		expect(callback.redirectUri).toMatch(CALLBACK_URI);

		const delivered = fetch(
			`${callback.redirectUri}?code=abc&state=state-1&iss=${encodeURIComponent("https://as.example")}`,
		);
		expect(await callback.wait()).toEqual({ kind: "code", code: "abc", iss: "https://as.example" });
		const response = await delivered;
		expect(response.status).toBe(200);
		await response.arrayBuffer();
	});

	it("state 不匹配时判失败（CSRF 防护）", async () => {
		const callback = await startCallbackServer({ state: "expected" });
		if (callback === null) throw new Error("callback server did not start");
		const response = await fetch(`${callback.redirectUri}?code=abc&state=other`);
		await response.arrayBuffer();
		expect(response.status).toBe(400);
		expect(await callback.wait()).toEqual({
			kind: "error",
			error: "Authorization response state does not match the request",
		});
	});

	it("回调带 error 参数时判失败", async () => {
		const callback = await startCallbackServer({ state: "s" });
		if (callback === null) throw new Error("callback server did not start");
		const response = await fetch(`${callback.redirectUri}?error=access_denied`);
		await response.arrayBuffer();
		expect(response.status).toBe(400);
		expect(await callback.wait()).toEqual({
			kind: "error",
			error: "Authorization server returned access_denied",
		});
	});

	it("close 幂等，未结算的等待按 cancelled 结算（含事后 wait）", async () => {
		const callback = await startCallbackServer({ state: "s" });
		if (callback === null) throw new Error("callback server did not start");
		const pending = callback.wait();
		callback.close();
		callback.close();
		expect(await pending).toEqual({ kind: "cancelled" });
		expect(await callback.wait()).toEqual({ kind: "cancelled" });
	});

	it("超时后按 cancelled 结算", async () => {
		const callback = await startCallbackServer({ state: "s", timeoutMs: 20 });
		if (callback === null) throw new Error("callback server did not start");
		expect(await callback.wait()).toEqual({ kind: "cancelled" });
	});

	it("signal 已 abort 时立即按 cancelled 结算", async () => {
		const controller = new AbortController();
		controller.abort();
		const callback = await startCallbackServer({ state: "s", signal: controller.signal });
		if (callback === null) throw new Error("callback server did not start");
		expect(await callback.wait()).toEqual({ kind: "cancelled" });
	});

	it("候选端口全被占用时返回 null（调用方据此回退到手动粘贴）", async () => {
		const occupied = createServer();
		servers.push(occupied);
		const origin = await listenRandomPort(occupied);
		expect(await startCallbackServer({ state: "s", ports: [Number(new URL(origin).port)] })).toBeNull();
	});
});

describe("acquireAccessToken", () => {
	it("未过期时直接返回完整 Bearer 头且不发网络请求", async () => {
		const fake = await startFakeAuthServer();
		const store = makeMcpCredentialStore(await newAgentDir());
		await store.setForServer("fs", storedCredential(fake.origin));

		const header = await acquireAccessToken({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			signal: new AbortController().signal,
		});
		expect(header).toBe("Bearer access-old");
		expect(fake.requests).toHaveLength(0);
	});

	it("过期但有 refresh_token 时刷新并回写（轮换 refresh_token、沿用 scope）", async () => {
		const fake = await startFakeAuthServer();
		const store = makeMcpCredentialStore(await newAgentDir());
		await store.setForServer("fs", storedCredential(fake.origin, { expiresAt: Date.now() - 1_000 }));

		const header = await acquireAccessToken({
			server: "fs",
			resourceUrl: `${fake.origin}/mcp`,
			store,
			signal: new AbortController().signal,
		});
		expect(header).toBe("Bearer access-refreshed");
		const request = firstOf(fake.tokenRequests, "token request");
		expect(request.get("grant_type")).toBe("refresh_token");
		expect(request.get("refresh_token")).toBe("refresh-old");
		expect(request.get("client_id")).toBe("dcr-client");
		expect(request.get("resource")).toBe(`${fake.origin}/canonical`);
		expect(request.get("client_secret")).toBeNull();

		const credential = await store.getForServer("fs");
		expect(credential).toMatchObject({
			issuer: fake.origin,
			accessToken: "access-refreshed",
			refreshToken: "refresh-rotated",
			scope: "mcp:tools",
		});
		expect(Math.abs((credential?.expiresAt ?? 0) - (Date.now() + 1_800_000))).toBeLessThan(5_000);
	});

	it("剩余有效期不足 60s 余量时提前刷新", async () => {
		const fake = await startFakeAuthServer();
		const store = makeMcpCredentialStore(await newAgentDir());
		await store.setForServer("fs", storedCredential(fake.origin, { expiresAt: Date.now() + 30_000 }));

		expect(
			await acquireAccessToken({
				server: "fs",
				resourceUrl: `${fake.origin}/mcp`,
				store,
				signal: new AbortController().signal,
			}),
		).toBe("Bearer access-refreshed");
	});

	it("刷新被拒（400 invalid_grant）时清除凭据并返回 null", async () => {
		const fake = await startFakeAuthServer({ refreshFailure: { status: 400, error: "invalid_grant" } });
		const store = makeMcpCredentialStore(await newAgentDir());
		await store.setForServer("fs", storedCredential(fake.origin, { expiresAt: Date.now() - 1_000 }));

		expect(
			await acquireAccessToken({
				server: "fs",
				resourceUrl: `${fake.origin}/mcp`,
				store,
				signal: new AbortController().signal,
			}),
		).toBeNull();
		expect(await store.getForServer("fs")).toBeNull();
		expect(await store.connectedServers()).toEqual([]);
	});

	it("刷新遇 5xx 时保留凭据（瞬时故障不自毁登录态）", async () => {
		const fake = await startFakeAuthServer({
			refreshFailure: { status: 503, error: "temporarily_unavailable" },
		});
		const store = makeMcpCredentialStore(await newAgentDir());
		await store.setForServer("fs", storedCredential(fake.origin, { expiresAt: Date.now() - 1_000 }));

		expect(
			await acquireAccessToken({
				server: "fs",
				resourceUrl: `${fake.origin}/mcp`,
				store,
				signal: new AbortController().signal,
			}),
		).toBeNull();
		expect(await store.getForServer("fs")).toMatchObject({ accessToken: "access-old" });
	});

	it("无凭据或过期且无 refresh_token 时返回 null 且不发请求", async () => {
		const fake = await startFakeAuthServer();
		const store = makeMcpCredentialStore(await newAgentDir());
		const signal = new AbortController().signal;

		expect(
			await acquireAccessToken({ server: "fs", resourceUrl: `${fake.origin}/mcp`, store, signal }),
		).toBeNull();
		await store.setForServer(
			"fs",
			storedCredential(fake.origin, { expiresAt: Date.now() - 1_000, refreshToken: undefined }),
		);
		expect(
			await acquireAccessToken({ server: "fs", resourceUrl: `${fake.origin}/mcp`, store, signal }),
		).toBeNull();
		expect(fake.requests).toHaveLength(0);
	});
});
