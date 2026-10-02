import { readFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";
import type { WechatCredentials } from "../types/wechat.js";

export type WechatDraftArticleInput = {
  title: string;
  author?: string;
  digest?: string;
  content: string;
  thumbMediaId: string;
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

export class WechatService {
  private readonly accessTokenCache = new Map<string, WechatAccessTokenCache>();

  async uploadPermanentImage(input: { credentials: WechatCredentials; filePath: string; fileName?: string }) {
    const accessToken = await this.getAccessToken(input.credentials);
    const fileName = input.fileName || path.basename(input.filePath);
    const fileBuffer = await readFile(input.filePath);
    const formData = new FormData();
    formData.append("media", new Blob([new Uint8Array(fileBuffer)], { type: getMimeType(fileName) }), fileName);

    logger.info("wechat_material_upload_start", {
      type: "image",
      fileName,
      fileSize: fileBuffer.length
    });
    const response = await this.fetchJson<WechatMaterialResponse>(
      `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`,
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

  async addDraftArticle(input: WechatDraftArticleInput & { credentials: WechatCredentials }) {
    const accessToken = await this.getAccessToken(input.credentials);
    const article = {
      article_type: "news",
      title: input.title,
      author: input.author,
      digest: input.digest,
      content: input.content,
      thumb_media_id: input.thumbMediaId,
      need_open_comment: 0,
      only_fans_can_comment: 0
    };

    logger.info("wechat_draft_add_start", {
      title: input.title,
      hasDigest: Boolean(input.digest),
      hasAuthor: Boolean(input.author),
      contentLength: input.content.length,
      thumbMediaId: input.thumbMediaId
    });
    const response = await this.fetchJson<WechatDraftResponse>(
      `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`,
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
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
        appId
      )}&secret=${encodeURIComponent(appSecret)}`,
      {
        method: "GET"
      }
    );

    assertWechatSuccess(response, "WECHAT_ACCESS_TOKEN_FAILED");
    if (!response.access_token || !response.expires_in) {
      throw new HttpError(502, "微信 access_token 响应不完整", "WECHAT_ACCESS_TOKEN_INVALID_RESPONSE", response);
    }

    this.accessTokenCache.set(appId, {
      accessToken: response.access_token,
      expiresAt: Date.now() + Math.max(response.expires_in - 300, 60) * 1000
    });
    logger.info("wechat_access_token_fetch_success", {
      expiresIn: response.expires_in
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
