#!/usr/bin/env node
/**
 * validate-content.mjs — Content Workspace / Article Package 校验入口（thin CLI）。
 *
 * 规则唯一实现见 scripts/lib/content-validator.mjs，本文件只负责参数与输出。
 *
 * 用法：
 *   Workspace 模式（默认，校验整份内容）：
 *     node scripts/validate-content.mjs [<repo-root>]
 *   Authorized Version 模式（校验某个不可变 commit 下的单个 Article Package）：
 *     node scripts/validate-content.mjs --ref <commit-sha> --article-id <article_id>
 *
 * Ref 模式在当前工作目录（git 仓库）上执行；Workflow 在 checkout 根目录调用它。
 * 退出码：0 通过；1 校验失败；2 参数错误。仅依赖 Node 内置模块。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitRefReader, createWorkspaceReader } from "./lib/reader.mjs";
import { validateArticleAtRef, validateWorkspace } from "./lib/content-validator.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const options = { positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      options.positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return options;
}

function report(label, result) {
  if (result.ok) {
    console.log(`✅ PASS [${label}]: 全部检查通过`);
    for (const warning of result.warnings) console.log(`⚠️  ${warning}`);
    return 0;
  }
  console.error(`❌ FAIL [${label}]: ${result.errors.length} 个错误`);
  for (const error of result.errors) console.error(`  - ${error}`);
  for (const warning of result.warnings) console.warn(`⚠️  ${warning}`);
  return 1;
}

const args = parseArgs(process.argv.slice(2));
let exitCode;

if (args.ref) {
  const articleId = args["article-id"] || args.article || args.positionals[0];
  if (!articleId) {
    console.error("ref 模式必须提供 --article-id <article_id>");
    process.exit(2);
  }
  const reader = createGitRefReader(String(args.ref), { cwd: process.cwd() });
  exitCode = report(`${articleId} @ ${args.ref}`, validateArticleAtRef(reader, articleId));
} else {
  const root = path.resolve(args.positionals[0] || DEFAULT_ROOT);
  exitCode = report("workspace", validateWorkspace(createWorkspaceReader(root)));
}

process.exit(exitCode);
