import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * dotenv 16 的 config() 不会自动读取 DOTENV_CONFIG_PATH（那是 dotenv CLI 的能力）。
 * 这里显式支持它，方便本地联调、多套凭证切换和自动化测试指向独立的 .env。
 */
const dotenvPath = process.env.DOTENV_CONFIG_PATH?.trim();
dotenv.config(dotenvPath ? { path: dotenvPath } : undefined);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const appConfig = {
  port: Number(process.env.PORT || 3000),
  larkCliBin: process.env.LARK_CLI_BIN || "lark-cli",
  larkCliTimeoutMs: Number(process.env.LARK_CLI_TIMEOUT_MS || 120000),
  defaultBaseToken: process.env.DEFAULT_BASE_TOKEN || "",
  defaultTableId: process.env.DEFAULT_TABLE_ID || "",
  logLevel: process.env.LOG_LEVEL || "info",
  logCliStdout: process.env.LOG_CLI_STDOUT !== "false",
  logCliStdoutMaxChars: Number(process.env.LOG_CLI_STDOUT_MAX_CHARS || 4000),
  logCliStderrMaxChars: Number(process.env.LOG_CLI_STDERR_MAX_CHARS || 4000),
  wechatApiTimeoutMs: Number(process.env.WECHAT_API_TIMEOUT_MS || 120000),
  /** 微信 API 基地址。仅用于本地联调/测试替身，生产保持默认值。 */
  wechatApiBase: (process.env.WECHAT_API_BASE || "https://api.weixin.qq.com").replace(/\/+$/, ""),
  githubApiTimeoutMs: Number(process.env.GITHUB_API_TIMEOUT_MS || 30000),
  githubContentToken: process.env.GITHUB_CONTENT_TOKEN || "",
  wechatAppId: process.env.WECHAT_APP_ID || "",
  wechatAppSecret: process.env.WECHAT_APP_SECRET || "",
  publisherWebhookToken: process.env.PUBLISHER_WEBHOOK_TOKEN || "",
  publisherStateFile: process.env.PUBLISHER_STATE_FILE || path.resolve(process.cwd(), ".data", "publisher-state.json"),
  publisherAllowedRepositories: process.env.PUBLISHER_ALLOWED_REPOSITORIES || "LyraWang6688/yaai-content-hub",
  publicDir: path.resolve(__dirname, "..", "public"),
  /**
   * MCP stdio 模式下 stdout 是 JSON-RPC 通道，任何日志写入 stdout 都会破坏协议握手。
   * 因此在 MCP 入口里把日志目标切到 stderr。
   */
  logToStderr: process.env.MCP_LOG_TARGET === "stderr",
  /**
   * 本地 stdio MCP 使用的微信公众号凭证。
   * 与飞书多维表格绑定（.data/integration-config.json）相互独立，互不影响。
   */
  wechatDefaultAuthor: process.env.WECHAT_DEFAULT_AUTHOR || "",
  /**
   * 微信 draft/add 官方限制
   * （https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html，
   *   旧版文档镜像表述一致）：
   * - title：总长度不超过 32 个字（必填）
   * - author：总长度不超过 16 个字
   * - digest：总长度不超过 120 个字
   * - content：不可超过 2kb，必须少于 2 万字符、小于 1M
   *
   * 超限时微信返回的错误信息很模糊，而且是在封面/正文图片都已经上传成素材之后才失败，
   * 会留下无法回收的孤儿素材，所以在本地提前拦截。
   *
   * 注意：2kb 是 draft/add 的文档约束。若实测你的账号接受更大的正文，
   * 可以用 WECHAT_CONTENT_MAX_BYTES 放开（字符数上限 2 万仍然生效）。
   */
  wechatTitleMaxChars: Number(process.env.WECHAT_TITLE_MAX_CHARS || 32),
  wechatAuthorMaxChars: Number(process.env.WECHAT_AUTHOR_MAX_CHARS || 16),
  wechatDigestMaxChars: Number(process.env.WECHAT_DIGEST_MAX_CHARS || 120),
  wechatContentMaxChars: Number(process.env.WECHAT_CONTENT_MAX_CHARS || 20000),
  wechatContentMaxBytes: Number(process.env.WECHAT_CONTENT_MAX_BYTES || 2 * 1024)
};

export function hasEnvWechatCredentials() {
  return Boolean(appConfig.wechatAppId.trim() && appConfig.wechatAppSecret.trim());
}

export function getEnvWechatCredentials() {
  return {
    appId: appConfig.wechatAppId.trim(),
    appSecret: appConfig.wechatAppSecret.trim()
  };
}
