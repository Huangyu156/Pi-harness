/**
 * 传输工厂：按配置的 kind 分派到三个绑定实现。
 *
 * client / registry 只从这里取传输，不直接 import 具体绑定——加上 `registry.ts` 允许注入
 * `transportFactory`，测试与非默认绑定都不需要改动上层。
 *
 * re-export `McpTransportOptions` 是为了让上层只依赖 `./transports` 一个入口（config.ts 产出它、
 * client 消费它，两边都只 import 这里）。
 */

import type { McpTransport, McpTransportOptions } from "../transport";
import { createHttpSseTransport } from "./http-sse";
import { createStdioTransport } from "./stdio";
import { createStreamableHttpTransport } from "./streamable-http";

export type { McpTransportOptions } from "../transport";

/** 按 kind 建传输；参数在 config.ts 里已完成 `${env:}` 与 `~` 展开，这里只做分派 */
export function createTransport(options: McpTransportOptions): McpTransport {
	switch (options.kind) {
		case "stdio":
			return createStdioTransport(options);
		case "streamable-http":
			return createStreamableHttpTransport(options);
		case "http-sse":
			return createHttpSseTransport(options);
	}
}
