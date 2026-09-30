import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStoreCorruptedError } from "../src/json-store";
import type { McpCredentialStore, StoredCredential } from "../src/mcp/auth/store";
import { makeMcpCredentialStore } from "../src/mcp/auth/store";

/**
 * MCP 凭据存储测试：0600 落盘、往返读写、SEP-2352 的「按 issuer 隔离」、损坏文件的读写语义。
 * 全程用 mkdtemp 临时 agentDir，绝不碰开发者本机的真实 agentDir。
 */

interface AuthFileShape {
	version: number;
	credentials: Record<string, StoredCredential>;
}

let dir: string;
let path: string;
let store: McpCredentialStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "percho-mcp-auth-"));
	path = join(dir, "mcp-auth.json");
	store = makeMcpCredentialStore(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function credential(overrides: Partial<StoredCredential> = {}): StoredCredential {
	return {
		kind: "oauth",
		issuer: "https://as-one.example",
		resource: "https://mcp-one.example/mcp",
		clientId: "client-one",
		accessToken: "access-one",
		refreshToken: "refresh-one",
		expiresAt: 1_700_000_000_000,
		tokenEndpoint: "https://as-one.example/token",
		scope: "mcp:tools",
		...overrides,
	};
}

async function readAuthFile(): Promise<AuthFileShape> {
	const parsed: AuthFileShape = JSON.parse(await readFile(path, "utf8"));
	return parsed;
}

/** 手写落盘内容：文件可被人工编辑，测试要能构造残缺/脏条目 */
async function writeAuthFile(credentials: Record<string, unknown>): Promise<void> {
	await writeFile(path, JSON.stringify({ version: 1, credentials }), "utf8");
}

describe("makeMcpCredentialStore", () => {
	it("按服务器名往返读写，落盘形状为 version 1 + credentials 映射", async () => {
		const stored = credential();
		await store.setForServer("fs", stored);
		expect(await store.getForServer("fs")).toEqual(stored);
		expect(await readAuthFile()).toEqual({ version: 1, credentials: { fs: stored } });
		expect(await store.connectedServers()).toEqual(["fs"]);
	});

	it("不同服务器的凭据互相隔离（互不覆盖、清单排序）", async () => {
		await store.setForServer("zeta", credential({ accessToken: "z-token" }));
		await store.setForServer("alpha", credential({ accessToken: "a-token" }));
		expect(await store.getForServer("zeta")).toMatchObject({ accessToken: "z-token" });
		expect(await store.getForServer("alpha")).toMatchObject({ accessToken: "a-token" });
		expect(await store.connectedServers()).toEqual(["alpha", "zeta"]);
	});

	it("issuer 变更时先清除旧凭据再写入（禁止跨 AS 复用令牌）", async () => {
		await store.setForServer(
			"fs",
			credential({ issuer: "https://as-one.example", refreshToken: "old-refresh", scope: "old-scope" }),
		);
		const rotated = credential({
			issuer: "https://as-two.example",
			clientId: "client-two",
			accessToken: "access-two",
			tokenEndpoint: "https://as-two.example/token",
			refreshToken: undefined,
			scope: undefined,
		});
		await store.setForServer("fs", rotated);

		// 旧 AS 的字段（refreshToken/scope/clientId）不得残留在新条目里
		expect(await store.getForServer("fs")).toEqual(rotated);
		expect((await readAuthFile()).credentials.fs).toEqual(rotated);
	});

	it("同一 issuer 的更新是整体替换（不残留上一次的字段）", async () => {
		await store.setForServer("fs", credential({ scope: "mcp:tools" }));
		const updated = credential({ accessToken: "access-new", refreshToken: undefined, scope: undefined });
		await store.setForServer("fs", updated);
		expect(await store.getForServer("fs")).toEqual(updated);
		expect((await readAuthFile()).credentials.fs).toEqual(updated);
	});

	it("clearServer 幂等，且从 connectedServers 移除", async () => {
		await store.setForServer("fs", credential());
		await store.clearServer("fs");
		await store.clearServer("fs");
		expect(await store.getForServer("fs")).toBeNull();
		expect(await store.connectedServers()).toEqual([]);
	});
});

describe("makeMcpCredentialStore 脏数据与损坏", () => {
	it("形状不完整的手工条目一律不算已连接", async () => {
		await writeAuthFile({
			good: credential(),
			"missing-token": {
				kind: "oauth",
				issuer: "https://as-one.example",
				clientId: "client-one",
				expiresAt: 1,
				tokenEndpoint: "https://as-one.example/token",
			},
			"empty-issuer": credential({ issuer: "" }),
			"dirty-refresh": { ...credential(), refreshToken: 123, scope: { a: 1 } },
			"wrong-kind": { ...credential(), kind: "bearer" },
			"not-object": "nope",
		});

		expect(await store.connectedServers()).toEqual(["good"]);
		expect(await store.getForServer("good")).toMatchObject({ accessToken: "access-one" });
		expect(await store.getForServer("dirty-refresh")).toBeNull();
		expect(await store.getForServer("missing-token")).toBeNull();
		expect(await store.getForServer("not-object")).toBeNull();
	});

	it("credentials 不是对象时按空表处理（不炸在 update 的 mutator 里）", async () => {
		await writeFile(path, JSON.stringify({ version: 1, credentials: [] }), "utf8");
		expect(await store.connectedServers()).toEqual([]);
		await store.setForServer("fs", credential({ accessToken: "fresh" }));
		expect(await store.getForServer("fs")).toMatchObject({ accessToken: "fresh" });
	});

	it("文件损坏：读侧回退未连接，写侧抛 JsonStoreCorruptedError 且不覆盖真数据", async () => {
		await writeFile(path, "{ not json", "utf8");

		expect(await store.getForServer("fs")).toBeNull();
		expect(await store.connectedServers()).toEqual([]);
		await expect(store.setForServer("fs", credential())).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		await expect(store.clearServer("fs")).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		expect(await readFile(path, "utf8")).toBe("{ not json");
	});

	it("setForServer 拒绝空 issuer 与空 accessToken（就地校验，不落盘）", async () => {
		await expect(store.setForServer("fs", credential({ issuer: "" }))).rejects.toThrow(
			"Credential issuer is required",
		);
		await expect(store.setForServer("fs", credential({ accessToken: "" }))).rejects.toThrow(
			"Credential access token is required",
		);
		await expect(readFile(path, "utf8")).rejects.toThrow();
	});
});

// win32 跳过：NTFS 没有 POSIX mode 语义（statSync().mode 恒为 0o666/0o444 之类），
// 断言 0600 在 Windows 上永远失败；权限由 POSIX 上的 JsonStore mode 参数保证。
it.skipIf(process.platform === "win32")("凭据文件权限为 0600", async () => {
	await store.setForServer("fs", credential());
	expect(statSync(path).mode & 0o777).toBe(0o600);
});
