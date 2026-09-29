import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";

/**
 * Publisher API 鉴权（MVP）：
 *   Authorization: Bearer <PUBLISHER_WEBHOOK_TOKEN>
 * Token 只存在于服务器端环境变量，绝不写入日志或返回体。
 * 比对使用 SHA-256 摘要后的 constant-time 比较，避免时序攻击。
 */
export function requirePublisherToken(req: Request, _res: Response, next: NextFunction) {
  const configured = appConfig.publisherWebhookToken;
  if (!configured) {
    next(new HttpError(500, "服务器未配置 PUBLISHER_WEBHOOK_TOKEN", "PUBLISHER_NOT_CONFIGURED", undefined, false));
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !safeEqual(token, configured)) {
    next(new HttpError(401, "未认证或凭证无效", "UNAUTHORIZED", undefined, false));
    return;
  }

  next();
}

function safeEqual(a: string, b: string) {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
