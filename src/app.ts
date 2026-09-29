import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { appConfig } from "./config.js";
import { HttpError } from "./errors/HttpError.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { LarkCliError } from "./services/larkCliRunner.js";
import { feishuWebhookRouter } from "./routes/feishuWebhook.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { larkBaseRouter } from "./routes/larkBase.routes.js";
import { larkSharedRouter } from "./routes/larkShared.routes.js";
import { publisherRouter } from "./routes/publisher.routes.js";
import { systemRouter } from "./routes/system.routes.js";
import { templateRouter } from "./routes/template.routes.js";
import { logger } from "./utils/logger.js";
import { integrationConfigRouter } from "./routes/integrationConfig.routes.js";

export function createApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: false
    })
  );
  app.use(cors());
  app.use(morgan("dev"));
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLogger);
  app.use(express.static(appConfig.publicDir));

  app.use("/api/health", healthRouter);
  app.use("/api/system", systemRouter);
  app.use("/api/lark/shared", larkSharedRouter);
  app.use("/api/lark/base", larkBaseRouter);
  app.use("/api/integrations", integrationConfigRouter);
  app.use("/api/templates", templateRouter);
  app.use("/api/webhooks/feishu", feishuWebhookRouter);
  app.use("/api/publisher", publisherRouter);

  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        message: "接口不存在",
        code: "NOT_FOUND"
      }
    });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const traceId = res.locals.traceId as string | undefined;
    if (error instanceof HttpError) {
      logger.warn("http_error", {
        traceId,
        code: error.code,
        message: error.message,
        details: error.details
      });
      res.status(error.statusCode).json({
        ok: false,
        error: {
          message: error.message,
          code: error.code,
          details: error.details,
          retryable: error.retryable
        }
      });
      return;
    }

    if (error instanceof LarkCliError) {
      logger.error("lark_cli_http_error", {
        traceId,
        message: error.message,
        command: error.command,
        args: error.args,
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr
      });
      res.status(502).json({
        ok: false,
        error: {
          message: error.message,
          code: "LARK_CLI_ERROR",
          details: {
            command: error.command,
            args: error.args,
            exitCode: error.exitCode,
            stdout: error.stdout,
            stderr: error.stderr
          }
        }
      });
      return;
    }

    logger.error("unhandled_http_error", {
      traceId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    res.status(500).json({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : "服务内部错误",
        code: "INTERNAL_ERROR"
      }
    });
  };

  app.use(errorHandler);

  return app;
}
