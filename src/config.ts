import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export const appConfig = {
  port: Number(process.env.PORT || 3000),
  logLevel: process.env.LOG_LEVEL || "info",
  wechatApiTimeoutMs: Number(process.env.WECHAT_API_TIMEOUT_MS || 120000),
  githubApiTimeoutMs: Number(process.env.GITHUB_API_TIMEOUT_MS || 30000),
  githubContentToken: process.env.GITHUB_CONTENT_TOKEN || "",
  wechatAppId: process.env.WECHAT_APP_ID || "",
  wechatAppSecret: process.env.WECHAT_APP_SECRET || "",
  publisherWebhookToken: process.env.PUBLISHER_WEBHOOK_TOKEN || "",
  publisherStateFile:
    process.env.PUBLISHER_STATE_FILE || path.resolve(process.cwd(), ".data", "publisher-state.json"),
  publisherAllowedRepositories:
    process.env.PUBLISHER_ALLOWED_REPOSITORIES || "LyraWang6688/wechat-draft-capability"
};
