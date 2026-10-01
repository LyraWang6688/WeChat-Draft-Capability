/**
 * 微信公众号草稿 MCP（stdio）。
 *
 * 设计目标：让 AI 工具生成的 HTML 排版文件通过一次工具调用进入公众号草稿箱，
 * 且正文不经过模型上下文——工具入参只有一个文件路径，token 消耗与文章长度无关。
 *
 * stdio 传输下 stdout 是 JSON-RPC 通道，日志必须全部走 stderr。
 * 注意：不要在本文件里靠 `process.env.MCP_LOG_TARGET = ...` 来保证这一点——
 * ESM 会先求值所有 import，那样的赋值一定晚于 logger 初始化。
 * 真正保证顺序的是入口引导层 src/mcp/main.ts。
 * logger 本身也改为在每次写入时读取该变量，双重保险。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appConfig, getEnvWechatCredentials, hasEnvWechatCredentials } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import { ArticlePublishService, type ImageStrategy } from "../services/articlePublish.service.js";
import { IntegrationConfigService } from "../services/integrationConfig.service.js";
import { WechatService } from "../services/wechat.service.js";
import { logger } from "../utils/logger.js";
import type { WechatCredentials } from "../services/integrationConfig.service.js";

const wechat = new WechatService();
const articlePublish = new ArticlePublishService(wechat);
const integrationConfig = new IntegrationConfigService();

const server = new McpServer({
  name: "wechat-draft",
  version: "0.1.0"
});

const IMAGE_STRATEGY_VALUES = ["leave", "upload-local", "upload-all"] as const;

const uploadInputSchema = {
  path: z
    .string()
    .min(1)
    .describe(
      "HTML 排版文件路径，或包含 article.html 的文章目录。正文从磁盘读取，不要把 HTML 内容放进参数里。"
    ),
  title: z.string().optional().describe("覆盖文章标题；不传则按 meta.json > <h1> > <title> 顺序自动提取"),
  author: z.string().optional().describe("覆盖作者；不传则按 meta.json > meta[author] > WECHAT_DEFAULT_AUTHOR 提取"),
  digest: z.string().optional().describe("覆盖摘要；不传则自动截取正文前 120 字"),
  column: z.string().optional().describe("栏目名；微信草稿接口无对应字段，仅回显与记录用途"),
  coverImagePath: z
    .string()
    .optional()
    .describe("封面图路径（本地文件或 http(s) 链接）；不传则在文章目录自动查找 cover/封面/thumb 命名的图片"),
  imageStrategy: z
    .enum(IMAGE_STRATEGY_VALUES)
    .optional()
    .describe("正文图片处理策略：upload-local（默认，上传本地图片并替换链接）/ leave / upload-all（含外链图片）"),
  needOpenComment: z.boolean().optional().describe("是否开启留言，默认 0（不开启）"),
  onlyFansCanComment: z.boolean().optional().describe("是否仅粉丝可留言，默认 0")
};

server.registerTool(
  "upload_wechat_draft",
  {
    title: "上传微信公众号草稿",
    description: [
      "读取磁盘上的微信公众号 HTML 排版文件，上传封面与正文图片到微信永久素材库，并在公众号后台创建一篇草稿。",
      "工具只接收文件路径，正文不进入模型上下文，因此 token 消耗与文章长度无关。",
      "返回 draftMediaId（草稿 ID）与上传统计。"
    ].join(""),
    inputSchema: uploadInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (args) => {
    try {
      const credentials = await resolveCredentials();
      const result = await articlePublish.publishArticle({
        path: args.path,
        title: args.title,
        author: args.author,
        digest: args.digest,
        column: args.column,
        coverImagePath: args.coverImagePath,
        imageStrategy: args.imageStrategy as ImageStrategy | undefined,
        needOpenComment: args.needOpenComment,
        onlyFansCanComment: args.onlyFansCanComment,
        credentials
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                message: `已创建微信公众号草稿：${result.title}`,
                draftMediaId: result.draftMediaId,
                coverMediaId: result.coverMediaId,
                title: result.title,
                author: result.author,
                digest: result.digest,
                column: result.column,
                htmlPath: result.source.htmlPath,
                metaSources: result.source.metaSources,
                contentBytes: result.content.htmlBytes,
                cover: {
                  mediaId: result.cover.mediaId,
                  source: result.cover.source
                },
                images: {
                  uploaded: result.images.inline.uploaded.length,
                  leftAsIs: result.images.inline.leftAsIs.length,
                  skipped: result.images.inline.skipped,
                  // 用紧凑形式说明图片走的是哪条通道，避免把每个 URL 都回灌进上下文
                  channels: summarizeImageChannels(result.images.inline.uploaded)
                },
                warnings: result.warnings
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return toToolError("upload_wechat_draft_failed", error);
    }
  }
);

server.registerTool(
  "inspect_wechat_article",
  {
    title: "预检公众号排版文件",
    description:
      "不调用微信接口，只解析 HTML 排版文件：返回自动识别的标题/作者/摘要、封面候选、正文图片清单与体积、以及阻塞问题。上传前想确认解析结果时用它。",
    inputSchema: {
      path: uploadInputSchema.path,
      title: uploadInputSchema.title,
      author: uploadInputSchema.author,
      digest: uploadInputSchema.digest,
      column: uploadInputSchema.column,
      coverImagePath: uploadInputSchema.coverImagePath
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (args) => {
    try {
      const result = await articlePublish.inspectArticle({
        path: args.path,
        title: args.title,
        author: args.author,
        digest: args.digest,
        column: args.column,
        coverImagePath: args.coverImagePath
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                ready: result.blockingIssues.length === 0,
                htmlPath: result.source.htmlPath,
                articleDir: result.source.articleDir,
                metaFilePath: result.source.metaFilePath,
                metaSources: result.source.metaSources,
                meta: {
                  title: result.meta.title,
                  author: result.meta.author,
                  digest: result.meta.digest,
                  column: result.meta.column
                },
                content: result.content,
                cover: result.images.cover,
                inlineImages: result.images.inline,
                blockingIssues: result.blockingIssues,
                warnings: result.warnings
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return toToolError("inspect_wechat_article_failed", error);
    }
  }
);

server.registerTool(
  "wechat_draft_status",
  {
    title: "检查微信凭证",
    description:
      "检查当前 MCP 是否能拿到微信公众号 AppID/AppSecret，并实际请求一次 access_token 验证凭证有效。不会返回密钥本身。",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async () => {
    const hasEnv = hasEnvWechatCredentials();
    const bindingCount = await countBindings();
    const apiBase = appConfig.wechatApiBase;
    const isNonProductionApiBase = apiBase !== "https://api.weixin.qq.com";

    if (!hasEnv && bindingCount === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: false,
                credentialsSource: "none",
                message:
                  "未找到微信公众号凭证。请在项目根目录 .env 中配置 WECHAT_APP_ID / WECHAT_APP_SECRET，或在 MCP 客户端配置的 env 中传入。",
                envFileHint: `${process.cwd()}/.env`,
                integrationBindingCount: bindingCount
              },
              null,
              2
            )
          }
        ]
      };
    }

    try {
      const credentials = await resolveCredentials();
      await verifyCredentials(credentials);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                credentialsSource: hasEnv ? "env(.env / MCP client env)" : "integration-config(.data)",
                appIdMasked: maskAppId(credentials.appId),
                accessTokenValid: true,
                // 暴露实际请求的 API 基地址：若 .env 残留了联调用的 WECHAT_API_BASE，
                // 「凭证有效」可能只是测试替身的假阳性，必须让调用方看得见。
                apiBase,
                apiBaseIsProduction: !isNonProductionApiBase,
                ...(isNonProductionApiBase
                  ? {
                      warning:
                        "当前并非请求微信正式接口，而是自定义 WECHAT_API_BASE（多半是本地测试替身）。此处的「凭证有效」不代表真实公众号可用。"
                    }
                  : {}),
                imageStrategyDefault: process.env.MCP_IMAGE_STRATEGY || "upload-local",
                allowedRoots: (process.env.MCP_ALLOWED_ROOTS || "")
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return toToolError("wechat_draft_status_failed", error);
    }
  }
);

async function resolveCredentials(): Promise<WechatCredentials> {
  if (hasEnvWechatCredentials()) {
    return getEnvWechatCredentials();
  }

  // 兜底：复用飞书多维表格已绑定的微信凭证（.data/integration-config.json）
  const registrations = await listBindings();
  for (const binding of registrations) {
    try {
      return await integrationConfig.getWechatCredentials(binding.baseToken, binding.tableId);
    } catch {
      continue;
    }
  }

  throw new HttpError(
    400,
    "未配置微信公众号凭证：请在 .env 设置 WECHAT_APP_ID / WECHAT_APP_SECRET，或在 MCP 客户端 env 中传入",
    "MISSING_WECHAT_CREDENTIALS",
    {
      envFile: `${process.cwd()}/.env`
    }
  );
}

async function listBindings() {
  return integrationConfig.listWechatBindings();
}

async function countBindings() {
  try {
    const bindings = await listBindings();
    return bindings.length;
  } catch {
    return 0;
  }
}

async function verifyCredentials(credentials: WechatCredentials) {
  const response = await fetch(
    `${appConfig.wechatApiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
      credentials.appId
    )}&secret=${encodeURIComponent(credentials.appSecret)}`,
    {
      signal: AbortSignal.timeout(appConfig.wechatApiTimeoutMs)
    }
  );
  const payload = (await response.json()) as { access_token?: string; errcode?: number; errmsg?: string };
  if (!response.ok || payload.errcode) {
    throw new HttpError(
      502,
      `微信凭证校验失败：${payload.errmsg || `HTTP ${response.status}`}`,
      "WECHAT_CREDENTIAL_VERIFY_FAILED",
      {
        errcode: payload.errcode,
        errmsg: payload.errmsg
      }
    );
  }
  if (!payload.access_token) {
    throw new HttpError(502, "微信凭证校验返回异常：未拿到 access_token", "WECHAT_CREDENTIAL_VERIFY_INVALID");
  }
}

/** 只统计各上传通道的数量，不回显每个 URL，保持返回值紧凑。 */
function summarizeImageChannels(
  uploaded: Array<{ via?: "uploadimg" | "material"; note?: string }>
) {
  const summary: Record<string, number> = {};
  for (const item of uploaded) {
    const key = item.via || "material";
    summary[key] = (summary[key] || 0) + 1;
  }
  const notes = uploaded
    .map((item) => item.note)
    .filter((note): note is string => Boolean(note));
  return {
    ...summary,
    ...(notes.length > 0 ? { fallbackNotes: Array.from(new Set(notes)) } : {})
  };
}

function maskAppId(appId: string) {
  if (appId.length <= 8) {
    return `${appId.slice(0, 2)}****`;
  }
  return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

function toToolError(event: string, error: unknown) {
  const isHttpError = error instanceof HttpError;
  const message = error instanceof Error ? error.message : String(error);
  const code = isHttpError ? error.code : "MCP_TOOL_ERROR";
  const details = isHttpError ? error.details : undefined;

  logger.error(event, {
    code,
    message,
    details
  });

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code,
              message,
              details
            }
          },
          null,
          2
        )
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp_wechat_draft_server_started", {
    cwd: process.cwd(),
    hasEnvCredentials: hasEnvWechatCredentials(),
    imageStrategy: process.env.MCP_IMAGE_STRATEGY || "upload-local"
  });
}

main().catch((error) => {
  logger.error("mcp_wechat_draft_server_fatal", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});
