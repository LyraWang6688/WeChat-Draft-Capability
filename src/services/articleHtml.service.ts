import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config.js";
import { HttpError } from "../errors/HttpError.js";
import { logger } from "../utils/logger.js";

/** meta.json 的宽松结构：只描述我们自己认识的键，其余字段原样透传。 */
export type ArticleMetaFile = {
  title?: unknown;
  author?: unknown;
  digest?: unknown;
  column?: unknown;
  cover?: unknown;
  coverImage?: unknown;
  thumb?: unknown;
  contentHtml?: unknown;
  needOpenComment?: unknown;
  onlyFansCanComment?: unknown;
};

export type ArticleMeta = {
  title: string;
  author?: string;
  digest?: string;
  column?: string;
  /** 来源说明，便于在响应里解释每个字段是怎么来的，减少模型追问成本 */
  sources: Record<string, string>;
};

export type InlineImage = {
  index: number;
  /** HTML 中原始 src 值；无 src 属性时为空串 */
  src: string;
  kind: "local" | "remote" | "data-uri" | "no-src";
  /** local 图片解析后的绝对路径 */
  absolutePath?: string;
  /** 已解析并存在、可用于上传的文件绝对路径 */
  uploadablePath?: string;
  /** 标签里存在 data-src / data-original 但没有真正的 src（懒加载写法） */
  hasLazySrcAttribute?: boolean;
};

export type ArticleHtmlDocument = {
  inputPath: string;
  /** 实际读取的 HTML 文件绝对路径 */
  htmlPath: string;
  /** 文章目录，用于相对路径解析与封面发现 */
  articleDir: string;
  htmlRaw: string;
  /** 已剥离 html/head/body 包裹的正文 HTML，可直接提交微信 */
  contentHtml: string;
  meta: ArticleMeta;
  inlineImages: InlineImage[];
  /** 封面候选绝对路径 */
  coverCandidate?: string;
  metaFilePath?: string;
  warnings: string[];
};

const HTML_EXTENSIONS = [".html", ".htm"];
const PREFERRED_HTML_NAMES = ["article.html", "index.html", "wechat.html", "content.html", "正文.html", "文章.html"];
const COVER_BASENAMES = ["cover", "封面", "thumb", "thumbnail", "banner", "头图"];
const COVER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"];

const REMOTE_SRC_PATTERN = /^(?:https?:)?\/\//i;
const DATA_URI_PATTERN = /^data:/i;

/**
 * 读取一篇文章的 HTML 与元数据。
 *
 * 设计要点：正文永远从磁盘读取，不经过模型上下文，因此 MCP 工具只需传一个文件路径。
 */
export async function loadArticleHtmlDocument(inputPath: string): Promise<ArticleHtmlDocument> {
  const resolved = await resolveArticleInput(inputPath);
  const htmlRaw = await readFile(resolved.htmlPath, "utf8");

  if (!htmlRaw.trim()) {
    throw new HttpError(400, "HTML 文件内容为空", "EMPTY_ARTICLE_HTML", {
      htmlPath: resolved.htmlPath
    });
  }

  const contentHtml = extractContentHtml(htmlRaw);
  if (!contentHtml.trim()) {
    throw new HttpError(400, "HTML 文件中没有可提交的正文内容", "EMPTY_ARTICLE_CONTENT", {
      htmlPath: resolved.htmlPath
    });
  }

  const metaFile = await readMetaFile(resolved.articleDir);
  const extracted = extractMetaFromHtml(htmlRaw, contentHtml);
  const meta = mergeMeta({
    metaFile: metaFile?.data,
    metaFilePath: metaFile?.filePath,
    extracted
  });
  const warnings: string[] = [];

  const inlineImages = collectInlineImages(contentHtml, resolved.articleDir);
  const coverCandidate = await resolveCoverCandidate(resolved.articleDir, metaFile?.data, inlineImages);

  if (!coverCandidate) {
    warnings.push(
      "未找到封面图。微信 draft/add 要求 thumb_media_id，请放置 cover.png/cover.jpg/封面.jpg 于文章目录，或用 coverImagePath 参数指定。"
    );
  }
  if (inlineImages.some((item) => item.kind === "data-uri")) {
    warnings.push("正文中存在 data: URI 图片，微信接口无法直接上传，将保持原样（建议改为本地文件或外链）。");
  }

  return {
    inputPath,
    htmlPath: resolved.htmlPath,
    articleDir: resolved.articleDir,
    htmlRaw,
    contentHtml,
    meta,
    inlineImages,
    coverCandidate,
    metaFilePath: metaFile?.filePath,
    warnings
  };
}

/**
 * 解析工具传入的 path：既接受 HTML 文件，也接受包含 HTML 的文章目录。
 */
export async function resolveArticleInput(inputPath: string) {
  if (!inputPath || !inputPath.trim()) {
    throw new HttpError(400, "缺少 path 参数", "MISSING_ARTICLE_PATH");
  }

  const absolute = await resolveInsideAllowedRoots(inputPath.trim());
  let fileStat;
  try {
    fileStat = await stat(absolute);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new HttpError(400, `路径不存在：${absolute}`, "ARTICLE_PATH_NOT_FOUND", { path: absolute });
    }
    throw error;
  }

  if (fileStat.isFile()) {
    if (!HTML_EXTENSIONS.includes(path.extname(absolute).toLowerCase())) {
      throw new HttpError(400, `只支持 HTML 文件，当前为：${path.extname(absolute) || "无扩展名"}`, "UNSUPPORTED_ARTICLE_FILE", {
        path: absolute
      });
    }
    return {
      htmlPath: absolute,
      articleDir: path.dirname(absolute)
    };
  }

  if (fileStat.isDirectory()) {
    const htmlPath = await pickHtmlInDirectory(absolute);
    return {
      htmlPath,
      articleDir: absolute
    };
  }

  throw new HttpError(400, `路径既不是文件也不是目录：${absolute}`, "UNSUPPORTED_ARTICLE_PATH", { path: absolute });
}

async function pickHtmlInDirectory(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  const htmlFiles = entries
    .filter((entry) => entry.isFile() && HTML_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);

  if (htmlFiles.length === 0) {
    throw new HttpError(400, "目录中没有找到 HTML 文件", "NO_HTML_IN_DIRECTORY", {
      directory,
      hint: "请放置 article.html，或直接用 path 指向具体的 HTML 文件"
    });
  }

  const preferred = PREFERRED_HTML_NAMES.find((name) => htmlFiles.some((file) => file.toLowerCase() === name));
  if (preferred) {
    const matched = htmlFiles.find((file) => file.toLowerCase() === preferred);
    if (matched) {
      return path.join(directory, matched);
    }
  }

  if (htmlFiles.length === 1) {
    return path.join(directory, htmlFiles[0] as string);
  }

  throw new HttpError(400, "目录中存在多个 HTML 文件，无法自动判断正文", "AMBIGUOUS_HTML_IN_DIRECTORY", {
    directory,
    candidates: htmlFiles,
    hint: "请用 path 直接指定要上传的 HTML 文件"
  });
}

/**
 * 把任意 HTML 归一到微信 draft/add 需要的 content 片段。
 * 微信只接收内联样式的正文片段，不接收完整文档骨架。
 */
export function extractContentHtml(html: string) {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");

  const bodyMatch = withoutNoise.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const inner = bodyMatch ? (bodyMatch[1] as string) : stripDocumentWrapper(withoutNoise);

  return inner.trim();
}

function stripDocumentWrapper(html: string) {
  if (/<html\b/i.test(html) || /<head\b/i.test(html)) {
    // 有文档骨架但没有 body：尽量去掉 head 之后的内容
    const afterHead = html.replace(/[\s\S]*?<\/head>/i, "");
    return afterHead.trim() || html;
  }
  return html;
}

function extractMetaFromHtml(htmlRaw: string, contentHtml: string): ArticleMeta {
  const sources: Record<string, string> = {};

  // 优先用 meta.json 之外的显式约定：<meta name="wechat:title" content="...">
  const scopedTitle = matchMetaContent(htmlRaw, ["wechat:title", "article:title"]);
  const scopedAuthor = matchMetaContent(htmlRaw, ["wechat:author", "article:author", "author"]);
  const scopedDigest = matchMetaContent(htmlRaw, ["wechat:digest", "article:digest", "description"]);
  const scopedColumn = matchMetaContent(htmlRaw, ["wechat:column", "article:column", "column"]);

  const headingTitle = matchFirstText(htmlRaw, "h1");
  const docTitle = matchFirstText(htmlRaw, "title");

  const title = scopedTitle || headingTitle || docTitle || "";
  if (scopedTitle) {
    sources.title = "meta[wechat:title]";
  } else if (headingTitle) {
    sources.title = "h1";
  } else if (docTitle) {
    sources.title = "title";
  }

  if (scopedAuthor) {
    sources.author = "meta[author]";
  }
  if (scopedDigest) {
    sources.digest = "meta[description]";
  }
  if (scopedColumn) {
    sources.column = "meta[column]";
  }

  const digest = scopedDigest || excerptFromHtml(contentHtml);

  return {
    title: title.trim(),
    author: scopedAuthor?.trim(),
    digest: digest?.trim(),
    column: scopedColumn?.trim(),
    sources
  };
}

function mergeMeta(input: { metaFile?: ArticleMetaFile; metaFilePath?: string; extracted: ArticleMeta }): ArticleMeta {
  const file = input.metaFile || {};
  const sources = { ...input.extracted.sources };

  const fileTitle = readOptionalString(file.title);
  const fileAuthor = readOptionalString(file.author);
  const fileDigest = readOptionalString(file.digest);
  const fileColumn = readOptionalString(file.column);

  const title = fileTitle || input.extracted.title;
  if (fileTitle) {
    sources.title = `${path.basename(input.metaFilePath || "meta.json")}.title`;
  }
  const author = fileAuthor || input.extracted.author;
  if (fileAuthor) {
    sources.author = `${path.basename(input.metaFilePath || "meta.json")}.author`;
  }
  const digest = fileDigest || input.extracted.digest;
  if (fileDigest) {
    sources.digest = `${path.basename(input.metaFilePath || "meta.json")}.digest`;
  }
  const column = fileColumn || input.extracted.column;
  if (fileColumn) {
    sources.column = `${path.basename(input.metaFilePath || "meta.json")}.column`;
  }

  return {
    title,
    author,
    digest: clampDigest(digest),
    column,
    sources
  };
}

async function readMetaFile(articleDir: string) {
  for (const name of ["meta.json", "article.json", "wechat.json"]) {
    const filePath = path.join(articleDir, name);
    try {
      const content = await readFile(filePath, "utf8");
      const data = JSON.parse(content) as ArticleMetaFile;
      return {
        filePath,
        data
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      if (error instanceof SyntaxError) {
        logger.warn("mcp_article_meta_json_invalid", {
          filePath,
          message: error.message
        });
        return {
          filePath,
          data: {}
        };
      }
      throw error;
    }
  }
  return undefined;
}

async function resolveCoverCandidate(
  articleDir: string,
  metaFile: ArticleMetaFile | undefined,
  inlineImages: InlineImage[]
) {
  const explicit = readOptionalString(metaFile?.cover) || readOptionalString(metaFile?.coverImage) || readOptionalString(metaFile?.thumb);
  if (explicit) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(articleDir, explicit);
    // meta.json 的 cover 也是一条独立的读取通道，必须走沙箱检查
    const allowedCandidate = await resolveInsideAllowedRootsOrUndefined(candidate);
    if (allowedCandidate && (await isFile(allowedCandidate))) {
      return allowedCandidate;
    }
    if (!allowedCandidate) {
      logger.warn("mcp_article_cover_hint_outside_allowed_roots", {
        hint: explicit,
        resolved: candidate
      });
    } else {
      logger.warn("mcp_article_cover_hint_missing", {
        hint: explicit,
        resolved: candidate
      });
    }
  }

  let entries: string[] = [];
  try {
    const dirEntries = await readdir(articleDir, { withFileTypes: true });
    entries = dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    logger.warn("mcp_article_cover_scan_failed", {
      articleDir,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const normalized = entries.map((name) => ({
    name,
    lower: name.toLowerCase(),
    base: path.basename(name, path.extname(name)).toLowerCase()
  }));

  // 1. cover.png / 封面.jpg / thumb.png 等惯用命名
  for (const coverBase of COVER_BASENAMES) {
    const matched = normalized.find(
      (item) => item.base === coverBase && COVER_EXTENSIONS.includes(path.extname(item.lower))
    );
    if (matched) {
      return path.join(articleDir, matched.name);
    }
  }

  // 2. 正文里第一张「确实存在」的本地图片兜底
  // 注意：不能依赖 image.uploadablePath —— 它由 markUploadableImages 在后续阶段填充，
  // 此处必须自己检查文件是否存在，否则这个兜底分支永远不会命中。
  for (const image of inlineImages) {
    if (image.kind !== "local" || !image.absolutePath) {
      continue;
    }
    const allowed = await resolveInsideAllowedRootsOrUndefined(image.absolutePath);
    if (allowed && (await isFile(allowed))) {
      return allowed;
    }
  }

  return undefined;
}

/**
 * 匹配 <img ...> 开标签本身（不跨标签边界）。
 * [^>]* 对 alt="a > b" 这种含 > 的属性值会提前截断，属已知限制。
 */
const IMG_TAG_PATTERN = /<img\b[^>]*>/gi;

/**
 * 在一个 img 开标签内部提取真正的 src 属性值。
 *
 * 必须显式要求属性名前有空白（或紧跟在 <img 之后），否则 `data-src` / `data-original`
 * 会被当成 src —— 那样会把素材 URL 写进 data-src，而真实 src 从未创建，
 * 结果是图片在草稿里不显示，调用方却收到"上传成功"。
 */
function extractSrcAttribute(imgTag: string) {
  const inner = imgTag.replace(/^<img\b/i, "");
  const match = inner.match(/(?:\s|^)src\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return match ? (match[1] ?? match[2] ?? "") : undefined;
}

function collectInlineImages(contentHtml: string, articleDir: string): InlineImage[] {
  const images: InlineImage[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  IMG_TAG_PATTERN.lastIndex = 0;

  while ((match = IMG_TAG_PATTERN.exec(contentHtml)) !== null) {
    const imgTag = match[0];
    const rawSrc = extractSrcAttribute(imgTag);
    const src = (rawSrc ?? "").trim();
    // 只有 data-src / data-original 而没有 src：懒加载图片，微信不会渲染
    const hasLazySrcAttribute =
      rawSrc === undefined && /(?:\s|^)data-(?:src|original)\s*=/i.test(imgTag);

    const entry: InlineImage = {
      index: index++,
      src,
      kind: rawSrc === undefined ? "no-src" : classifySrc(src)
    };

    if (hasLazySrcAttribute) {
      entry.hasLazySrcAttribute = true;
    }

    if (entry.kind === "local" && src) {
      const decoded = safeDecodeURIComponent(src);
      const absolutePath = path.resolve(articleDir, decoded);
      entry.absolutePath = absolutePath;
    }

    images.push(entry);
  }

  return images;
}

/** 判定一个非空 src 值的类型；无 src 属性由 collectInlineImages 单独标记为 no-src。 */
export function classifySrc(src: string): "local" | "remote" | "data-uri" {
  if (!src) {
    return "local";
  }
  if (DATA_URI_PATTERN.test(src)) {
    return "data-uri";
  }
  if (REMOTE_SRC_PATTERN.test(src)) {
    return "remote";
  }
  return "local";
}

/** 把本地已确认存在的图片补上 uploadablePath，供上传阶段使用。 */
export async function markUploadableImages(images: InlineImage[]) {
  const result: InlineImage[] = [];
  for (const image of images) {
    if (image.kind !== "local" || !image.absolutePath) {
      result.push(image);
      continue;
    }
    result.push({
      ...image,
      uploadablePath: (await isFile(image.absolutePath)) ? image.absolutePath : undefined
    });
  }
  return result;
}

/**
 * 把正文中某张图片的 src 替换为微信素材 URL。
 *
 * 按「逐个 img 标签 + 显式 src 属性」处理，与 collectInlineImages 使用同一套
 * 属性识别逻辑，避免两处正则各自漂移（例如把 URL 写进 data-src 而漏掉真 src）。
 */
export function replaceImageSrc(html: string, from: string, to: string) {
  if (from === to) {
    return html;
  }

  return html.replace(IMG_TAG_PATTERN, (imgTag: string) => {
    const currentSrc = extractSrcAttribute(imgTag);
    if (currentSrc === undefined || currentSrc.trim() !== from.trim()) {
      return imgTag;
    }
    // 只替换该标签内的这一个 src 属性值，其余属性原样保留
    return imgTag.replace(
      /((?:\s|^)src\s*=\s*)(?:"[^"]*"|'[^']*')/i,
      (_full: string, prefix: string) => `${prefix}"${to}"`
    );
  });
}

export function hashFileContent(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 把路径解析成「真实路径」：如果路径本身不存在，就找到最深的已存在祖先，
 * 对它做 realpath，再拼回剩余部分。这样即使文件还不存在，符号链接也不会被绕过。
 */
async function toRealPath(absolutePath: string): Promise<string> {
  const missingSegments: string[] = [];
  let current = absolutePath;

  // 逐级向上找到第一个存在的祖先
  for (;;) {
    try {
      const real = await realpath(current);
      return missingSegments.length > 0 ? path.join(real, ...missingSegments.reverse()) : real;
    } catch (error) {
      if (!isNotFoundError(error)) {
        // 其他错误（例如权限）不阻断判断，退化为原路径
        return absolutePath;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function parseAllowedRoots() {
  return (process.env.MCP_ALLOWED_ROOTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

/**
 * 限制 MCP 能读取的根目录，避免模型给出的任意路径被读取。
 * 未配置 MCP_ALLOWED_ROOTS 时不限制（本地单机默认行为）。
 *
 * 安全性要点：
 * 1. 比较前先做 realpath，否则允许目录内的符号链接可以指向 /etc 等任意位置。
 * 2. 边界比较追加 path.sep，避免 /a/b 误放行 /a/bc。
 * 3. 这个函数必须被所有「从磁盘读文件」的入口调用，不能只管 path 参数——
 *    coverImagePath、meta.json 的 cover、正文图片 src 都是独立的读取通道。
 */
export async function resolveInsideAllowedRoots(inputPath: string) {
  const absolute = path.resolve(inputPath);
  const rawRoots = parseAllowedRoots();

  if (rawRoots.length === 0) {
    return absolute;
  }

  const realTarget = await toRealPath(absolute);
  const realRoots = await Promise.all(rawRoots.map((root) => toRealPath(root)));

  const allowed = realRoots.some((root) => realTarget === root || realTarget.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new HttpError(403, "路径不在 MCP_ALLOWED_ROOTS 允许范围内", "ARTICLE_PATH_NOT_ALLOWED", {
      path: absolute,
      resolvedPath: realTarget,
      allowedRoots: rawRoots
    });
  }

  return absolute;
}

/**
 * 非抛错版本的沙箱检查，供封面/正文图片这类「可以跳过」的通道使用。
 * 返回 undefined 表示越界，调用方应记录到 skipped 而不是中断整篇上传。
 */
export async function resolveInsideAllowedRootsOrUndefined(inputPath: string): Promise<string | undefined> {
  try {
    return await resolveInsideAllowedRoots(inputPath);
  } catch (error) {
    if (error instanceof HttpError && error.code === "ARTICLE_PATH_NOT_ALLOWED") {
      return undefined;
    }
    // 路径不存在等其它情况：交给后续的存在性检查处理
    return path.resolve(inputPath);
  }
}

export function describeContentSize(contentHtml: string) {
  const bytes = Buffer.byteLength(contentHtml, "utf8");
  // 微信按「字符数」限制正文（少于 2 万字符），中英文都算 1 个字符，
  // 与 Array.from 的码点计数一致，可正确处理 emoji 等代理对。
  const chars = Array.from(contentHtml).length;
  return {
    bytes,
    chars,
    limitBytes: appConfig.wechatContentMaxBytes,
    limitChars: appConfig.wechatContentMaxChars,
    exceeded: bytes > appConfig.wechatContentMaxBytes || chars > appConfig.wechatContentMaxChars
  };
}

/** 摘要超长时按字符数截断，避免触发微信 120 字上限。 */
export function clampDigest(digest: string | undefined) {
  if (!digest) {
    return digest;
  }
  const chars = Array.from(digest);
  if (chars.length <= appConfig.wechatDigestMaxChars) {
    return digest;
  }
  return chars.slice(0, appConfig.wechatDigestMaxChars).join("");
}

function matchMetaContent(html: string, names: string[]) {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      `<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped})[^>]*?\\bcontent\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      "i"
    );
    const match = html.match(pattern);
    if (match) {
      const value = (match[1] ?? match[2] ?? "").trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function matchFirstText(html: string, tag: string) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = html.match(pattern);
  if (!match) {
    return undefined;
  }
  return stripTags(match[1] as string).trim();
}

function excerptFromHtml(contentHtml: string, maxLength = 118) {
  const text = stripTags(
    contentHtml
      .replace(/<(p|div|section|br|h[1-6])\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return undefined;
  }
  // 预留 1 个字符给省略号，保证截断结果不超过微信 digest 的 120 字上限
  const chars = Array.from(text);
  const limit = Math.min(maxLength, Math.max(appConfig.wechatDigestMaxChars - 1, 1));
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : text;
}

function stripTags(html: string) {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ""));
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function readOptionalString(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isFile(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
