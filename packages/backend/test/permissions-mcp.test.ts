import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PERMISSION_CONFIG,
	evaluateRules,
	loadPermissionConfig,
	matchTextFor,
	mergeWithDefaults,
	type PermissionRules,
	patternMatchesToolCall,
	suggestPattern,
} from "../src/permissions";

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-perm-mcp-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("matchTextFor：MCP 代理工具与直投工具的匹配主体", () => {
	it("代理工具 tool → <server>__<tool>；server 缺失/空串用 * 占位", () => {
		expect(matchTextFor("mcp", { server: "fs", tool: "read_file" })).toBe("fs__read_file");
		expect(matchTextFor("mcp", { tool: "read_file" })).toBe("*__read_file");
		expect(matchTextFor("mcp", { server: "", tool: "read_file" })).toBe("*__read_file");
		expect(matchTextFor("mcp", { server: 1, tool: "read_file" })).toBe("*__read_file");
	});

	it("元数据入口归一：resource / prompt / describe / search", () => {
		expect(matchTextFor("mcp", { resource: "file:///a.txt" })).toBe("resource:file:///a.txt");
		// prompt 既可能是字符串，也可能是规范 prompts/get 的 { name, arguments } 形状
		expect(matchTextFor("mcp", { prompt: "summarize" })).toBe("prompt:summarize");
		expect(matchTextFor("mcp", { prompt: { name: "summarize", arguments: {} } })).toBe("prompt:summarize");
		expect(matchTextFor("mcp", { prompt: { name: "" } })).toBeNull();
		expect(matchTextFor("mcp", { prompt: {} })).toBeNull();
		expect(matchTextFor("mcp", { describe: "fs" })).toBe("describe");
		expect(matchTextFor("mcp", { search: "file" })).toBe("search");
	});

	it("分支优先级 tool → resource → prompt → describe → search → null", () => {
		expect(
			matchTextFor("mcp", { server: "s", tool: "t", resource: "r", prompt: "p", describe: "d", search: "q" }),
		).toBe("s__t");
		expect(matchTextFor("mcp", { resource: "r", prompt: "p", describe: "d", search: "q" })).toBe(
			"resource:r",
		);
		expect(matchTextFor("mcp", { prompt: "p", describe: "d", search: "q" })).toBe("prompt:p");
		expect(matchTextFor("mcp", { describe: "d", search: "q" })).toBe("describe");
		// 空串字段视为「没有值」，继续往下一层找（不拼出 `__read_file` 这种伪主体）
		expect(matchTextFor("mcp", { tool: "", resource: "r" })).toBe("resource:r");
		expect(matchTextFor("mcp", { prompt: "", search: "q" })).toBe("search");
	});

	it("空调用与非字符串字段返回 null（落回全局兜底，不误命中规则键）", () => {
		expect(matchTextFor("mcp", {})).toBeNull();
		expect(matchTextFor("mcp", { tool: "" })).toBeNull();
		expect(matchTextFor("mcp", { search: 1, describe: null })).toBeNull();
	});

	it("directTools 直投工具去掉 mcp__ 前缀，与代理工具主体同构", () => {
		expect(matchTextFor("mcp__fs__read_file", {})).toBe("fs__read_file");
		expect(matchTextFor("mcp__fs__read_file", { path: "/x" })).toBe("fs__read_file");
		expect(matchTextFor("mcp__", {})).toBeNull();
	});
});

describe("权限后门回归：MCP 默认规则", () => {
	const rules = DEFAULT_PERMISSION_CONFIG.rules;

	it("远端工具调用默认 ask（修复前吃全局 * = allow 零确认放行）", () => {
		expect(evaluateRules(rules, "mcp", "*__delete_file")).toBe("ask");
		expect(evaluateRules(rules, "mcp", "fs__delete_file")).toBe("ask");
		expect(evaluateRules(rules, "mcp", "fs__write_file")).toBe("ask");
		expect(evaluateRules(rules, "mcp", "resource:file:///etc/passwd")).toBe("ask");
		expect(evaluateRules(rules, "mcp", "prompt:evil")).toBe("ask");
	});

	it("端到端（输入 → 匹配主体 → 求值）不再放行：修复前 matchTextFor 返回 null 即 allow", () => {
		const call = { server: "fs", tool: "delete_file", arguments: { path: "/etc/passwd" } };
		expect(evaluateRules(rules, "mcp", matchTextFor("mcp", call))).toBe("ask");
		expect(evaluateRules(rules, "mcp__fs__write_file", matchTextFor("mcp__fs__write_file", {}))).toBe("ask");
		expect(evaluateRules(rules, "mcp", matchTextFor("mcp", { search: "config" }))).toBe("allow");
	});

	it("只读元数据（search / describe）放行", () => {
		expect(evaluateRules(rules, "mcp", "search")).toBe("allow");
		expect(evaluateRules(rules, "mcp", "describe")).toBe("allow");
	});

	it("直投工具默认 ask；mcpScript 一律 ask", () => {
		expect(evaluateRules(rules, "mcp__fs__read_file", null)).toBe("ask");
		expect(evaluateRules(rules, "mcp__fs__read_file", "fs__read_file")).toBe("ask");
		expect(evaluateRules(rules, "mcp__fs__write_file", null)).toBe("ask");
		expect(evaluateRules(rules, "mcpScript", null)).toBe("ask");
	});

	it("自保护：mcp-auth.json 与其余凭据文件同级（bash 含写入，edit/write 按路径后缀）", () => {
		expect(evaluateRules(rules, "bash", "cat ~/.pi/agent/mcp-auth.json")).toBe("ask");
		expect(evaluateRules(rules, "bash", "echo x > ~/.pi/agent/mcp-auth.json")).toBe("ask");
		expect(evaluateRules(rules, "edit", "/home/u/.pi/agent/mcp-auth.json")).toBe("ask");
		expect(evaluateRules(rules, "write", "/home/u/.pi/agent/mcp-auth.json")).toBe("ask");
		// 相似但不匹配的路径不受影响（与既有 auth.json 断言同形）
		expect(evaluateRules(rules, "edit", "/home/u/.pi/agent/mcp-auth.json.bak")).toBe("allow");
	});
});

describe("工具名通配键（directTools 前缀工具而来）", () => {
	it("无精确规则时也继续扫描通配键", () => {
		const rules: PermissionRules = { "*": "allow", "mcp__*": "ask" };
		expect(evaluateRules(rules, "mcp__fs__read_file", null)).toBe("ask");
		expect(evaluateRules(rules, "mcp__fs__write_file", null)).toBe("ask");
		expect(evaluateRules(rules, "mcp__fs__read_file", "fs__read_file")).toBe("ask");
		// 不匹配的键不牵连其它工具
		expect(evaluateRules(rules, "read", "/etc/passwd")).toBe("allow");
	});

	it("精确键优先于通配键", () => {
		const exactString: PermissionRules = { "*": "allow", "mcp__*": "allow", mcp__fs__read_file: "deny" };
		expect(evaluateRules(exactString, "mcp__fs__read_file", null)).toBe("deny");
		expect(evaluateRules(exactString, "mcp__fs__write_file", null)).toBe("allow");

		// 精确键是模式表且匹配文本非空 → 表结果即终局，不再被通配键覆盖
		const exactTable: PermissionRules = {
			"*": "allow",
			"mcp__*": "allow",
			mcp__fs__read_file: { "*": "deny" },
		};
		expect(evaluateRules(exactTable, "mcp__fs__read_file", "fs__read_file")).toBe("deny");
	});

	it("通配键按对象插入序求值，后命中覆盖先命中", () => {
		const narrowLast: PermissionRules = { "*": "allow", "mcp__*": "allow", "mcp__fs__*": "deny" };
		expect(evaluateRules(narrowLast, "mcp__fs__read_file", null)).toBe("deny");

		// 与既有「键序即评估序」一致：后定义的宽键会覆盖先定义的窄键（配置意图如此写就要如此生效）
		const narrowFirst: PermissionRules = { "*": "allow", "mcp__fs__*": "deny", "mcp__*": "allow" };
		expect(evaluateRules(narrowFirst, "mcp__fs__read_file", null)).toBe("allow");
	});

	it("全局 * 只作回退，不参与通配键扫描", () => {
		// 若 "*" 被当成通配工具键，"*": "allow" 排在后面会把通配键的 ask 抹回 allow
		const globalLast: PermissionRules = { "mcp__*": "ask", "*": "allow" };
		expect(evaluateRules(globalLast, "mcp__s__t", null)).toBe("ask");
		const globalFirst: PermissionRules = { "*": "allow", "mcp__*": "ask" };
		expect(evaluateRules(globalFirst, "mcp__s__t", null)).toBe("ask");
	});
});

describe("suggestPattern：mcp 记忆键必须能被 patternMatchesToolCall 回匹配", () => {
	it("代理工具键粒度落在 <server>__<tool>", () => {
		const input = { server: "fs", tool: "read_file" };
		const key = suggestPattern("mcp", input);
		expect(key).toBe("mcp: fs__read_file");
		expect(patternMatchesToolCall(key, "mcp", matchTextFor("mcp", input))).toBe(true);
		expect(
			patternMatchesToolCall(key, "mcp", matchTextFor("mcp", { server: "fs", tool: "write_file" })),
		).toBe(false);
		// 键不跨入口：代理工具的记忆键不匹配直投工具调用
		expect(patternMatchesToolCall(key, "mcp__fs__read_file", "fs__read_file")).toBe(false);
	});

	it("未知 server 用 * 占位，键仍能回匹配具体 server 的同类调用", () => {
		const key = suggestPattern("mcp", { tool: "read_file" });
		expect(key).toBe("mcp: *__read_file");
		const concrete = matchTextFor("mcp", { server: "fs", tool: "read_file" });
		expect(patternMatchesToolCall(key, "mcp", concrete)).toBe(true);
		expect(
			patternMatchesToolCall(key, "mcp", matchTextFor("mcp", { server: "fs", tool: "write_file" })),
		).toBe(false);
	});

	it("直投工具键即工具名本身", () => {
		const key = suggestPattern("mcp__fs__read_file", {});
		expect(key).toBe("mcp__fs__read_file");
		expect(patternMatchesToolCall(key, "mcp__fs__read_file", matchTextFor("mcp__fs__read_file", {}))).toBe(
			true,
		);
		expect(patternMatchesToolCall(key, "mcp__fs__write_file", "fs__write_file")).toBe(false);
	});

	it("元数据入口的记忆键同样可回匹配（resource / prompt / search）", () => {
		const resource = { resource: "file:///a.txt" };
		const resourceKey = suggestPattern("mcp", resource);
		expect(resourceKey).toBe("mcp: resource:file:///a.txt");
		expect(patternMatchesToolCall(resourceKey, "mcp", matchTextFor("mcp", resource))).toBe(true);

		const prompt = { prompt: { name: "summarize" } };
		const promptKey = suggestPattern("mcp", prompt);
		expect(promptKey).toBe("mcp: prompt:summarize");
		expect(patternMatchesToolCall(promptKey, "mcp", matchTextFor("mcp", prompt))).toBe(true);

		const searchKey = suggestPattern("mcp", { search: "config" });
		expect(searchKey).toBe("mcp: search");
		expect(patternMatchesToolCall(searchKey, "mcp", matchTextFor("mcp", { search: "other" }))).toBe(true);
		expect(patternMatchesToolCall(searchKey, "mcp", matchTextFor("mcp", { describe: "fs" }))).toBe(false);
	});

	it("粒度不放大到整个 mcp 工具；无匹配文本时不匹配模式键", () => {
		expect(suggestPattern("mcp", { server: "fs", tool: "delete_file" })).not.toBe("mcp");
		expect(patternMatchesToolCall("mcp: fs__delete_file", "mcp", null)).toBe(false);
	});
});

describe("既有工具行为回归（通配键扫描不得改变无 * 键配置的语义）", () => {
	const rules = DEFAULT_PERMISSION_CONFIG.rules;

	it("bash 高危段照旧 ask，普通命令照旧 allow", () => {
		expect(evaluateRules(rules, "bash", "npm test")).toBe("allow");
		expect(evaluateRules(rules, "bash", "sudo apt install x")).toBe("ask");
		expect(evaluateRules(rules, "bash", "rm -rf /tmp/x")).toBe("ask");
		expect(evaluateRules(rules, "bash", "git push --force origin main")).toBe("ask");
		expect(evaluateRules(rules, "bash", "cd /x && rm -rf y")).toBe("ask");
	});

	it("read/edit/write 既有输入不变；越界写按 outside 策略 ask", () => {
		expect(evaluateRules(rules, "read", "/etc/passwd")).toBe("allow");
		expect(evaluateRules(rules, "edit", "/tmp/a.ts")).toBe("allow");
		expect(evaluateRules(rules, "write", "/tmp/a.ts")).toBe("allow");
		// 路径边界（越界 ask）由 extension/gate 的 outside 策略处理，此处只钉规则层可见的策略值
		expect(DEFAULT_PERMISSION_CONFIG.outside).toEqual({ read: "allow", write: "ask", temporary: "allow" });
	});

	it("无 * 键的配置走既有分支：全局兜底 + 精确键 + 模式表后命中覆盖", () => {
		const custom: PermissionRules = {
			"*": "ask",
			read: "allow",
			bash: { "*": "allow", "git push *": "deny" },
			my_tool: { "x *": "deny" },
		};
		expect(evaluateRules(custom, "read", "/etc/passwd")).toBe("allow");
		expect(evaluateRules(custom, "write", "/etc/passwd")).toBe("ask");
		expect(evaluateRules(custom, "bash", "git push origin main")).toBe("deny");
		expect(evaluateRules(custom, "bash", "ls")).toBe("allow");
		// matchText 为 null 时精确键的模式表不参与（既有语义，未被通配键扫描改变）
		expect(evaluateRules(custom, "my_tool", null)).toBe("ask");
		expect(evaluateRules(custom, "my_tool", "x 1")).toBe("deny");
	});
});

describe("默认配置与合并：mcp 规则", () => {
	it("默认规则含 mcp / mcpScript / mcp__*", () => {
		const rules = DEFAULT_PERMISSION_CONFIG.rules;
		expect(rules.mcp).toEqual({ "*": "ask", search: "allow", describe: "allow" });
		expect(rules.mcpScript).toBe("ask");
		expect(rules["mcp__*"]).toEqual({ "*": "ask" });
	});

	it("mergeWithDefaults：未写 mcp 规则的旧配置继承默认", () => {
		const merged = mergeWithDefaults({ rules: { read: "deny" } });
		expect(merged.rules.mcp).toEqual({ "*": "ask", search: "allow", describe: "allow" });
		expect(merged.rules.mcpScript).toBe("ask");
		expect(merged.rules["mcp__*"]).toEqual({ "*": "ask" });
		// 其它工具仍是「按工具粒度整体替换默认」
		expect(merged.rules.read).toBe("deny");
	});

	it("文件里只写 mcp 单工具规则 → 该键整体替换默认，其它键继承", () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ rules: { mcp: "allow" } }));
		const config = loadPermissionConfig(dir);
		expect(config.rules.mcp).toBe("allow");
		expect(evaluateRules(config.rules, "mcp", "fs__delete_file")).toBe("allow");
		// 用户没提到直投工具 → 仍吃默认 mcp__* = ask
		expect(evaluateRules(config.rules, "mcp__fs__delete_file", null)).toBe("ask");
	});

	it("文件里可整体覆盖通配工具键", () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ rules: { "mcp__*": "allow" } }));
		const config = loadPermissionConfig(dir);
		expect(evaluateRules(config.rules, "mcp__fs__write_file", null)).toBe("allow");
		expect(evaluateRules(config.rules, "mcp", "fs__write_file")).toBe("ask");
	});
});
