import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { redactValue } from "./redact.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export type LogMeta = Record<string, unknown>;

function resolveLevel(): LogLevel {
  const level = process.env.LOG_LEVEL || appConfig.logLevel;
  return level in LOG_LEVEL_ORDER ? (level as LogLevel) : "info";
}

function shouldLog(level: LogLevel) {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[resolveLevel()];
}

/**
 * 日志目标必须在「每次写入时」判断，不能在模块初始化时固化成常量。
 *
 * 原因：ESM 的 import 会被提升到模块体之前求值。MCP 入口即使把
 * process.env.MCP_LOG_TARGET = "stderr" 写在文件第一行，也仍然晚于
 * logger 模块的初始化。一旦固化成常量，stdio 模式下第一条日志就会写进
 * stdout，破坏 JSON-RPC 通道，导致 MCP 客户端握手失败。
 */
function shouldWriteToStderr(level: LogLevel) {
  if (level === "warn" || level === "error") {
    return true;
  }
  return process.env.MCP_LOG_TARGET === "stderr" || appConfig.logToStderr;
}

function write(level: LogLevel, event: string, meta: LogMeta = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = redactValue({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...meta
  });

  const line = JSON.stringify(payload);
  if (shouldWriteToStderr(level)) {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger = {
  debug: (event: string, meta?: LogMeta) => write("debug", event, meta),
  info: (event: string, meta?: LogMeta) => write("info", event, meta),
  warn: (event: string, meta?: LogMeta) => write("warn", event, meta),
  error: (event: string, meta?: LogMeta) => write("error", event, meta)
};

export function createTraceId(prefix = "trace") {
  return `${prefix}_${randomUUID()}`;
}
