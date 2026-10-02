/**
 * content-validator — Article Contract v1 的唯一规则实现（Single Source of Rules）。
 *
 * 同一套规则通过 Reader 作用于：
 *   - validateWorkspace(reader)：整份工作区（index + 全部文章 + 全局一致性）
 *   - validateArticleAtRef(reader, articleId)：某个不可变 commit 下的单个 Article Package
 *
 * 校验项：
 *  1. JSON 可解析（index.json / meta.json / assets.json）
 *  2. article_id 全局唯一（index 内 + 目录级）
 *  3. status 符合枚举（draft | ready_to_upload）
 *  4. index.path 必须为 canonical path
 *  5. index / meta 仅允许 Contract 定义字段
 *  6. index 与 meta 的 article_id / title / status / updated_at 一致
 *  7. Article Package 固定文件名（frozen）：source.md / content.html / assets.json 必须为 regular file
 *  8. assets.cover.required 必须显式为 true
 *  9. assets.cover.path 必须位于 assets/ 内（路径非法即使 draft 也 FAIL）
 * 10. draft 允许 required asset（cover）缺失（非阻塞告警）
 * 11. ready_to_upload 要求 content.html 非空且 required asset 实际存在（阻塞失败）
 */
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const STATUS_ENUM = ["draft", "ready_to_upload"];
export const SOURCE_FILE_NAME = "source.md";
export const CONTENT_FILE_NAME = "content.html";
export const ASSETS_FILE_NAME = "assets.json";
export const PACKAGE_FILE_NAMES = [SOURCE_FILE_NAME, CONTENT_FILE_NAME, ASSETS_FILE_NAME];

const CONTENT_ROOT = "content";
const ARTICLES_ROOT = "content/articles";
const INDEX_PATH = "content/index.json";
const ARTICLES_PREFIX = "content/articles/";

const INDEX_RECORD_FIELDS = ["article_id", "title", "status", "path", "updated_at"];
const INDEX_ALLOWED_FIELDS = new Set(INDEX_RECORD_FIELDS);
const META_REQUIRED_FIELDS = [
  "schema_version",
  "article_id",
  "title",
  "author",
  "created_at",
  "updated_at",
  "status"
];
const META_STRING_FIELDS = ["article_id", "title", "author", "created_at", "updated_at", "status"];
const META_ALLOWED_FIELDS = new Set([...META_REQUIRED_FIELDS, "digest", "column"]);

function createCollector() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    check(cond, msg) {
      if (!cond) errors.push(msg);
    },
    warn(msg) {
      warnings.push(msg);
    }
  };
}

function finalize(collector) {
  return { ok: collector.errors.length === 0, errors: collector.errors, warnings: collector.warnings };
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ---- 纯函数：日期 / id / path ---- */

export function isValidDateStr(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidArticleId(value) {
  if (typeof value !== "string" || value === "") return false;
  if (!/^\d{4}-\d{2}-\d{2}-.+/.test(value)) return false;
  return isValidDateStr(value.slice(0, 10));
}

export function isCanonicalArticlePath(p, articleId) {
  if (typeof p !== "string" || p === "") return false;
  if (path.isAbsolute(p) || p.includes("..")) return false;
  if (!p.endsWith("/") || !p.startsWith(ARTICLES_PREFIX)) return false;
  const parts = p.slice(ARTICLES_PREFIX.length).split("/").filter(Boolean);
  if (parts.length !== 2) return false;
  const [year, dirId] = parts;
  if (typeof articleId !== "string" || articleId === "") return false;
  if (dirId !== articleId || year !== articleId.slice(0, 4)) return false;
  return true;
}

function articleDirRel(articleId) {
  return `${ARTICLES_PREFIX}${articleId.slice(0, 4)}/${articleId}`;
}

function collectArticleDirs(articleFiles) {
  const map = new Map();
  for (const file of articleFiles) {
    const match = file.match(/^content\/articles\/(\d{4})\/([^/]+)\//);
    if (!match) continue;
    const id = match[2];
    if (!map.has(id)) map.set(id, { id, dir: `${match[1]}/${id}` });
  }
  return [...map.values()];
}

/* ---- index 记录校验 ---- */

function validateIndexRecord(c, record) {
  const who = record?.article_id ?? "(unknown)";
  for (const field of INDEX_RECORD_FIELDS) {
    c.check(Boolean(record) && field in record, `index 记录缺少字段 ${field}: ${who}`);
  }
  if (record && typeof record === "object") {
    for (const key of Object.keys(record)) {
      c.check(INDEX_ALLOWED_FIELDS.has(key), `index 记录包含未允许字段 ${key}: ${record.article_id ?? who}`);
    }
  }
  c.check(STATUS_ENUM.includes(record?.status), `index 记录 status 非法: ${who} -> ${record?.status}`);
  c.check(isCanonicalArticlePath(record?.path, record?.article_id), `index 记录 path 非 canonical: ${who} -> ${record?.path}`);
  c.check(typeof record?.article_id === "string" && !!record.article_id.trim(), `index 记录 article_id 必须是 non-empty string: ${who}`);
  c.check(isValidArticleId(record?.article_id), `index 记录 article_id 必须符合 YYYY-MM-DD-<slug> 且日期有效: ${who}`);
  c.check(typeof record?.title === "string" && !!record.title.trim(), `index 记录 title 必须是 non-empty string: ${who}`);
  c.check(typeof record?.status === "string" && !!record.status.trim(), `index 记录 status 必须是 non-empty string: ${who}`);
  c.check(typeof record?.path === "string" && !!record.path.trim(), `index 记录 path 必须是 non-empty string: ${who}`);
  c.check(isValidDateStr(record?.updated_at), `index 记录 updated_at(${record?.updated_at}) 必须是有效 YYYY-MM-DD: ${who}`);
}

/* ---- 单个 Article Package 校验（workspace 与 ref 共用） ---- */

function validateArticleFiles(c, reader, articleId, dirRel, record) {
  const metaText = reader.readText(`${dirRel}/meta.json`);
  c.check(metaText !== null, `[${articleId}] 缺少 meta.json`);
  if (metaText === null) return;

  const parsedMeta = tryParse(metaText);
  if (!parsedMeta.ok) {
    c.check(false, `[${articleId}] meta.json 不是合法 JSON: ${parsedMeta.error}`);
    return;
  }
  const meta = parsedMeta.value;

  c.check(
    typeof meta.schema_version === "number" && meta.schema_version === SCHEMA_VERSION,
    `[${articleId}] meta.schema_version 必须是 number 且为 1`
  );
  for (const field of META_REQUIRED_FIELDS) {
    c.check(field in meta, `[${articleId}] meta.json 缺少必填字段 ${field}`);
  }
  for (const field of META_STRING_FIELDS) {
    c.check(typeof meta[field] === "string" && !!meta[field].trim(), `[${articleId}] meta.${field} 必须是 non-empty string`);
  }
  for (const key of Object.keys(meta)) {
    c.check(META_ALLOWED_FIELDS.has(key), `[${articleId}] meta.json 包含未允许字段 ${key}`);
  }
  c.check(isValidDateStr(meta.created_at), `[${articleId}] meta.created_at(${meta.created_at}) 必须是有效 YYYY-MM-DD`);
  c.check(isValidDateStr(meta.updated_at), `[${articleId}] meta.updated_at(${meta.updated_at}) 必须是有效 YYYY-MM-DD`);
  c.check(meta.article_id === articleId, `[${articleId}] meta.article_id(${meta.article_id}) 与定位不一致`);
  c.check(isValidArticleId(meta.article_id), `[${articleId}] meta.article_id 必须符合 YYYY-MM-DD-<slug> 且日期有效`);
  c.check(STATUS_ENUM.includes(meta.status), `[${articleId}] meta.status 非法: ${meta.status}`);
  if (record) {
    c.check(meta.title === record.title, `[${articleId}] index title(${record.title}) 与 meta title(${meta.title}) 不一致`);
    c.check(meta.status === record.status, `[${articleId}] index status(${record.status}) 与 meta status(${meta.status}) 不一致`);
    c.check(meta.updated_at === record.updated_at, `[${articleId}] index updated_at(${record.updated_at}) 与 meta(${meta.updated_at}) 不一致`);
  }

  // 固定文件名（frozen Contract），不支持动态配置。
  for (const fileName of PACKAGE_FILE_NAMES) {
    c.check(reader.isFile(`${dirRel}/${fileName}`), `[${articleId}] 缺少固定 Contract 文件 ${fileName}（必须为 regular file）`);
  }
  if (meta.status === "ready_to_upload") {
    const content = reader.readText(`${dirRel}/${CONTENT_FILE_NAME}`);
    c.check(content !== null && !!content.trim(), `[${articleId}] ready_to_upload 要求 content.html 有实际内容`);
  }

  // assets.json
  const assetsText = reader.readText(`${dirRel}/${ASSETS_FILE_NAME}`);
  let assets = null;
  if (assetsText === null) {
    c.check(false, `[${articleId}] 缺少 assets.json`);
  } else {
    const parsedAssets = tryParse(assetsText);
    if (!parsedAssets.ok) {
      c.check(false, `[${articleId}] assets.json 不是合法 JSON: ${parsedAssets.error}`);
    } else {
      assets = parsedAssets.value;
    }
  }
  if (assets) {
    c.check(assets.schema_version === SCHEMA_VERSION, `[${articleId}] assets.schema_version 必须是 1`);
    c.check(Boolean(assets.cover) && typeof assets.cover === "object", `[${articleId}] assets.json 缺少 cover 对象`);
    c.check(Array.isArray(assets.body_images), `[${articleId}] assets.body_images 必须是数组`);

    const cover = assets.cover;
    if (cover && typeof cover === "object") {
      c.check(cover.required === true, `[${articleId}] assets.cover.required 必须为 true（当前: ${cover.required}）`);
      const coverPath = cover.path;
      c.check(typeof coverPath === "string" && coverPath !== "", `[${articleId}] assets.cover.path 必须是 non-empty string`);
      if (typeof coverPath === "string" && coverPath !== "") {
        c.check(!path.isAbsolute(coverPath), `[${articleId}] assets.cover.path(${coverPath}) 不得使用绝对路径`);
        c.check(!coverPath.includes(".."), `[${articleId}] assets.cover.path(${coverPath}) 不得包含 ..`);
        c.check(coverPath.startsWith("assets/"), `[${articleId}] assets.cover.path(${coverPath}) 必须位于 assets/ 内`);
        const coverRel = `${dirRel}/${coverPath}`;
        if (meta.status === "ready_to_upload") {
          c.check(reader.isFile(coverRel), `[${articleId}] ready_to_upload 要求 required asset 实际存在: ${coverPath}`);
        } else if (!reader.isFile(coverRel)) {
          c.warn(`[${articleId}] required asset 缺失（draft 状态允许）: ${coverPath}`);
        }
      }
    }
  }
}

/* ---- 模式 A：整份工作区 ---- */

export function validateWorkspace(reader) {
  const c = createCollector();

  const contentFiles = reader.listFiles(CONTENT_ROOT);
  c.check(contentFiles.length > 0, `Content Workspace 无效，缺少 ${CONTENT_ROOT}/ 目录`);
  const articleFiles = reader.listFiles(ARTICLES_ROOT);

  const indexText = reader.readText(INDEX_PATH);
  c.check(indexText !== null, "缺少索引文件: content/index.json");
  let indexData;
  if (indexText !== null) {
    const parsed = tryParse(indexText);
    if (parsed.ok) {
      indexData = parsed.value;
    } else {
      c.check(false, `content/index.json 不是合法 JSON: ${parsed.error}`);
    }
  }
  c.check(indexData?.schema_version === SCHEMA_VERSION, "index.json schema_version 必须为 1");
  c.check(Array.isArray(indexData?.articles), "index.json articles 必须是数组");
  const records = Array.isArray(indexData?.articles) ? indexData.articles : [];
  const articleIds = records.map((item) => item?.article_id).filter(Boolean);
  c.check(new Set(articleIds).size === articleIds.length, "index.json 中存在重复 article_id");

  for (const record of records) validateIndexRecord(c, record);

  const dirEntries = collectArticleDirs(articleFiles);
  const dirIds = dirEntries.map((entry) => entry.id);
  c.check(new Set(dirIds).size === dirIds.length, "content/articles/ 下存在重复 article_id 目录");
  for (const entry of dirEntries) {
    c.check(articleIds.includes(entry.id), `目录 content/articles/${entry.dir} 未登记到 content/index.json`);
  }
  for (const record of records) {
    c.check(dirIds.includes(record.article_id), `index 记录 ${record.article_id} 在 content/articles/ 下找不到对应目录`);
  }

  for (const record of records) {
    const dirRel = String(record.path || "").replace(/\/+$/, "");
    validateArticleFiles(c, reader, record.article_id, dirRel, record);
  }

  return finalize(c);
}

/* ---- 模式 B：某个不可变 commit 下的单个 Article Package ---- */

export function validateArticleAtRef(reader, articleId) {
  const c = createCollector();
  c.check(isValidArticleId(articleId), `article_id 必须符合 YYYY-MM-DD-<slug>: ${articleId}`);
  if (!isValidArticleId(articleId)) return finalize(c);

  const dirRel = articleDirRel(articleId);

  const indexText = reader.readText(INDEX_PATH);
  let record = null;
  if (indexText === null) {
    c.check(false, "该版本缺少 content/index.json");
  } else {
    const parsed = tryParse(indexText);
    if (!parsed.ok) {
      c.check(false, `content/index.json 不是合法 JSON: ${parsed.error}`);
    } else {
      c.check(parsed.value?.schema_version === SCHEMA_VERSION, "index.json schema_version 必须为 1");
      c.check(Array.isArray(parsed.value?.articles), "index.json articles 必须是数组");
      const recs = Array.isArray(parsed.value?.articles) ? parsed.value.articles : [];
      record = recs.find((item) => item?.article_id === articleId) ?? null;
      c.check(record !== null, `content/index.json 在该版本未登记 article ${articleId}`);
      if (record) validateIndexRecord(c, record);
    }
  }

  validateArticleFiles(c, reader, articleId, dirRel, record);
  return finalize(c);
}
