import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

export type GithubArticleMeta = {
  schema_version?: number;
  article_id?: string;
  title?: string;
  author?: string;
  digest?: string;
  column?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

export type GithubArticleAssets = {
  schema_version?: number;
  cover?: {
    path?: string;
    required?: boolean;
  };
  body_images?: unknown[];
};

export type GithubArticle = {
  repository: string;
  articleId: string;
  ref: string;
  sourceCommit: string;
  meta: GithubArticleMeta;
  contentHtml: string;
  assets: GithubArticleAssets;
  cover: {
    fileName: string;
    buffer: Buffer;
  };
};

type GithubContentsEntry = {
  type?: string;
  name?: string;
  path?: string;
  size?: number;
  sha?: string;
  content?: string | null;
  encoding?: string;
  git_url?: string;
  download_url?: string;
  message?: string;
};

const ARTICLE_ID_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}-/;

/**
 * Single-Repo Content Workspace Adapter。
 *
 * 职责：按冻结的 Single-Repo Content Contract 从 canonical 仓库读取
 *   content/articles/{year}/{article_id}/ 下的 meta.json / content.html / assets.json / cover。
 *
 * 只做读取，不知道微信 API 的实现；token 只用于 Authorization 头，绝不写入日志或返回体。
 */
export class GithubContentService {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 30000
  ) {}

  async fetchArticle(input: {
    repository: string;
    articleId: string;
    sourceCommit: string;
    traceId?: string;
  }): Promise<GithubArticle> {
    const { repository, articleId, sourceCommit, traceId } = input;
    const { owner, repo } = parseRepository(repository);
    const articleDir = resolveArticleDir(articleId);
    const basePath = `content/articles/${articleDir}/${articleId}`;

    logger.info("publisher_draft_github_fetch_start", {
      traceId,
      repository,
      articleId,
      articleDir,
      currentStep: "github_fetch",
      result: "pending"
    });

    const metaRaw = await this.getFile({
      owner,
      repo,
      path: `${basePath}/meta.json`,
      sourceCommit,
      label: "meta.json"
    });
    const contentHtml = (await this.getFile({
      owner,
      repo,
      path: `${basePath}/content.html`,
      sourceCommit,
      label: "content.html"
    })).toString("utf8");
    const assetsRaw = await this.getFile({
      owner,
      repo,
      path: `${basePath}/assets.json`,
      sourceCommit,
      label: "assets.json"
    });

    let meta: GithubArticleMeta;
    let assets: GithubArticleAssets;
    try {
      meta = JSON.parse(metaRaw.toString("utf8")) as GithubArticleMeta;
    } catch (error) {
      logger.warn("publisher_draft_github_meta_invalid", {
        traceId,
        articleId,
        currentStep: "validate",
        result: "failed"
      });
      throw new HttpError(422, "meta.json 不是合法 JSON", "ARTICLE_SCHEMA_INVALID", undefined, false);
    }
    try {
      assets = JSON.parse(assetsRaw.toString("utf8")) as GithubArticleAssets;
    } catch (error) {
      logger.warn("publisher_draft_github_assets_invalid", {
        traceId,
        articleId,
        currentStep: "validate",
        result: "failed"
      });
      throw new HttpError(422, "assets.json 不是合法 JSON", "ARTICLE_SCHEMA_INVALID", undefined, false);
    }

    const coverPath = assets?.cover?.path?.trim();
    if (!coverPath) {
      logger.warn("publisher_draft_github_cover_missing", {
        traceId,
        articleId,
        currentStep: "validate",
        result: "failed"
      });
      throw new HttpError(422, "assets.json 缺少 cover.path", "COVER_MISSING", undefined, false);
    }
    if (coverPath.includes("..") || coverPath.startsWith("/")) {
      throw new HttpError(422, "cover.path 不合法", "COVER_MISSING", undefined, false);
    }

    const coverBuffer = await this.getFile({
      owner,
      repo,
      path: `${basePath}/${coverPath}`,
      sourceCommit,
      label: `cover (${coverPath})`,
      notFound: { code: "COVER_MISSING", message: `封面文件不存在：${coverPath}`, retryable: false }
    });

    logger.info("publisher_draft_github_fetch_success", {
      traceId,
      repository,
      articleId,
      currentStep: "github_fetch",
      result: "success"
    });

    return {
      repository,
      articleId,
      ref: sourceCommit,
      sourceCommit,
      meta,
      contentHtml,
      assets,
      cover: {
        fileName: coverPath.split("/").pop() || "cover",
        buffer: coverBuffer
      }
    };
  }

  private async getFile(input: {
    owner: string;
    repo: string;
    path: string;
    sourceCommit: string;
    label: string;
    notFound?: { code: string; message: string; retryable: boolean };
  }): Promise<Buffer> {
    if (!this.token) {
      throw new HttpError(500, "服务器未配置 GITHUB_CONTENT_TOKEN", "PUBLISHER_NOT_CONFIGURED", undefined, false);
    }

    const url = `https://api.github.com/repos/${input.owner}/${input.repo}/contents/${encodePath(input.path)}?ref=${encodeURIComponent(input.sourceCommit)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wechat-draft-capability"
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (isHttpError(error)) {
        throw error;
      }
      throw new HttpError(502, "GitHub 网络请求失败", "GITHUB_NETWORK_ERROR", undefined, true);
    }

    if (response.status === 404) {
      if (input.notFound) {
        throw new HttpError(422, input.notFound.message, input.notFound.code, undefined, input.notFound.retryable);
      }
      throw new HttpError(404, `GitHub 上未找到 ${input.label}`, "ARTICLE_NOT_FOUND", undefined, true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "GitHub 鉴权失败，请检查 GITHUB_CONTENT_TOKEN", "GITHUB_AUTH_FAILED", undefined, false);
    }
    if (!response.ok) {
      throw new HttpError(502, `GitHub API 错误（HTTP ${response.status}）`, "GITHUB_UPSTREAM_ERROR", undefined, true);
    }

    let entry: GithubContentsEntry;
    try {
      entry = (await response.json()) as GithubContentsEntry;
    } catch (error) {
      throw new HttpError(502, "GitHub 响应不是合法 JSON", "GITHUB_UPSTREAM_ERROR", undefined, true);
    }

    if (entry.content && entry.encoding === "base64") {
      return Buffer.from(entry.content, "base64");
    }

    // 大文件（>1MB）时 contents API 不返回 content，需走 git blobs raw 下载
    if (entry.git_url) {
      try {
        const raw = await fetch(entry.git_url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github.raw",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "wechat-draft-capability"
          },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!raw.ok) {
          throw new HttpError(502, `GitHub 大文件下载失败（HTTP ${raw.status}）`, "GITHUB_UPSTREAM_ERROR", undefined, true);
        }
        const bytes = await raw.arrayBuffer();
        return Buffer.from(bytes);
      } catch (error) {
        if (isHttpError(error)) {
          throw error;
        }
        throw new HttpError(502, "GitHub 网络请求失败", "GITHUB_NETWORK_ERROR", undefined, true);
      }
    }

    throw new HttpError(502, "GitHub 文件内容不可读", "GITHUB_UPSTREAM_ERROR", undefined, true);
  }
}

export function parseRepository(repository: string) {
  const parts = repository.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new HttpError(400, "repository 必须为 owner/repo 格式", "INVALID_REQUEST", undefined, false);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function resolveArticleDir(articleId: string) {
  if (!ARTICLE_ID_PREFIX_PATTERN.test(articleId)) {
    throw new HttpError(400, "article_id 必须符合 yyyy-MM-dd-xxx 格式", "INVALID_ARTICLE_ID", undefined, false);
  }
  return articleId.slice(0, 4);
}

function encodePath(filePath: string) {
  return filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
