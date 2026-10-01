import { readFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";
import type { WechatCredentials } from "./integrationConfig.service.js";

export type WechatDraftArticleInput = {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  thumbMediaId: string;
  needOpenComment?: 0 | 1;
  onlyFansCanComment?: 0 | 1;
};

export type WechatPermanentImageInput = {
  credentials: WechatCredentials;
  /** 本地文件路径；与 fileBuffer 二选一 */
  filePath?: string;
  /** 内存中的图片内容；优先于 filePath */
  fileBuffer?: Buffer;
  fileName?: string;
};

type WechatAccessTokenCache = {
  accessToken: string;
  expiresAt: number;
};

type WechatAccessTokenResponse = {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
};

type WechatMaterialResponse = {
  media_id?: string;
  url?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatDraftResponse = {
  media_id?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatUploadImgResponse = {
  url?: string;
  errcode?: number;
  errmsg?: string;
};

export class WechatService {
  private readonly accessTokenCache = new Map<string, WechatAccessTokenCache>();

  async uploadPermanentImage(input: WechatPermanentImageInput) {
    const accessToken = await this.getAccessToken(input.credentials);
    const fileName = input.fileName || (input.filePath ? path.basename(input.filePath) : "image.png");
    const fileBuffer = input.fileBuffer ?? (input.filePath ? await readFile(input.filePath) : undefined);
    if (!fileBuffer) {
      throw new HttpError(500, "上传永久素材缺少文件内容", "WECHAT_MATERIAL_MISSING_FILE", {
        hasFilePath: Boolean(input.filePath),
        hasFileBuffer: Boolean(input.fileBuffer)
      });
    }
    const formData = new FormData();
    formData.append("media", new Blob([new Uint8Array(fileBuffer)], { type: getMimeType(fileName) }), fileName);

    logger.info("wechat_material_upload_start", {
      type: "image",
      fileName,
      fileSize: fileBuffer.length
    });
    const response = await this.fetchJson<WechatMaterialResponse>(
      `${appConfig.wechatApiBase}/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`,
      {
        method: "POST",
        body: formData
      }
    );

    assertWechatSuccess(response, "WECHAT_MATERIAL_UPLOAD_FAILED");
    if (!response.media_id) {
      throw new HttpError(502, "微信永久素材上传未返回 media_id", "WECHAT_MATERIAL_UPLOAD_NO_MEDIA_ID", response);
    }

    logger.info("wechat_material_upload_success", {
      type: "image",
      fileName,
      mediaId: response.media_id,
      url: response.url
    });
    return {
      mediaId: response.media_id,
      url: response.url,
      raw: response
    };
  }

  /**
   * 上传「图文消息内的图片」，返回可嵌入正文的 URL。
   *
   * 官方 draft/add 文档要求正文图片 URL 来自 media/uploadimg；该接口上传的图片
   * 不占用公众号素材库 10 万张配额，只支持 jpg/png 且小于 1MB。
   * 任何失败（格式不支持、超过 1MB、账号权限）都回退到永久素材，保证正文图片不丢。
   */
  async uploadArticleImage(
    input: WechatPermanentImageInput
  ): Promise<{ url: string; mediaId?: string; via: "uploadimg" | "material"; note?: string }> {
    const fileName = input.fileName || (input.filePath ? path.basename(input.filePath) : "image.png");
    const buffer = input.fileBuffer ?? (input.filePath ? await readFile(input.filePath) : undefined);
    if (!buffer) {
      throw new HttpError(500, "上传正文图片缺少文件内容", "WECHAT_ARTICLE_IMAGE_MISSING_FILE", {
        hasFilePath: Boolean(input.filePath),
        hasFileBuffer: Boolean(input.fileBuffer)
      });
    }

    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    const formatSupported = extension === "jpg" || extension === "jpeg" || extension === "png";
    const withinSizeLimit = buffer.length <= 1024 * 1024;

    if (formatSupported && withinSizeLimit) {
      try {
        const accessToken = await this.getAccessToken(input.credentials);
        const formData = new FormData();
        formData.append("media", new Blob([new Uint8Array(buffer)], { type: getMimeType(fileName) }), fileName);

        logger.info("wechat_uploadimg_start", {
          fileName,
          fileSize: buffer.length
        });
        const response = await this.fetchJson<WechatUploadImgResponse>(
          `${appConfig.wechatApiBase}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`,
          {
            method: "POST",
            body: formData
          }
        );
        assertWechatSuccess(response, "WECHAT_UPLOADIMG_FAILED");
        if (response.url) {
          logger.info("wechat_uploadimg_success", {
            fileName,
            url: response.url
          });
          return {
            url: response.url,
            via: "uploadimg"
          };
        }
        logger.warn("wechat_uploadimg_no_url", {
          fileName,
          response
        });
      } catch (error) {
        // 回退到永久素材：多占一张配额，但正文图片一定能用
        logger.warn("wechat_uploadimg_failed_fallback_to_material", {
          fileName,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const material = await this.uploadPermanentImage({
      ...input,
      fileName
    });
    if (!material.url) {
      throw new HttpError(502, "永久素材接口未返回 url，无法嵌入正文图片", "WECHAT_MATERIAL_NO_URL", material.raw);
    }
    return {
      url: material.url,
      mediaId: material.mediaId,
      via: "material",
      note: formatSupported
        ? "media/uploadimg 未成功，已回退永久素材（会占用素材库图片配额）"
        : `格式 ${extension || "未知"} 不被 media/uploadimg 支持（仅 jpg/png），已使用永久素材`
    };
  }

  async addDraftArticle(input: WechatDraftArticleInput & { credentials: WechatCredentials }) {
    const accessToken = await this.getAccessToken(input.credentials);
    const article = {
      article_type: "news",
      title: input.title,
      author: input.author,
      digest: input.digest,
      content: input.content,
      thumb_media_id: input.thumbMediaId,
      need_open_comment: input.needOpenComment ?? 0,
      only_fans_can_comment: input.onlyFansCanComment ?? 0
    };

    logger.info("wechat_draft_add_start", {
      title: input.title,
      hasDigest: Boolean(input.digest),
      hasAuthor: Boolean(input.author),
      contentLength: input.content.length,
      thumbMediaId: input.thumbMediaId
    });
    const response = await this.fetchJson<WechatDraftResponse>(
      `${appConfig.wechatApiBase}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          articles: [removeUndefinedValues(article)]
        })
      }
    );

    assertWechatSuccess(response, "WECHAT_DRAFT_ADD_FAILED");
    if (!response.media_id) {
      throw new HttpError(502, "微信草稿创建未返回 media_id", "WECHAT_DRAFT_ADD_NO_MEDIA_ID", response);
    }

    logger.info("wechat_draft_add_success", {
      mediaId: response.media_id,
      title: input.title
    });
    return {
      mediaId: response.media_id,
      raw: response
    };
  }

  private async getAccessToken(credentials: WechatCredentials) {
    const appId = credentials.appId.trim();
    const appSecret = credentials.appSecret.trim();

    if (!appId || !appSecret) {
      throw new HttpError(500, "当前飞书工作台绑定的微信公众号信息不完整", "INVALID_WECHAT_BINDING", {
        hasAppId: Boolean(appId),
        hasAppSecret: Boolean(appSecret)
      });
    }

    const cached = this.accessTokenCache.get(appId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken;
    }

    logger.info("wechat_access_token_fetch_start", {
      appId
    });
    const response = await this.fetchJson<WechatAccessTokenResponse>(
      `${appConfig.wechatApiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
        appId
      )}&secret=${encodeURIComponent(appSecret)}`,
      {
        method: "GET"
      }
    );

    assertWechatSuccess(response, "WECHAT_ACCESS_TOKEN_FAILED");
    // 只用 access_token 判断响应是否完整。之前用 `!response.expires_in` 会把
    // 合法的 expires_in=0 当成缺失而误报；缺失/非正数时退化为保守的 300 秒缓存。
    if (!response.access_token) {
      throw new HttpError(502, "微信 access_token 响应不完整", "WECHAT_ACCESS_TOKEN_INVALID_RESPONSE", response);
    }

    const expiresIn = typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 300;
    this.accessTokenCache.set(appId, {
      accessToken: response.access_token,
      expiresAt: Date.now() + Math.max(expiresIn - 300, 60) * 1000
    });
    logger.info("wechat_access_token_fetch_success", {
      expiresIn
    });
    return response.access_token;
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(appConfig.wechatApiTimeoutMs)
    });
    const text = await response.text();
    let json: unknown;

    try {
      json = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new HttpError(502, "微信接口响应不是合法 JSON", "WECHAT_INVALID_JSON_RESPONSE", {
        status: response.status,
        body: text,
        parseError: error instanceof Error ? error.message : String(error)
      });
    }

    if (!response.ok) {
      throw new HttpError(502, `微信接口 HTTP ${response.status}`, "WECHAT_HTTP_ERROR", {
        status: response.status,
        body: json
      });
    }

    return json as T;
  }
}

function assertWechatSuccess(response: { errcode?: number; errmsg?: string }, code: string) {
  if (response.errcode && response.errcode !== 0) {
    throw new HttpError(502, `微信接口失败：${response.errmsg || response.errcode}`, code, response);
  }
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function getMimeType(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "gif") {
    return "image/gif";
  }
  if (extension === "bmp") {
    return "image/bmp";
  }
  return "image/jpeg";
}
