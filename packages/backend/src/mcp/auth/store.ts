/**
 * MCP OAuth 凭据的持久化层：`<agentDir>/mcp-auth.json`（0600）。
 *
 * 为什么不塞进 pi 的 auth.json：形状不同（这里是按服务器名索引的 OAuth 记录，要留住 issuer /
 * tokenEndpoint / refresh_token），生命周期也不同（登出即整条删除，而不是长期保留的 provider key）。
 *
 * SEP-2352 硬要求：凭据必须与签发它的授权服务器绑定。同一个服务器名改指向另一个 AS 后，旧 issuer
 * 的 token 绝不可复用（否则等于把 A 的令牌出示给 B），因此写入时先清后写。
 *
 * 读写语义沿用 JsonStore：read 侧（getForServer/connectedServers）遇损坏回退「未连接」不阻塞启动；
 * write 侧（setForServer/clearServer）遇损坏抛 JsonStoreCorruptedError 拒写，避免用空表覆盖真凭据。
 */

import { join } from "node:path";
import { JsonStore } from "../../json-store";
import { createLogger } from "../../log";

const log = createLogger("mcp-auth-store");

/** 一个服务器的 OAuth 凭据。`kind` 给未来的其它凭据形态留位，读侧按它判别形状 */
export interface StoredCredential {
	kind: "oauth";
	/** 授权服务器标识（令牌的绑定对象；RFC 8414 的 issuer，比较用精确字符串相等） */
	issuer: string;
	/** MCP 资源服务器 URL（RFC 8707 的 resource）；缺省时上层退回配置里的服务器 URL */
	resource?: string;
	clientId: string;
	clientSecret?: string;
	accessToken: string;
	refreshToken?: string;
	/** 访问令牌过期时刻（ms epoch） */
	expiresAt: number;
	tokenEndpoint: string;
	scope?: string;
}

/** 按服务器名索引的凭据存储（UI 只消费 connectedServers 判定 hasOAuthToken） */
export interface McpCredentialStore {
	getForServer(server: string): Promise<StoredCredential | null>;
	setForServer(server: string, credential: StoredCredential): Promise<void>;
	clearServer(server: string): Promise<void>;
	/** 已存储凭据的服务器名清单（UI hasOAuthToken 判定） */
	connectedServers(): Promise<string[]>;
}

/** 落盘形状；version 给未来的迁移留锚点（当前不做迁移，只按下限校验） */
interface McpAuthFile {
	version: number;
	credentials: Record<string, StoredCredential>;
}

const FILE_NAME = "mcp-auth.json";
const FILE_VERSION = 1;

/**
 * 形状守卫：文件可被手工编辑，残缺条目（缺 accessToken 的中间态）不能算「已连接」——
 * UI 会据此显示已授权，而实际请求必然 401。可选字段也要校验类型：`refreshToken: 123` 这种脏值
 * 会在刷新时被当字符串塞进表单，属于静默污染。
 */
function isStoredCredential(value: unknown): value is StoredCredential {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === "oauth" &&
		typeof record.issuer === "string" &&
		record.issuer !== "" &&
		typeof record.clientId === "string" &&
		record.clientId !== "" &&
		typeof record.accessToken === "string" &&
		record.accessToken !== "" &&
		typeof record.expiresAt === "number" &&
		typeof record.tokenEndpoint === "string" &&
		record.tokenEndpoint !== "" &&
		isOptionalString(record.clientSecret) &&
		isOptionalString(record.refreshToken) &&
		isOptionalString(record.resource) &&
		isOptionalString(record.scope)
	);
}

/** 可选字符串字段：undefined / string 合法，其余（null、数字、对象）都判为脏数据 */
function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

/** credentials 可能是 null/数组/标量（手工编辑或将来版本）；修成空表，免得 update 的 mutator 里炸 */
function normalizeState(raw: McpAuthFile): McpAuthFile {
	const credentials = (raw as { credentials?: unknown } | null)?.credentials;
	if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
		return { version: FILE_VERSION, credentials: {} };
	}
	return { version: FILE_VERSION, credentials: credentials as Record<string, StoredCredential> };
}

/** 日志里只允许出现 token endpoint 的 host（凭据本体绝不落盘之外的地方） */
function endpointHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "(invalid url)";
	}
}

export function makeMcpCredentialStore(agentDir: string): McpCredentialStore {
	const store = new JsonStore<McpAuthFile>({
		path: join(agentDir, FILE_NAME),
		// 工厂而非共享字面量：JsonStore 每次调用现取，避免多个 store 共用同一个可变的默认对象
		defaultValue: () => ({ version: FILE_VERSION, credentials: {} }),
		mode: 0o600,
	});

	const readCredentials = async (): Promise<Record<string, StoredCredential>> =>
		normalizeState(await store.read()).credentials;

	return {
		async getForServer(server: string): Promise<StoredCredential | null> {
			const credential = (await readCredentials())[server];
			return isStoredCredential(credential) ? credential : null;
		},

		async setForServer(server: string, credential: StoredCredential): Promise<void> {
			if (credential.issuer === "") throw new Error("Credential issuer is required");
			if (credential.accessToken === "") throw new Error("Credential access token is required");
			await store.update((draft) => {
				const state = normalizeState(draft);
				const previous = state.credentials[server];
				if (previous !== undefined && previous.issuer !== credential.issuer) {
					// SEP-2352：跨 AS 的旧凭据必须先清除，不能作为「同名条目」留下任何字段影响新 AS 的语义
					log.info("MCP 凭据 issuer 变更：清除旧凭据并重新注册", server, {
						from: previous.issuer,
						to: credential.issuer,
					});
					delete state.credentials[server];
				}
				state.credentials[server] = credential;
				return state;
			});
			log.debug("MCP 凭据已保存", server, credential.issuer, endpointHost(credential.tokenEndpoint));
		},

		async clearServer(server: string): Promise<void> {
			await store.update((draft) => {
				const state = normalizeState(draft);
				delete state.credentials[server];
				return state;
			});
			log.debug("MCP 凭据已清除", server);
		},

		async connectedServers(): Promise<string[]> {
			const credentials = await readCredentials();
			return Object.entries(credentials)
				.filter(([, value]) => isStoredCredential(value))
				.map(([server]) => server)
				.sort();
		},
	};
}
