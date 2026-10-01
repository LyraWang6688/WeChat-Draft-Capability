/**
 * articleHtml.service 纯函数单元测试。
 *
 * 这些是上传链路的解析与校验核心，值得单独覆盖：
 * 元数据优先级、正文骨架剥离、图片替换的边界情况、微信字段长度限制。
 *
 * 用法：npm run test:unit   （或 node --import tsx scripts/unit-tests.mts）
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifySrc,
  clampDigest,
  describeContentSize,
  extractContentHtml,
  loadArticleHtmlDocument,
  replaceImageSrc
} from "../src/services/articleHtml.service.js";
import { appConfig } from "../src/config.js";
import { redactText } from "../src/utils/redact.js";
import { ArticlePublishService } from "../src/services/articlePublish.service.js";

const failures: string[] = [];
let assertionCount = 0;

function check(condition: boolean, label: string, actual?: unknown) {
  assertionCount += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(label);
  console.log(`  ✗ ${label}`);
  if (actual !== undefined) {
    console.log(`      实际: ${typeof actual === "string" ? actual : JSON.stringify(actual)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function main() {
  section("[1] extractContentHtml：文档骨架剥离");
  check(
    extractContentHtml("<html><head><title>x</title></head><body><p>正文</p></body></html>") === "<p>正文</p>",
    "剥离 html/head/body，只留 body 内容"
  );
  check(
    extractContentHtml("<body><script>evil()</script><p>正文</p></body>") === "<p>正文</p>",
    "移除 <script>"
  );
  check(
    extractContentHtml("<body><style>.a{color:red}</style><p>正文</p></body>") === "<p>正文</p>",
    "移除 <style>"
  );
  check(extractContentHtml("<body><!-- 注释 --><p>正文</p></body>") === "<p>正文</p>", "移除 HTML 注释");
  check(
    extractContentHtml('<body><p style="color:#07c160">正文</p></body>') === '<p style="color:#07c160">正文</p>',
    "保留内联样式"
  );
  check(
    extractContentHtml("<body><IMG SRC='a.png'></body>").includes("IMG"),
    "大写标签不被破坏"
  );
  check(
    extractContentHtml("<p>没有文档骨架</p>") === "<p>没有文档骨架</p>",
    "无骨架时原样返回"
  );
  check(
    extractContentHtml("<body><script>var s = '<p>fake</p>';</script><p>真正文</p></body>") === "<p>真正文</p>",
    "script 内的 HTML 字符串不被误留"
  );

  section("[2] classifySrc：图片类型判定");
  check(classifySrc("images/a.png") === "local", "相对路径判定为 local");
  check(classifySrc("/abs/a.png") === "local", "绝对文件路径判定为 local");
  check(classifySrc("https://example.com/a.png") === "remote", "https 判定为 remote");
  check(classifySrc("//example.com/a.png") === "remote", "协议相对 URL 判定为 remote");
  check(classifySrc("http://example.com/a.png") === "remote", "http 判定为 remote");
  check(classifySrc("data:image/png;base64,AAAA") === "data-uri", "data URI 判定为 data-uri");

  section("[3] replaceImageSrc：图片替换边界");
  check(
    replaceImageSrc('<img src="a.png">', "a.png", "https://wx/x.png") === '<img src="https://wx/x.png">',
    "双引号 src 替换"
  );
  check(
    replaceImageSrc("<img src='a.png'>", "a.png", "https://wx/x.png") === '<img src="https://wx/x.png">',
    "单引号 src 替换"
  );
  check(
    replaceImageSrc('<img src="a.png"/>', "a.png", "https://wx/x.png") === '<img src="https://wx/x.png"/>',
    "自闭合标签替换"
  );
  check(
    replaceImageSrc('<img src="a.png" srcset="a.png 2x">', "a.png", "https://wx/x.png") ===
      '<img src="https://wx/x.png" srcset="a.png 2x">',
    "只替换 src 属性，不误改 srcset"
  );
  // 回归 D3：data-src / data-original 不是 src，不能被当成图片源。
  // 旧实现用 \bsrc\s*=，\b 在 "-" 后成立，会把素材 URL 写进 data-src，
  // 导致正文里真实 src 从未创建、图片不显示，而调用方收到「上传成功」。
  check(
    replaceImageSrc('<img data-src="a.png">', "a.png", "https://wx/x.png") === '<img data-src="a.png">',
    "data-src 不会被误当作 src 替换（回归 D3）"
  );
  check(
    replaceImageSrc('<img data-original="a.png">', "a.png", "https://wx/x.png") === '<img data-original="a.png">',
    "data-original 不会被误当作 src 替换"
  );
  check(
    replaceImageSrc('<img srcset="a.png 2x">', "a.png", "https://wx/x.png") === '<img srcset="a.png 2x">',
    "srcset 不会被误当作 src 替换"
  );
  check(
    replaceImageSrc('<img data-src="a.png" src="a.png">', "a.png", "https://wx/x.png") ===
      '<img data-src="a.png" src="https://wx/x.png">',
    "data-src 与 src 并存时只替换真 src，data-src 保持原样"
  );
  check(
    replaceImageSrc('<img src="a.png" data-src="b.png">', "a.png", "https://wx/x.png") ===
      '<img src="https://wx/x.png" data-src="b.png">',
    "src 在 data-src 之前时也只替换真 src"
  );
  check(
    replaceImageSrc('<p>a.png</p>', "a.png", "https://wx/x.png") === '<p>a.png</p>',
    "正文纯文本中的同名内容不会被改动"
  );
  const sameTwice = replaceImageSrc('<img src="a.png"><img src="a.png">', "a.png", "https://wx/x.png");
  check(
    (sameTwice.match(/https:\/\/wx\/x\.png/g) || []).length === 2,
    "同一 src 出现两次都被替换"
  );
  check(
    replaceImageSrc('<img src="a.png?x=1&y=2">', "a.png?x=1&y=2", "https://wx/x.png") === '<img src="https://wx/x.png">',
    "src 含正则元字符（? &）时正确替换"
  );
  check(
    replaceImageSrc('<img\n  src="a.png"\n>', "a.png", "https://wx/x.png").includes("https://wx/x.png"),
    "跨行 img 标签正确替换"
  );
  check(
    replaceImageSrc('<img src="b.png">', "a.png", "https://wx/x.png") === '<img src="b.png">',
    "不匹配时原样返回"
  );
  check(
    replaceImageSrc('<img src="a.png">', "a.png", "a.png") === '<img src="a.png">',
    "新旧值相同时不产生改动"
  );

  section("[4] describeContentSize：微信正文限制");
  const size = describeContentSize("<p>你好</p>");
  check(size.chars === 9, "字符数按码点计算（<p>=3 + 你好=2 + </p>=4）", size.chars);
  check(size.bytes === 13, "字节数按 UTF-8 计算（ASCII 7 + 中文 6 = 13）", size.bytes);
  check(size.limitChars === appConfig.wechatContentMaxChars, "limitChars 取自配置", size.limitChars);
  check(size.exceeded === false, "短正文不超限");
  const huge = "<p>" + "字".repeat(25000) + "</p>";
  const hugeSize = describeContentSize(huge);
  check(hugeSize.chars > hugeSize.limitChars, "2.5 万字符正文被判定超限", hugeSize.chars);
  check(hugeSize.exceeded === true, "超限标记为 true");
  // 关键：字节数与字符数必须分开判断。3 万字节的纯中文只有 1 万字符，
  // 若只按字节判断会误报超限；若只按字符判断会漏掉超大 ASCII 正文。
  const cjkHeavy = "<p>" + "字".repeat(9000) + "</p>";
  const cjkSize = describeContentSize(cjkHeavy);
  check(cjkSize.chars <= cjkSize.limitChars, "9000 中文字符合法", cjkSize.chars);
  check(cjkSize.bytes > 20000, "但字节数已超过 2 万，说明两条限制都要看", cjkSize.bytes);
  const emoji = describeContentSize("<p>👍👍</p>");
  // Array.from 按码点计数：👍 是单个码点，但 UTF-16 里占 2 个 code unit。
  // 实测该字符串 .length=11、码点=9、字节=15，这里断言的是码点口径。
  check(emoji.chars === 9, "emoji 按码点计数（9，而非 UTF-16 的 11）", emoji.chars);
  check(emoji.bytes === 15, "emoji 每个占 4 字节（7 + 8 = 15）", emoji.bytes);

  section("[5] clampDigest：摘要 120 字上限");
  check(clampDigest("短摘要") === "短摘要", "短摘要不变");
  check(clampDigest(undefined) === undefined, "undefined 透传");
  const longDigest = "字".repeat(150);
  const clamped = clampDigest(longDigest);
  check(Array.from(clamped || "").length === appConfig.wechatDigestMaxChars, "长摘要被截断到 120 字", Array.from(clamped || "").length);

  section("[6] loadArticleHtmlDocument：元数据优先级");
  const root = await mkdtemp(path.join(tmpdir(), "mcp-unit-"));
  try {
    await mkdir(path.join(root, "images"), { recursive: true });
    // 真实写出 images/a.png，否则「回退到第一张存在的本地图片」这条断言没有意义
    await writeFile(path.join(root, "images", "a.png"), "fake-png-bytes", "utf8");
    await writeFile(
      path.join(root, "article.html"),
      `<html><head><title>title 标签</title></head><body>
        <h1>h1 标题</h1>
        <p>第一段正文。</p>
        <img src="images/a.png"><img src="https://ext/x.png"><img src="images/missing.png">
      </body></html>`,
      "utf8"
    );

    const noMeta = await loadArticleHtmlDocument(root);
    check(noMeta.meta.title === "h1 标题", "无 meta.json 时标题取 h1", noMeta.meta.title);
    check(noMeta.meta.sources.title === "h1", "记录标题来源为 h1", noMeta.meta.sources.title);
    check(noMeta.inlineImages.length === 3, "识别 3 张正文图片", noMeta.inlineImages.length);
    check(
      noMeta.inlineImages.map((i) => i.kind).join(",") === "local,remote,local",
      "图片类型分类正确",
      noMeta.inlineImages.map((i) => i.kind)
    );
    check(noMeta.coverCandidate !== undefined, "无显式封面时回退到第一张存在的本地图片", noMeta.coverCandidate);
    check(noMeta.warnings.length === 0, "能推出封面时不产生封面告警", noMeta.warnings);

    // 没有 cover.* 命名文件、也没有任何存在的本地图片时，才应该告警
    const noCoverDir = await mkdtemp(path.join(tmpdir(), "mcp-nocover-"));
    try {
      await writeFile(
        path.join(noCoverDir, "article.html"),
        "<body><h1>标题</h1><p>正文。</p><img src=\"missing.png\"></body>",
        "utf8"
      );
      const noCover = await loadArticleHtmlDocument(noCoverDir);
      check(noCover.coverCandidate === undefined, "无可用封面时 coverCandidate 为空", noCover.coverCandidate);
      check(
        noCover.warnings.some((w) => w.includes("封面")),
        "无可用封面时给出告警",
        noCover.warnings
      );
    } finally {
      await rm(noCoverDir, { recursive: true, force: true });
    }

    await writeFile(
      path.join(root, "meta.json"),
      JSON.stringify({ title: "meta 标题", author: "作者", digest: "摘要", column: "栏目" }),
      "utf8"
    );
    const withMeta = await loadArticleHtmlDocument(root);
    check(withMeta.meta.title === "meta 标题", "meta.json 覆盖 h1", withMeta.meta.title);
    check(withMeta.meta.sources.title === "meta.json.title", "记录来源为 meta.json.title", withMeta.meta.sources.title);
    check(withMeta.metaFile !== undefined || withMeta.metaFilePath !== undefined, "记录 meta.json 路径");

    await writeFile(path.join(root, "meta.json"), "{ 这不是合法 JSON", "utf8");
    const badMeta = await loadArticleHtmlDocument(root);
    check(badMeta.meta.title === "h1 标题", "meta.json 非法时回退到 h1，不抛错", badMeta.meta.title);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  section("[7] redactText：脱敏不能泄漏密钥，也不能破坏事件名");
  const secret = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const redacted = redactText('secret=' + secret);
  check(!redacted.includes(secret), "URL query 里的 32 位密钥被完整遮住（旧实现会泄漏 24 位）", redacted);
  check(!redacted.includes(secret.slice(4, 24)), "密钥中段不泄漏", redacted);
  check(
    !redactText('https://api.weixin.qq.com/cgi-bin/token?appid=wx1&secret=' + secret).includes(secret),
    "完整 URL 中的密钥不泄漏"
  );
  // 旧实现用通用「长 token」正则，会把下划线连起来的事件名截断
  for (const event of [
    "upload_wechat_draft_failed",
    "WECHAT_DRAFT_ADD_FAILED",
    "wechat_access_token_fetch_start",
    "lark_cli_call_failed",
    "mcp_article_publish_success"
  ]) {
    check(redactText(event) === event, `事件名不被脱敏破坏：${event}`, redactText(event));
  }
  check(redactText("appid=wx1234567890") === "appid=wx1234567890", "非敏感键（appid）不被改动");

  section("[8] appConfig 微信字段限制与官方一致");
  check(appConfig.wechatTitleMaxChars === 32, "title 上限 32 字", appConfig.wechatTitleMaxChars);
  check(appConfig.wechatAuthorMaxChars === 16, "author 上限 16 字", appConfig.wechatAuthorMaxChars);
  check(appConfig.wechatDigestMaxChars === 120, "digest 上限 120 字", appConfig.wechatDigestMaxChars);
  check(appConfig.wechatContentMaxChars === 20000, "content 上限 2 万字符", appConfig.wechatContentMaxChars);

  section("[9] 微信字段上限校验（inspectArticle 的 blockingIssues）");
  {
    const limitsRoot = await mkdtemp(path.join(tmpdir(), "mcp-limits-"));
    try {
      const publisher = new ArticlePublishService({
        async uploadPermanentImage() {
          return { mediaId: "m", url: "https://wx/m.png" };
        },
        async addDraftArticle() {
          return { mediaId: "d" };
        }
      } as never);

      // 封面存在，避免「缺封面」掩盖我们要测的那条问题
      await writeFile(path.join(limitsRoot, "cover.png"), "png", "utf8");

      await writeFile(
        path.join(limitsRoot, "article.html"),
        `<body><h1>${"标".repeat(40)}</h1><p>正文。</p></body>`,
        "utf8"
      );
      const overTitle = await publisher.inspectArticle({ path: path.join(limitsRoot, "article.html") });
      check(
        overTitle.blockingIssues.some((issue) => issue.includes("标题") && issue.includes("32")),
        "标题超过 32 字被判定为阻塞问题",
        overTitle.blockingIssues
      );

      await writeFile(
        path.join(limitsRoot, "article.html"),
        `<body><h1>正常标题</h1><p>正文。</p></body>`,
        "utf8"
      );
      const overAuthor = await publisher.inspectArticle({
        path: path.join(limitsRoot, "article.html"),
        author: "作".repeat(20)
      });
      check(
        overAuthor.blockingIssues.some((issue) => issue.includes("作者") && issue.includes("16")),
        "作者超过 16 字被判定为阻塞问题",
        overAuthor.blockingIssues
      );

      const overDigest = await publisher.inspectArticle({
        path: path.join(limitsRoot, "article.html"),
        digest: "摘".repeat(200)
      });
      check(
        !overDigest.blockingIssues.some((issue) => issue.includes("摘要")),
        "超长摘要被自动截断到 120 字，不产生阻塞问题",
        overDigest.blockingIssues
      );

      // 正文超 2KB：用一个约 4KB 的正文
      await writeFile(
        path.join(limitsRoot, "article.html"),
        `<body><h1>正常标题</h1><p>${"字".repeat(2000)}</p></body>`,
        "utf8"
      );
      const overContent = await publisher.inspectArticle({ path: path.join(limitsRoot, "article.html") });
      check(
        overContent.blockingIssues.some((issue) => issue.includes("正文")),
        "正文超过 2KB 被判定为阻塞问题",
        overContent.blockingIssues
      );

      // 正常文章不应有任何阻塞问题
      await writeFile(
        path.join(limitsRoot, "article.html"),
        '<body><h1>正常标题</h1><p>一小段正文。</p></body>',
        "utf8"
      );
      const clean = await publisher.inspectArticle({ path: path.join(limitsRoot, "article.html") });
      check(clean.blockingIssues.length === 0, "合规文章没有阻塞问题", clean.blockingIssues);
    } finally {
      await rm(limitsRoot, { recursive: true, force: true });
    }
  }

  console.log(`\n断言总数: ${assertionCount}`);
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 项：`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log("全部断言通过 ✓");
}

main().catch((error) => {
  console.error("单元测试异常:", error);
  process.exit(1);
});
