/**
 * MCP stdio 入口引导层。
 *
 * 存在的唯一理由：ESM 会在模块体执行前先求值所有 import。因此
 * wechatDraftServer.ts 里无论把 `process.env.MCP_LOG_TARGET = "stderr"`
 * 写在多靠前的位置，都晚于 config.ts / logger.ts 的初始化。
 *
 * 这里用「先设置环境变量，再动态 import 真正的服务器」的方式保证顺序正确，
 * 也就是在任何业务模块被求值之前，stdio 约束就已经生效。
 */
process.env.MCP_LOG_TARGET = "stderr";

await import("./wechatDraftServer.js");
