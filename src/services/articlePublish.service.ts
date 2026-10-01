import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";
import {
  clampDigest,
  classifySrc,
  describeContentSize,
  extractContentHtml,
  hashFileContent,
  loadArticleHtmlDocument,
  markUploadableImages,
  replaceImageSrc,
  resolveArticleInput,
  resolveInsideAllowedRoots,
  type ArticleHtmlDocument,
  type ArticleMeta,
  type InlineImage
} from "./articleHtml.service.js";
import type { WechatCredentials } from "./integrationConfig.service.js";
import { WechatService } from "./wechat.service.js";

export type ImageStrategy = "leave" | "upload-local" | "upload-all";

export type PublishArticleInput = {
  /** HTML 文件路径，或包含 HTML 的文章目录 */
  path: string;
  title?: string;
  author?: string;
  digest?: string;
  /** 封面图路径（本地文件或 http(s) URL），不传则自动发现 */
  coverImagePath?: string;
  /** meta.json 中声明的栏目，微信草稿接口无对应字段，仅回显 */
  column?: string;
  imageStrategy?: ImageStrategy;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  credentials: WechatCredentials;
};

export type PublishArticleResult = {
  ok: true;
  draftMediaId: string;
  coverMediaId: string;
  title: string;
  author?: string;
  digest?: string;
  column?: string;
  source: {
    htmlPath: string;
    articleDir: string;
    metaFilePath?: string;
    metaSources: Record<string, string>;
  };
  content: {
    htmlBytes: number;
    htmlLimitBytes: number;
    inlineImageCount: number;
  };
  images: {
    /** 正文图片（不含封面）的上传与替换结果 */
    inline: {
      uploaded: Array<{
        src: string;
        url?: string;
        mediaId: string;
        /** uploadimg = 官方正文图片接口（不占素材库配额）；material = 回退永久素材 */
        via?: "uploadimg" | "material";
        note?: string;
      }>;
      leftAsIs: string[];
      skipped: Array<{ src: string; reason: string }>;
    };
  };
  cover: {
    mediaId: string;
    /** 封面来源路径（本地）或 URL（远程） */
    source: string;
  };
  warnings: string[];
};

export type InspectArticleResult = {
  ok: true;
  source: PublishArticleResult["source"];
  meta: ArticleMeta;
  content: PublishArticleResult["content"];
  images: {
    inline: Array<{ index: number; src: string; kind: InlineImage["kind"]; resolvedPath?: string; exists?: boolean }>;
    cover?: string;
    coverSource: string;
  };
  warnings: string[];
  blockingIssues: string[];
};

/**
 * 从磁盘上的 HTML 排版文件生成一篇微信公众号草稿。
 *
 * 关键约束：正文与图片都从磁盘读取，不经过模型上下文；
 * 工具调用只需传一个路径，因此 token 消耗与文章长度无关。
 */
export class ArticlePublishService {
  constructor(private readonly wechat: WechatService) {}

  async inspectArticle(input: {
    path: string;
    title?: string;
    author?: string;
    digest?: string;
    coverImagePath?: string;
    column?: string;
  }): Promise<InspectArticleResult> {
    const document = await this.loadDocument(input);
    const inlineImages = await markUploadableImages(document.inlineImages);
    const contentSize = describeContentSize(document.contentHtml);
    const blockingIssues = collectBlockingIssues(document, contentSize);

    return {
      ok: true,
      source: describeSource(document),
      meta: document.meta,
      content: {
        htmlBytes: contentSize.bytes,
        htmlLimitBytes: contentSize.limitBytes,
        inlineImageCount: inlineImages.length
      },
      images: {
        inline: inlineImages.map((image) => ({
          index: image.index,
          src: image.src,
          kind: image.kind,
          resolvedPath: image.absolutePath,
          exists: image.kind === "local" ? Boolean(image.uploadablePath) : undefined
        })),
        cover: document.coverCandidate,
        coverSource: document.coverCandidate ? "auto-detected-or-hint" : "not-found"
      },      warnings: document.warnings,
      blockingIssues
    };
  }

  async publishArticle(input: PublishArticleInput): Promise<PublishArticleResult> {
    const strategy: ImageStrategy = input.imageStrategy || "upload-local";
    const document = await this.loadDocument(input);
    const contentSize = describeContentSize(document.contentHtml);
    const warnings = [...document.warnings];
    const blockingIssues = collectBlockingIssues(document, contentSize);

    if (blockingIssues.length > 0) {
      throw new HttpError(400, `文章不满足微信草稿要求：${blockingIssues.join("；")}`, "ARTICLE_NOT_READY_FOR_WECHAT", {
        blockingIssues,
        htmlPath: document.htmlPath
      });
    }

    logger.info("mcp_article_publish_start", {
      htmlPath: document.htmlPath,
      articleDir: document.articleDir,
      title: document.meta.title,
      contentBytes: contentSize.bytes,
      inlineImageCount: document.inlineImages.length,
      imageStrategy: strategy
    });

    const cover = await this.uploadCover({
      document,
      credentials: input.credentials,
      coverImagePath: input.coverImagePath
    });
    const inlineResult = await this.rewriteInlineImages({
      document,
      strategy,
      credentials: input.credentials
    });

    if (inlineResult.rewrittenContent !== document.contentHtml) {
      const rewrittenSize = describeContentSize(inlineResult.rewrittenContent);
      if (rewrittenSize.exceeded) {
        throw new HttpError(
          400,
          "替换图片链接后正文超过微信限制",
          "ARTICLE_CONTENT_TOO_LARGE_AFTER_REWRITE",
          {
            chars: rewrittenSize.chars,
            limitChars: rewrittenSize.limitChars,
            bytes: rewrittenSize.bytes,
            limitBytes: rewrittenSize.limitBytes
          }
        );
      }
    }

    const draft = await this.wechat.addDraftArticle({
      title: document.meta.title,
      author: document.meta.author,
      digest: document.meta.digest,
      content: inlineResult.rewrittenContent,
      thumbMediaId: cover.mediaId,
      needOpenComment: input.needOpenComment ? 1 : 0,
      onlyFansCanComment: input.onlyFansCanComment ? 1 : 0,
      credentials: input.credentials
    });

    if (inlineResult.skipped.length > 0) {
      warnings.push(`有 ${inlineResult.skipped.length} 张正文图片未处理，已在 images.skipped 中列出原因。`);
    }

    logger.info("mcp_article_publish_success", {
      htmlPath: document.htmlPath,
      draftMediaId: draft.mediaId,
      coverMediaId: cover.mediaId,
      uploadedInlineImages: inlineResult.uploaded.length,
      leftAsIsInlineImages: inlineResult.leftAsIs.length,
      skippedInlineImages: inlineResult.skipped.length
    });

    return {
      ok: true,
      draftMediaId: draft.mediaId,
      coverMediaId: cover.mediaId,
      title: document.meta.title,
      author: document.meta.author,
      digest: document.meta.digest,
      column: document.meta.column,
      source: describeSource(document),
      content: {
        htmlBytes: Buffer.byteLength(inlineResult.rewrittenContent, "utf8"),
        htmlLimitBytes: contentSize.limitBytes,
        inlineImageCount: document.inlineImages.length
      },
      images: {
        inline: {
          uploaded: inlineResult.uploaded,
          leftAsIs: inlineResult.leftAsIs,
          skipped: inlineResult.skipped
        }
      },
      cover: {
        mediaId: cover.mediaId,
        source: cover.source
      },
      warnings
    };
  }

  private async loadDocument(input: {
    path: string;
    title?: string;
    author?: string;
    digest?: string;
    coverImagePath?: string;
    column?: string;
  }) {
    const document = await loadArticleHtmlDocument(input.path);
    return applyMetaOverrides(document, input);
  }

  private async uploadCover(input: {
    document: ArticleHtmlDocument;
    credentials: WechatCredentials;
    coverImagePath?: string;
  }) {
    const hint = input.coverImagePath?.trim();
    if (hint && /^https?:\/\//i.test(hint)) {
      const downloaded = await downloadRemoteImage(hint);
      const material = await this.wechat.uploadPermanentImage({
        credentials: input.credentials,
        fileBuffer: downloaded.buffer,
        fileName: downloaded.fileName
      });
      return {
        mediaId: material.mediaId,
        source: hint
      };
    }

    const coverPath = hint
      ? path.isAbsolute(hint)
        ? hint
        : path.resolve(input.document.articleDir, hint)
      : input.document.coverCandidate;

    if (!coverPath) {
      throw new HttpError(400, "未找到封面图，无法创建微信草稿", "MISSING_COVER_IMAGE", {
        articleDir: input.document.articleDir,
        hint: "请把封面命名为 cover.png / cover.jpg / 封面.jpg 放在文章目录，或用 coverImagePath 指定"
      });
    }

    // coverImagePath 是独立的读文件通道，必须单独做沙箱检查，
    // 否则「文章在允许目录内、封面指向目录外」就能把任意文件上传成永久素材。
    if (!(await isFileInsideAllowedRoots(coverPath))) {
      throw new HttpError(403, "封面图路径不在 MCP_ALLOWED_ROOTS 允许范围内", "COVER_PATH_NOT_ALLOWED", {
        coverPath
      });
    }
    if (!(await fileExists(coverPath))) {
      throw new HttpError(400, `封面图文件不存在：${coverPath}`, "COVER_IMAGE_NOT_FOUND", { coverPath });
    }

    const material = await this.wechat.uploadPermanentImage({
      credentials: input.credentials,
      filePath: coverPath,
      fileName: path.basename(coverPath)
    });
    return {
      mediaId: material.mediaId,
      source: coverPath
    };
  }

  private async rewriteInlineImages(input: {
    document: ArticleHtmlDocument;
    strategy: ImageStrategy;
    credentials: WechatCredentials;
  }) {
    const { document, strategy, credentials } = input;
    const uploaded: PublishArticleResult["images"]["inline"]["uploaded"] = [];
    const leftAsIs: string[] = [];
    const skipped: PublishArticleResult["images"]["inline"]["skipped"] = [];
    const uploadCache = new Map<
      string,
      { mediaId: string; url?: string; via?: "uploadimg" | "material"; note?: string }
    >();
    let content = document.contentHtml;

    const images = await markUploadableImages(document.inlineImages);

    for (const image of images) {
      // 只有 data-src / data-original、没有真正 src 的懒加载图片：
      // 微信不会渲染，且没有可上传的目标，必须显式报告而不是静默丢弃。
      if (image.kind === "no-src") {
        skipped.push({
          src: image.hasLazySrcAttribute ? "data-src 懒加载图片" : "<img> 缺少 src 属性",
          reason: image.hasLazySrcAttribute
            ? "只有 data-src / data-original，没有真正的 src 属性；微信不会渲染懒加载属性，请改用 src"
            : "img 标签没有 src 属性"
        });
        continue;
      }

      if (!image.src) {
        continue;
      }

      if (image.kind === "data-uri") {
        // 用固定占位符代替 base64 本体，避免把整段 data URI 回灌进模型上下文
        skipped.push({
          src: `<data URI，${image.src.length} 字符>`,
          reason: "data: URI 无法直接上传到微信素材库，且不经过模型上下文，故不回显内容"
        });
        continue;
      }

      const shouldHandleRemote = image.kind === "remote" && strategy === "upload-all";
      const shouldHandleLocal = image.kind === "local" && (strategy === "upload-local" || strategy === "upload-all");

      if (!shouldHandleRemote && !shouldHandleLocal) {
        leftAsIs.push(image.src);
        continue;
      }

      if (image.kind === "local" && !image.uploadablePath) {
        skipped.push({
          src: truncateForReport(image.src),
          reason: `本地文件不存在：${image.absolutePath || image.src}`
        });
        continue;
      }

      // 正文图片 src 同样是一条读文件通道（例如 <img src="../outside/x.png">），
      // 必须做沙箱检查；越界时跳过并记录，而不是中断整篇上传。
      if (image.kind === "local" && image.uploadablePath) {
        if (!(await isFileInsideAllowedRoots(image.uploadablePath))) {
          skipped.push({
            src: truncateForReport(image.src),
            reason: "图片路径不在 MCP_ALLOWED_ROOTS 允许范围内"
          });
          continue;
        }
      }

      try {
        const cacheKey = image.kind === "local" && image.uploadablePath ? `file:${image.uploadablePath}` : `remote:${image.src}`;
        let material = uploadCache.get(cacheKey);
        if (!material) {
          // 正文图片优先走 media/uploadimg（官方要求、不占素材库配额），
          // 失败时 WechatService 内部自动回退永久素材并给出 note。
          const uploadedImage =
            image.kind === "local" && image.uploadablePath
              ? await this.wechat.uploadArticleImage({
                  credentials,
                  filePath: image.uploadablePath,
                  fileName: path.basename(image.uploadablePath)
                })
              : await (async () => {
                  const downloaded = await downloadRemoteImage(image.src);
                  return this.wechat.uploadArticleImage({
                    credentials,
                    fileBuffer: downloaded.buffer,
                    fileName: downloaded.fileName
                  });
                })();

          material = {
            url: uploadedImage.url,
            mediaId: uploadedImage.mediaId ?? "uploadimg",
            via: uploadedImage.via,
            note: uploadedImage.note
          };
          uploadCache.set(cacheKey, material);
          uploaded.push({
            src: truncateForReport(image.src),
            url: material.url,
            mediaId: material.mediaId,
            via: material.via,
            note: material.note
          });
        }

        if (material.url) {
          content = replaceImageSrc(content, image.src, material.url);
        } else {
          skipped.push({
            src: truncateForReport(image.src),
            reason: "微信接口未返回可用于正文的图片 URL，无法替换正文图片链接"
          });
        }
      } catch (error) {
        skipped.push({
          src: truncateForReport(image.src),
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      rewrittenContent: content,
      uploaded,
      leftAsIs,
      skipped
    };
  }
}

/** 探测 HTML，不调用微信接口，用于低成本预检。 */
export async function inspectArticleHtml(inputPath: string) {
  const resolved = await resolveArticleInput(inputPath);
  const htmlRaw = await readFile(resolved.htmlPath, "utf8");
  const contentHtml = extractContentHtml(htmlRaw);
  return {
    htmlPath: resolved.htmlPath,
    articleDir: resolved.articleDir,
    contentHtml,
    contentHash: hashFileContent(contentHtml)
  };
}

/** 文件是否位于 MCP_ALLOWED_ROOTS 内；未配置该变量时不限制。 */
async function isFileInsideAllowedRoots(filePath: string) {
  try {
    await resolveInsideAllowedRoots(filePath);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === "ARTICLE_PATH_NOT_ALLOWED") {
      return false;
    }
    throw error;
  }
}

async function fileExists(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function downloadRemoteImage(url: string) {
  const fileName = deriveRemoteFileName(url);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(appConfig.wechatApiTimeoutMs)
  });
  if (!response.ok) {
    throw new HttpError(502, `下载远程图片失败：HTTP ${response.status}`, "REMOTE_IMAGE_DOWNLOAD_FAILED", { url });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    fileName,
    buffer
  };
}

function deriveRemoteFileName(url: string) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname) || "remote-image";
    const hasExtension = /\.(png|jpe?g|gif|bmp|webp)$/i.test(base);
    return hasExtension ? base : `${base}.png`;
  } catch {
    return "remote-image.png";
  }
}

function applyMetaOverrides(
  document: ArticleHtmlDocument,
  input: {
    title?: string;
    author?: string;
    digest?: string;
    coverImagePath?: string;
    column?: string;
  }
): ArticleHtmlDocument {
  const meta: ArticleMeta = {
    ...document.meta,
    sources: { ...document.meta.sources }
  };

  if (input.title?.trim()) {
    meta.title = input.title.trim();
    meta.sources.title = "tool-argument";
  }
  if (input.author?.trim()) {
    meta.author = input.author.trim();
    meta.sources.author = "tool-argument";
  } else if (!meta.author && appConfig.wechatDefaultAuthor) {
    meta.author = appConfig.wechatDefaultAuthor;
    meta.sources.author = "WECHAT_DEFAULT_AUTHOR";
  }
  if (input.digest?.trim()) {
    meta.digest = clampDigest(input.digest.trim());
    meta.sources.digest = "tool-argument";
  }
  if (input.column?.trim()) {
    meta.column = input.column.trim();
    meta.sources.column = "tool-argument";
  }

  if (input.coverImagePath?.trim()) {
    const hint = input.coverImagePath.trim();
    meta.sources.cover = "tool-argument";
    if (!/^https?:\/\//i.test(hint)) {
      const candidate = path.isAbsolute(hint) ? hint : path.resolve(document.articleDir, hint);
      return {
        ...document,
        meta,
        coverCandidate: candidate
      };
    }
  }

  return {
    ...document,
    meta
  };
}

function collectBlockingIssues(
  document: ArticleHtmlDocument,
  contentSize: ReturnType<typeof describeContentSize>
) {
  const issues: string[] = [];
  const titleChars = Array.from(document.meta.title).length;
  const authorChars = Array.from(document.meta.author || "").length;
  const digestChars = Array.from(document.meta.digest || "").length;

  if (!document.meta.title) {
    issues.push("缺少标题：请在 HTML 中放一个 <h1>，或提供 title 参数，或在同目录放 meta.json");
  } else if (titleChars > appConfig.wechatTitleMaxChars) {
    issues.push(
      `标题 ${titleChars} 字，超过微信上限 ${appConfig.wechatTitleMaxChars} 字：${truncateForReport(document.meta.title, 60)}`
    );
  }

  if (authorChars > appConfig.wechatAuthorMaxChars) {
    issues.push(`作者 ${authorChars} 字，超过微信上限 ${appConfig.wechatAuthorMaxChars} 字`);
  }

  if (digestChars > appConfig.wechatDigestMaxChars) {
    issues.push(`摘要 ${digestChars} 字，超过微信上限 ${appConfig.wechatDigestMaxChars} 字`);
  }

  if (contentSize.chars > contentSize.limitChars) {
    issues.push(`正文 ${contentSize.chars} 字符，超过微信上限 ${contentSize.limitChars} 字符`);
  }
  if (contentSize.bytes > contentSize.limitBytes) {
    issues.push(`正文 ${contentSize.bytes} 字节，超过微信上限 ${contentSize.limitBytes} 字节`);
  }

  if (!document.coverCandidate) {
    issues.push("未找到封面图：微信 draft/add 必须提供 thumb_media_id");
  }

  return issues;
}

function describeSource(document: ArticleHtmlDocument): PublishArticleResult["source"] {
  return {
    htmlPath: document.htmlPath,
    articleDir: document.articleDir,
    metaFilePath: document.metaFilePath,
    metaSources: document.meta.sources
  };
}

function truncateForReport(value: string, maxLength = 200) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export { classifySrc };
