#!/usr/bin/env node
/**
 * validate-content.mjs — Content Workspace 结构校验脚本
 * Owner: Agent A (Content Domain)
 *
 * 适配 Single-Repo 布局：
 *   content/articles/
 *   content/index.json
 *
 * 校验项（enforce Article Contract v1）：
 *  1. JSON 可解析（index.json / meta.json / assets.json）
 *  2. article_id 全局唯一（index 内 + 目录级）
 *  3. status 符合枚举（draft | ready_to_upload）
 *  4. index.path 必须为 canonical path（见 isCanonicalArticlePath）
 *  5. index 记录仅允许 Contract 定义字段（无 Unexpected Fields）
 *  6. index 与 meta 的 article_id / title / status / updated_at 一致
 *  7. meta 文件引用（source_file / content_file / assets_file）：
 *     non-empty string、相对路径、resolve 后位于当前 Article Package 内、文件存在
 *  8. assets.cover.required 必须显式为 true（false 即 Contract violation）
 *  9. assets.cover.path：non-empty string、相对路径、resolve 后位于 assets/ 内
 *     （路径 Contract 非法即使 draft 也 FAIL；draft 只豁免"文件缺失"）
 * 10. draft 状态允许 required asset 文件缺失（非阻塞告警）
 * 11. ready_to_upload 状态要求所有 required asset 文件存在（阻塞失败）
 *
 * 用法：
 *   node scripts/validate-content.mjs [<repo-root>]
 * 默认根目录为本脚本所在目录的上一级（即仓库根）。
 * 仅依赖 Node.js 内置模块，不引入任何外部依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const ROOT = path.resolve(process.argv[2] || DEFAULT_ROOT);

const CONTENT_ROOT = path.join(ROOT, "content");
const INDEX_PATH = path.join(CONTENT_ROOT, "index.json");
const ARTICLES_ROOT = path.join(CONTENT_ROOT, "articles");
const ARTICLES_PREFIX = "content/articles/";

const STATUS_ENUM = ["draft", "ready_to_upload"];
const SCHEMA_VERSION = 1;
const INDEX_RECORD_FIELDS = ["article_id", "title", "status", "path", "updated_at"];
const ALLOWED_INDEX_FIELDS = new Set(INDEX_RECORD_FIELDS);
const META_REQUIRED_FIELDS = [
  "schema_version",
  "article_id",
  "title",
  "author",
  "created_at",
  "updated_at",
  "status",
  "source_file",
  "content_file",
  "assets_file"
];
const META_STRING_FIELDS = [
  "article_id",
  "title",
  "author",
  "created_at",
  "updated_at",
  "status",
  "source_file",
  "content_file",
  "assets_file"
];
const META_ALLOWED_FIELDS = new Set([...META_REQUIRED_FIELDS, "digest", "column"]);

const errors = [];
const warnings = [];
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
};
const warn = (msg) => warnings.push(msg);

/**
 * 校验日期字符串是否为有效 YYYY-MM-DD 日历日期。
 * 使用 UTC 构造 Date 并反向核对 components，杜绝 2026-02-30 / 2026-13-99 这类非法日期。
 */
function isValidDateStr(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 校验 article_id 是否满足 Publisher 兼容格式：
 *   YYYY-MM-DD-<slug>，且 YYYY-MM-DD 为有效日历日期。
 * 例如：2026-topic FAIL；2026-13-99-test FAIL；2026-09-29-ai-tools PASS。
 */
function isValidArticleId(id) {
  if (typeof id !== "string" || id === "") return false;
  if (!/^\d{4}-\d{2}-\d{2}-.+/.test(id)) return false;
  return isValidDateStr(id.slice(0, 10));
}

/**
 * 校验 index 记录 path 是否为 canonical：
 *   content/articles/{year}/{article_id}/
 * - repository-root relative（非绝对路径）
 * - 以 content/articles/ 开头
 * - 以 / 结尾
 * - 不含任何 .. 段
 * - year 与 article_id 前 4 位一致
 * - 末段目录名与 article_id 完全一致
 */
function isCanonicalArticlePath(p, articleId) {
  if (typeof p !== "string" || p === "") return false;
  if (path.isAbsolute(p)) return false;
  if (p.includes("..")) return false;
  if (!p.endsWith("/")) return false;
  if (!p.startsWith(ARTICLES_PREFIX)) return false;
  const rest = p.slice(ARTICLES_PREFIX.length);
  const parts = rest.split("/").filter(Boolean);
  if (parts.length !== 2) return false;
  const [year, dirId] = parts;
  if (typeof articleId !== "string" || articleId === "") return false;
  if (dirId !== articleId) return false;
  if (year !== articleId.slice(0, 4)) return false;
  return true;
}

/**
 * 校验文件引用路径的边界：
 * - 必须是 non-empty string
 * - 不得为绝对路径
 * - resolve 后必须仍位于 baseDir 之内（不允许 ../ escape）
 */
function checkRefInside(baseDir, ref, label, articleId) {
  check(typeof ref === "string" && ref !== "", `[${articleId}] ${label} 必须是 non-empty string`);
  if (typeof ref !== "string" || ref === "") return;
  check(!path.isAbsolute(ref), `[${articleId}] ${label}(${ref}) 不得使用绝对路径`);
  const resolved = path.resolve(baseDir, ref);
  check(
    resolved.startsWith(baseDir + path.sep),
    `[${articleId}] ${label}(${ref}) 不得 escape 所属目录`
  );
}

/* ---- 0. Content Workspace 存在性 ---- */
check(fs.existsSync(CONTENT_ROOT), `Content Workspace 无效，缺少 content/ 目录: ${CONTENT_ROOT}`);
check(fs.existsSync(ARTICLES_ROOT), `Content Workspace 无效，缺少 content/articles/ 目录: ${ARTICLES_ROOT}`);

/* ---- 1. 读取并解析 index.json ---- */
check(fs.existsSync(INDEX_PATH), "缺少索引文件: content/index.json");
let indexData;
if (fs.existsSync(INDEX_PATH)) {
  try {
    indexData = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch (error) {
    check(false, `content/index.json 不是合法 JSON: ${error.message}`);
  }
}
check(indexData?.schema_version === SCHEMA_VERSION, "index.json schema_version 必须为 1");
check(Array.isArray(indexData?.articles), "index.json articles 必须是数组");
const articles = Array.isArray(indexData?.articles) ? indexData.articles : [];
const articleIds = articles.map((item) => item?.article_id).filter(Boolean);

check(new Set(articleIds).size === articleIds.length, "index.json 中存在重复 article_id");
for (const record of articles) {
  for (const field of INDEX_RECORD_FIELDS) {
    check(record && field in record, `index 记录缺少字段 ${field}: ${record?.article_id ?? "(unknown)"}`);
  }
  if (record && typeof record === "object") {
    for (const field of Object.keys(record)) {
      check(ALLOWED_INDEX_FIELDS.has(field), `index 记录包含未允许字段 ${field}: ${record.article_id ?? "(unknown)"}`);
    }
  }
  check(STATUS_ENUM.includes(record?.status), `index 记录 status 非法: ${record?.article_id} -> ${record?.status}`);
  check(
    isCanonicalArticlePath(record?.path, record?.article_id),
    `index 记录 path 非 canonical（应为 content/articles/{year}/{article_id}/）: ${record?.article_id ?? "(unknown)"} -> ${record?.path}`
  );
  check(
    typeof record?.article_id === "string" && record.article_id.trim() !== "",
    `index 记录 article_id 必须是 non-empty string: ${record?.article_id ?? "(unknown)"}`
  );
  check(
    isValidArticleId(record?.article_id),
    `index 记录 article_id 必须符合 YYYY-MM-DD-<slug> 且日期有效: ${record?.article_id ?? "(unknown)"}`
  );
  check(
    typeof record?.title === "string" && record.title.trim() !== "",
    `index 记录 title 必须是 non-empty string: ${record?.article_id ?? "(unknown)"}`
  );
  check(
    typeof record?.status === "string" && record.status.trim() !== "",
    `index 记录 status 必须是 non-empty string: ${record?.article_id ?? "(unknown)"}`
  );
  check(
    typeof record?.path === "string" && record.path.trim() !== "",
    `index 记录 path 必须是 non-empty string: ${record?.article_id ?? "(unknown)"}`
  );
  check(
    isValidDateStr(record?.updated_at),
    `index 记录 updated_at(${record?.updated_at}) 必须是有效 YYYY-MM-DD: ${record?.article_id ?? "(unknown)"}`
  );
}

/* ---- 2. 扫描 content/articles/{year}/{article_id} 目录，验证全局唯一与 index 覆盖 ---- */
const dirArticleIds = [];
if (fs.existsSync(ARTICLES_ROOT)) {
  for (const yearEntry of fs.readdirSync(ARTICLES_ROOT, { withFileTypes: true })) {
    if (!yearEntry.isDirectory()) continue;
    const yearDir = path.join(ARTICLES_ROOT, yearEntry.name);
    for (const dirEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      dirArticleIds.push({ id: dirEntry.name, dir: path.join(yearEntry.name, dirEntry.name) });
    }
  }
}
const dirIds = dirArticleIds.map((item) => item.id);
check(new Set(dirIds).size === dirIds.length, "content/articles/ 下存在重复 article_id 目录");
for (const entry of dirArticleIds) {
  check(articleIds.includes(entry.id), `目录 content/articles/${entry.dir} 未登记到 content/index.json`);
}
for (const record of articles) {
  check(dirIds.includes(record.article_id), `index 记录 ${record.article_id} 在 content/articles/ 下找不到对应目录`);
}

/* ---- 3. 逐篇文章校验 ---- */
for (const record of articles) {
  const articleId = record.article_id;
  const dirPath = path.resolve(ROOT, record.path).replace(/\/+$/, "");
  const metaPath = path.join(dirPath, "meta.json");

  check(fs.existsSync(metaPath), `[${articleId}] path(${record.path}) 下缺少 meta.json`);
  let meta;
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (error) {
      check(false, `[${articleId}] meta.json 不是合法 JSON: ${error.message}`);
      continue;
    }
  } else {
    continue;
  }

  check(
    typeof meta.schema_version === "number" && meta.schema_version === SCHEMA_VERSION,
    `[${articleId}] meta.schema_version 必须是 number 且为 1`
  );
  for (const field of META_REQUIRED_FIELDS) {
    check(field in meta, `[${articleId}] meta.json 缺少必填字段 ${field}`);
  }
  for (const field of META_STRING_FIELDS) {
    check(
      typeof meta[field] === "string" && meta[field].trim() !== "",
      `[${articleId}] meta.${field} 必须是 non-empty string`
    );
  }
  if (meta && typeof meta === "object") {
    for (const field of Object.keys(meta)) {
      check(META_ALLOWED_FIELDS.has(field), `[${articleId}] meta.json 包含未允许字段 ${field}`);
    }
  }
  check(isValidDateStr(meta.created_at), `[${articleId}] meta.created_at(${meta.created_at}) 必须是有效 YYYY-MM-DD`);
  check(isValidDateStr(meta.updated_at), `[${articleId}] meta.updated_at(${meta.updated_at}) 必须是有效 YYYY-MM-DD`);
  check(meta.article_id === articleId, `[${articleId}] meta.article_id(${meta.article_id}) 与 index 不一致`);
  check(isValidArticleId(meta.article_id), `[${articleId}] meta.article_id 必须符合 YYYY-MM-DD-<slug> 且日期有效`);
  check(meta.title === record.title, `[${articleId}] index title(${record.title}) 与 meta title(${meta.title}) 不一致`);
  check(STATUS_ENUM.includes(meta.status), `[${articleId}] meta.status 非法: ${meta.status}`);
  check(meta.status === record.status, `[${articleId}] index status(${record.status}) 与 meta status(${meta.status}) 不一致`);
  check(meta.updated_at === record.updated_at, `[${articleId}] index updated_at(${record.updated_at}) 与 meta(${meta.updated_at}) 不一致`);

  for (const ref of ["source_file", "content_file", "assets_file"]) {
    checkRefInside(dirPath, meta[ref], `meta.${ref}`, articleId);
    if (typeof meta[ref] === "string" && meta[ref] !== "") {
      const resolved = path.resolve(dirPath, meta[ref]);
      let st = null;
      try {
        st = fs.statSync(resolved);
      } catch {
        /* 文件缺失 */
      }
      check(st && st.isFile(), `[${articleId}] meta.${ref}(${meta[ref]}) 必须是 regular file`);
    }
  }
  if (meta.status === "ready_to_upload" && typeof meta.content_file === "string" && meta.content_file.trim() !== "") {
    const contentResolved = path.resolve(dirPath, meta.content_file);
    try {
      const content = fs.readFileSync(contentResolved, "utf8");
      check(content.trim() !== "", `[${articleId}] ready_to_upload 要求 content.html 有实际内容`);
    } catch {
      /* regular-file 检查已覆盖缺失情况 */
    }
  }

  let assets;
  try {
    assets = JSON.parse(fs.readFileSync(path.join(dirPath, meta.assets_file), "utf8"));
  } catch (error) {
    check(false, `[${articleId}] assets.json 不是合法 JSON: ${error.message}`);
    continue;
  }
  check(assets.schema_version === SCHEMA_VERSION, `[${articleId}] assets.schema_version 必须为 1`);
  check(assets.cover && typeof assets.cover === "object", `[${articleId}] assets.json 缺少 cover 对象`);
  check(Array.isArray(assets.body_images), `[${articleId}] assets.body_images 必须是数组`);

  /* cover Contract：required 必须显式为 true；path 语义必须先于存在性校验 */
  const cover = assets.cover;
  if (cover && typeof cover === "object") {
    check(cover.required === true, `[${articleId}] assets.cover.required 必须为 true（当前: ${cover.required}）`);
  }

  const assetsDir = path.join(dirPath, "assets");
  const requiredAssets = [];
  if (cover && typeof cover === "object") {
    const coverPath = cover.path;
    check(typeof coverPath === "string" && coverPath !== "", `[${articleId}] assets.cover.path 必须是 non-empty string`);
    if (typeof coverPath === "string" && coverPath !== "") {
      check(!path.isAbsolute(coverPath), `[${articleId}] assets.cover.path(${coverPath}) 不得使用绝对路径`);
      const coverResolved = path.resolve(dirPath, coverPath);
      check(
        coverResolved.startsWith(assetsDir + path.sep),
        `[${articleId}] assets.cover.path(${coverPath}) 必须位于 assets/ 内`
      );
      requiredAssets.push({ path: coverPath, resolved: coverResolved });
    }
  }

  for (const asset of requiredAssets) {
    if (meta.status === "ready_to_upload") {
      let st = null;
      try {
        st = fs.statSync(asset.resolved);
      } catch {
        /* 文件缺失 */
      }
      check(st && st.isFile(), `[${articleId}] ready_to_upload 要求 required asset 是 regular file 且实际存在: ${asset.path}`);
    } else if (!fs.existsSync(asset.resolved)) {
      warn(`[${articleId}] required asset 缺失（draft 状态允许）: ${asset.path}`);
    }
  }
}

/* ---- 4. 汇总 ---- */
if (errors.length > 0) {
  console.error(`❌ FAIL: ${errors.length} 个错误`);
  for (const message of errors) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log("✅ PASS: 全部检查通过");
if (warnings.length > 0) {
  console.log(`⚠️  ${warnings.length} 个告警（非阻塞）:`);
  for (const message of warnings) {
    console.log(`  - ${message}`);
  }
}
process.exit(0);
