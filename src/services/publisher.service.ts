import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import type { WechatCredentials } from "./integrationConfig.service.js";
import { logger } from "../utils/logger.js";
import {
  GithubContentService,
  parseRepository,
  resolveArticleDir,
  type GithubArticle
} from "./githubContent.service.js";
import type { PublisherStateStore } from "./publisherStorage.service.js";
import { WechatService } from "./wechat.service.js";

export type PublisherDraftRequest = {
  repository: string;
  article_id: string;
  ref: string;
  source_commit: string;
};

export type PublisherDraftResult = {
  article_id: string;
  status: "uploaded_to_wechat";
  source_commit: string;
  wechat_draft_media_id: string;
  uploaded_at: string;
  idempotent_replay: boolean;
};

/** 微信侧依赖边界：真实 WechatService 天然满足该结构，测试可注入替身。 */
export type WechatDraftClient = Pick<WechatService, "uploadPermanentImage" | "addDraftArticle">;

type FailureInfo = {
  statusCode: number;
  code: string;
  message: string;
  retryable: boolean;
};

const READY_TO_UPLOAD = "ready_to_upload";
const VALIDATION_STATUS_CODE = 422;

/**
 * Publisher Domain 编排服务（GitHub Content Hub -> 微信公众号草稿箱）。
 *
 * 职责：输入校验 -> 幂等检查 -> GitHub 拉取 -> 内容校验 -> 封面素材上传 -> 创建草稿 -> 状态持久化。
 * 状态持久化由独立 PublisherStateStore 边界负责，本服务只依赖接口，不关心存储实现。
 * 观察性日志只记录 traceId / article_id / source_commit / current_step / result / error_code，
 * 绝不记录 WECHAT_APP_SECRET、access_token、GITHUB_CONTENT_TOKEN、PUBLISHER_WEBHOOK_TOKEN。
 */
export class PublisherDraftService {
  constructor(
    private readonly github: GithubContentService,
    private readonly wechat: WechatDraftClient,
    private readonly store: PublisherStateStore
  ) {}

  async createDraft(input: PublisherDraftRequest, traceId?: string): Promise<PublisherDraftResult> {
    validateRequest(input);
    const credentials = serverWechatCredentials();

    this.log(input, "validate", "start", undefined, traceId, {
      repository: input.repository,
      ref: input.ref
    });

    // 幂等：article_id + source_commit
    const existing = await this.store.find(input.article_id, input.source_commit);
    if (existing) {
      if (existing.status === "uploaded_to_wechat" && existing.wechat_draft_media_id) {
        this.log(input, "idempotency", "replay", undefined, traceId, {
          mediaId: existing.wechat_draft_media_id
        });
        return {
          article_id: existing.article_id,
          status: "uploaded_to_wechat",
          source_commit: existing.source_commit,
          wechat_draft_media_id: existing.wechat_draft_media_id,
          uploaded_at: existing.uploaded_at,
          idempotent_replay: true
        };
      }
      if (existing.status === "failed" && existing.retryable === false) {
        this.log(input, "idempotency", "replay_failure", existing.error_code, traceId, {});
        throw new HttpError(
          existing.status_code ?? VALIDATION_STATUS_CODE,
          existing.error_message ?? "该版本此前上传失败",
          existing.error_code,
          undefined,
          false
        );
      }
      // retryable 的失败：允许重试，继续走完整流程
    }

    let article: GithubArticle;
    try {
      article = await this.github.fetchArticle({
        repository: input.repository,
        articleId: input.article_id,
        sourceCommit: input.source_commit,
        traceId
      });
    } catch (error) {
      throw await this.fail(input, error, "github_fetch", traceId);
    }

    try {
      validateArticle(article, input);
    } catch (error) {
      throw await this.fail(input, error, "validate", traceId);
    }

    let tempDir: string | undefined;
    try {
      await mkdir(path.join(process.cwd(), ".data"), { recursive: true });
      tempDir = await mkdtemp(path.join(process.cwd(), ".data", "publisher-cover-"));
      const coverPath = path.join(tempDir, sanitizeFileName(article.cover.fileName));
      await writeFile(coverPath, article.cover.buffer);

      this.log(input, "wechat_upload", "start", undefined, traceId, {});
      const material = await this.wechat.uploadPermanentImage({
        credentials,
        filePath: coverPath,
        fileName: article.cover.fileName
      });
      const draft = await this.wechat.addDraftArticle({
        title: article.meta.title || "",
        author: article.meta.author,
        digest: article.meta.digest,
        content: article.contentHtml,
        thumbMediaId: material.mediaId,
        credentials
      });

      const uploadedAt = new Date().toISOString();
      await this.store.save({
        article_id: article.articleId,
        source_commit: article.sourceCommit,
        status: "uploaded_to_wechat",
        wechat_draft_media_id: draft.mediaId,
        uploaded_at: uploadedAt
      });

      this.log(input, "wechat_upload", "success", undefined, traceId, {
        mediaId: draft.mediaId
      });
      return {
        article_id: article.articleId,
        status: "uploaded_to_wechat",
        source_commit: article.sourceCommit,
        wechat_draft_media_id: draft.mediaId,
        uploaded_at: uploadedAt,
        idempotent_replay: false
      };
    } catch (error) {
      throw await this.fail(input, error, "wechat_upload", traceId);
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    throw new HttpError(500, "内部错误", "INTERNAL_ERROR", undefined, false);
  }

  private async fail(
    input: PublisherDraftRequest,
    error: unknown,
    currentStep: string,
    traceId?: string
  ): Promise<HttpError> {
    const failure = classifyFailure(error);
    this.log(input, currentStep, "failed", failure.code, traceId, {
      message: error instanceof Error ? error.message : String(error)
    });

    try {
      await this.store.save({
        article_id: input.article_id,
        source_commit: input.source_commit,
        status: "failed",
        error_code: failure.code,
        error_message: failure.message,
        retryable: failure.retryable,
        status_code: failure.statusCode,
        uploaded_at: new Date().toISOString()
      });
    } catch (saveError) {
      logger.error("publisher_state_save_failed", {
        traceId,
        article_id: input.article_id,
        source_commit: input.source_commit,
        message: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }

    return new HttpError(failure.statusCode, failure.message, failure.code, undefined, failure.retryable);
  }

  private log(
    input: PublisherDraftRequest,
    currentStep: string,
    result: string,
    errorCode: string | undefined,
    traceId: string | undefined,
    extra: Record<string, unknown> = {}
  ) {
    logger.info("publisher_draft_step", {
      trace_id: traceId,
      article_id: input.article_id,
      source_commit: input.source_commit,
      current_step: currentStep,
      result,
      error_code: errorCode,
      ...extra
    });
  }
}

function validateRequest(input: PublisherDraftRequest) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "请求体必须是 JSON 对象", "INVALID_REQUEST", undefined, false);
  }
  if (typeof input.repository !== "string" || !input.repository.trim()) {
    throw new HttpError(400, "缺少 repository", "INVALID_REQUEST", undefined, false);
  }
  parseRepository(input.repository.trim());
  if (typeof input.article_id !== "string" || !input.article_id.trim()) {
    throw new HttpError(400, "缺少 article_id", "INVALID_REQUEST", undefined, false);
  }
  resolveArticleDir(input.article_id.trim());
  if (typeof input.ref !== "string" || !input.ref.trim()) {
    throw new HttpError(400, "缺少 ref", "INVALID_REQUEST", undefined, false);
  }
  if (typeof input.source_commit !== "string" || !input.source_commit.trim()) {
    throw new HttpError(400, "缺少 source_commit", "INVALID_REQUEST", undefined, false);
  }
}

function validateArticle(article: GithubArticle, input: PublisherDraftRequest) {
  if (!article.meta || article.meta.schema_version !== 1) {
    throw new HttpError(VALIDATION_STATUS_CODE, "meta.schema_version 必须是 1", "ARTICLE_SCHEMA_INVALID", undefined, false);
  }
  if (article.meta.article_id !== input.article_id) {
    throw new HttpError(VALIDATION_STATUS_CODE, "meta.article_id 与请求中的 article_id 不一致", "ARTICLE_ID_MISMATCH", undefined, false);
  }
  if (article.meta.status !== READY_TO_UPLOAD) {
    throw new HttpError(
      VALIDATION_STATUS_CODE,
      `meta.status 必须是 ${READY_TO_UPLOAD}（当前：${article.meta.status || "未设置"}）`,
      "ARTICLE_NOT_READY",
      undefined,
      false
    );
  }
  if (!article.meta.title || !article.meta.title.trim()) {
    throw new HttpError(VALIDATION_STATUS_CODE, "缺少 meta.title", "TITLE_MISSING", undefined, false);
  }
  if (!article.contentHtml || !article.contentHtml.trim()) {
    throw new HttpError(VALIDATION_STATUS_CODE, "缺少 content.html 内容", "CONTENT_MISSING", undefined, false);
  }
  if (!article.assets?.cover?.path) {
    throw new HttpError(VALIDATION_STATUS_CODE, "缺少 assets.json 中的 cover 配置", "COVER_MISSING", undefined, false);
  }
  if (!article.cover || article.cover.buffer.length === 0) {
    throw new HttpError(VALIDATION_STATUS_CODE, "封面文件为空或不可读", "COVER_MISSING", undefined, false);
  }
}

function serverWechatCredentials(): WechatCredentials {
  const appId = appConfig.wechatAppId.trim();
  const appSecret = appConfig.wechatAppSecret.trim();
  if (!appId || !appSecret) {
    throw new HttpError(500, "服务器未配置 WECHAT_APP_ID / WECHAT_APP_SECRET", "PUBLISHER_NOT_CONFIGURED", undefined, false);
  }
  return { appId, appSecret };
}

function classifyFailure(error: unknown): FailureInfo {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code || "INTERNAL_ERROR",
      message: error.message,
      retryable: error.retryable ?? error.statusCode >= 500
    };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "内部错误",
    retryable: false
  };
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "cover-image";
}
