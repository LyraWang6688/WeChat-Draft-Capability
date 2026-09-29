import { Router } from "express";
import { requirePublisherToken } from "../middleware/publisherAuth.js";
import { services } from "../services/index.js";
import type { PublisherDraftRequest } from "../services/publisher.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logger } from "../utils/logger.js";

export const publisherRouter = Router();

/**
 * POST /api/publisher/drafts
 *
 * Publisher API Contract v1：
 * 调用方（GitHub Actions）只传 repository / article_id / ref / source_commit，
 * Publisher 自行从 Content Hub 拉取 meta.json / content.html / assets.json / cover。
 * 请求体不得携带完整 HTML。
 */
publisherRouter.post(
  "/drafts",
  requirePublisherToken,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Partial<PublisherDraftRequest>;
    const { repository, article_id, ref, source_commit } = body;
    const traceId = res.locals.traceId as string | undefined;

    logger.info("publisher_draft_route_received", {
      trace_id: traceId,
      repository,
      article_id,
      ref,
      source_commit
    });

    const data = await services.publisher.createDraft(
      {
        repository: repository ?? "",
        article_id: article_id ?? "",
        ref: ref ?? "",
        source_commit: source_commit ?? ""
      },
      traceId
    );

    logger.info("publisher_draft_route_success", {
      trace_id: traceId,
      article_id,
      source_commit,
      idempotent_replay: data.idempotent_replay
    });
    res.json({ ok: true, data });
  })
);
