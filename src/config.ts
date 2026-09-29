import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

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
  githubApiTimeoutMs: Number(process.env.GITHUB_API_TIMEOUT_MS || 30000),
  githubContentToken: process.env.GITHUB_CONTENT_TOKEN || "",
  wechatAppId: process.env.WECHAT_APP_ID || "",
  wechatAppSecret: process.env.WECHAT_APP_SECRET || "",
  publisherWebhookToken: process.env.PUBLISHER_WEBHOOK_TOKEN || "",
  publisherStateFile: process.env.PUBLISHER_STATE_FILE || path.resolve(process.cwd(), ".data", "publisher-state.json"),
  publisherAllowedRepositories: process.env.PUBLISHER_ALLOWED_REPOSITORIES || "LyraWang6688/yaai-content-hub",
  publicDir: path.resolve(__dirname, "..", "public")
};
