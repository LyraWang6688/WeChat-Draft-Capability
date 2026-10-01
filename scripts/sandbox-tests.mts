/**
 * MCP_ALLOWED_ROOTS 沙箱逃逸测试。
 *
 * 这组测试专门针对「只用字符串前缀比较」会漏掉的绕过路径：
 *   1. 允许目录内的符号链接指向外部
 *   2. coverImagePath 指向允许目录之外
 *   3. 正文图片 src 用 ../ 逃逸
 *   4. meta.json 的 cover 指向允许目录之外
 *   5. 目录前缀相似的兄弟目录（/a/b vs /a/bc）
 *
 * 用法：node --import tsx scripts/sandbox-tests.mts
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadArticleHtmlDocument, resolveInsideAllowedRoots } from "../src/services/articleHtml.service.js";
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

/** 记录被调用的素材上传，避免真的发请求 */
function makeFakeWechat() {
  const uploaded: string[] = [];
  return {
    uploaded,
    service: {
      // 封面走永久素材
      async uploadPermanentImage(input: { filePath?: string; fileName?: string }) {
        uploaded.push(input.filePath ?? input.fileName ?? "unknown");
        return { mediaId: `fake-material-${uploaded.length}`, url: `https://wx/fake-${uploaded.length}.png` };
      },
      // 正文图片走 uploadimg
      async uploadArticleImage(input: { filePath?: string; fileName?: string }) {
        uploaded.push(input.filePath ?? input.fileName ?? "unknown");
        return { url: `https://wx/uploadimg-${uploaded.length}.png`, via: "uploadimg" as const };
      },
      async addDraftArticle() {
        return { mediaId: "fake-draft-1" };
      }
    }
  };
}

async function main() {
  const base = await mkdtemp(path.join(tmpdir(), "mcp-sandbox-"));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  const sibling = path.join(base, "allowed-evil");

  await mkdir(path.join(allowed, "images"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(sibling, { recursive: true });

  process.env.MCP_ALLOWED_ROOTS = allowed;

  try {
    await writeFile(path.join(outside, "secret.png"), "outside-secret-bytes", "utf8");
    await writeFile(path.join(outside, "secret.html"), "<body><h1>越界</h1></body>", "utf8");
    await writeFile(path.join(sibling, "x.html"), "<body><h1>兄弟目录</h1></body>", "utf8");
    await writeFile(path.join(allowed, "images", "ok.png"), "ok-bytes", "utf8");
    await writeFile(path.join(allowed, "cover.png"), "cover-bytes", "utf8");
    // 符号链接：文件名在允许目录内，但真实文件在外部
    await symlink(path.join(outside, "secret.html"), path.join(allowed, "link.html"));
    await symlink(path.join(outside, "secret.png"), path.join(allowed, "images", "link.png"));

    section("[1] 基础边界比较");
    const okPath = await resolveInsideAllowedRoots(path.join(allowed, "article.html"));
    check(okPath.startsWith(allowed), "允许目录内的路径放行", okPath);

    let rejected = false;
    try {
      await resolveInsideAllowedRoots(path.join(outside, "secret.html"));
    } catch (error) {
      rejected = error instanceof Error && "code" in error && error.code === "ARTICLE_PATH_NOT_ALLOWED";
    }
    check(rejected, "允许目录外的路径被拒绝");

    // /a/b 不应放行 /a/bc —— 这是前缀比较最容易踩的坑
    let siblingRejected = false;
    try {
      await resolveInsideAllowedRoots(path.join(sibling, "x.html"));
    } catch (error) {
      siblingRejected = error instanceof Error && "code" in error && error.code === "ARTICLE_PATH_NOT_ALLOWED";
    }
    check(siblingRejected, "前缀相似的兄弟目录被拒绝（/allowed vs /allowed-evil）");

    let dotdotRejected = false;
    try {
      await resolveInsideAllowedRoots(path.join(allowed, "..", "outside", "secret.html"));
    } catch (error) {
      dotdotRejected = error instanceof Error && "code" in error && error.code === "ARTICLE_PATH_NOT_ALLOWED";
    }
    check(dotdotRejected, ".. 序列被拒绝");

    section("[2] 符号链接逃逸（D2a）");
    let symlinkRejected = false;
    try {
      await loadArticleHtmlDocument(path.join(allowed, "link.html"));
    } catch (error) {
      symlinkRejected = error instanceof Error && "code" in error && error.code === "ARTICLE_PATH_NOT_ALLOWED";
    }
    check(symlinkRejected, "允许目录内指向外部的符号链接被拒绝（不能读到 /etc/hosts 之类）");

    section("[3] meta.json cover 越界（D2d）");
    // 该子目录里没有任何合法封面/本地图片，因此越界封面被拒后应「无封面 + 告警」
    const metaDir = path.join(allowed, "meta-case");
    await mkdir(metaDir, { recursive: true });
    await writeFile(
      path.join(metaDir, "article.html"),
      "<body><h1>标题</h1><p>正文。</p></body>",
      "utf8"
    );
    await writeFile(
      path.join(metaDir, "meta.json"),
      JSON.stringify({ title: "标题", cover: path.join(outside, "secret.png") }),
      "utf8"
    );
    const metaDoc = await loadArticleHtmlDocument(path.join(metaDir, "article.html"));
    check(
      metaDoc.coverCandidate === undefined,
      "meta.json 指向允许目录外的封面被忽略",
      metaDoc.coverCandidate
    );
    check(
      metaDoc.warnings.some((w) => w.includes("封面")),
      "越界封面会产生「缺少封面」告警，而不是静默使用",
      metaDoc.warnings
    );
    check(
      !metaDoc.inlineImages.some((i) => i.src.includes("secret")),
      "越界路径没有被当作正文图片收集"
    );

    section("[3b] 越界封面被拒后回退到目录内合法封面");
    await writeFile(
      path.join(allowed, "article.html"),
      "<body><h1>标题</h1><p>正文。</p></body>",
      "utf8"
    );
    await writeFile(
      path.join(allowed, "meta.json"),
      JSON.stringify({ title: "标题", cover: path.join(outside, "secret.png") }),
      "utf8"
    );
    const fallbackDoc = await loadArticleHtmlDocument(path.join(allowed, "article.html"));
    check(
      fallbackDoc.coverCandidate === path.join(allowed, "cover.png"),
      "越界封面被拒后回退到目录内的 cover.png（不会因此没有封面）",
      fallbackDoc.coverCandidate
    );

    section("[4] coverImagePath 越界（D2b）");
    await rm(path.join(allowed, "meta.json"), { force: true });
    await writeFile(
      path.join(allowed, "article.html"),
      '<body><h1>标题</h1><p>正文。</p></body>',
      "utf8"
    );
    const fake = makeFakeWechat();
    const publisher = new ArticlePublishService(fake.service as never);
    let coverRejected = false;
    try {
      await publisher.publishArticle({
        path: path.join(allowed, "article.html"),
        coverImagePath: path.join(outside, "secret.png"),
        credentials: { appId: "x", appSecret: "y" }
      });
    } catch (error) {
      coverRejected = error instanceof Error && "code" in error && error.code === "COVER_PATH_NOT_ALLOWED";
    }
    check(coverRejected, "coverImagePath 指向允许目录外被拒绝");
    check(fake.uploaded.length === 0, "越界封面没有被上传为素材", fake.uploaded);

    section("[5] 正文图片 src 用 ../ 逃逸（D2c）");
    await writeFile(
      path.join(allowed, "article.html"),
      '<body><h1>标题</h1><p>正文。</p>'
        + '<img src="cover.png">'
        + '<img src="../outside/secret.png">'
        + "</body>",
      "utf8"
    );
    const fake2 = makeFakeWechat();
    const publisher2 = new ArticlePublishService(fake2.service as never);
    const result = await publisher2.publishArticle({
      path: path.join(allowed, "article.html"),
      credentials: { appId: "x", appSecret: "y" }
    });
    check(
      !fake2.uploaded.some((item) => item.includes("secret.png")),
      "越界的正文图片没有被上传",
      fake2.uploaded
    );
    check(
      result.images.inline.skipped.some((item) => item.reason.includes("MCP_ALLOWED_ROOTS")),
      "越界的正文图片被记录到 skipped 并说明原因",
      result.images.inline.skipped
    );
    check(result.ok === true, "越界图片不阻断整篇上传（跳过而非失败）");

    section("[6] 允许目录内的图片正常上传（不能误杀）");
    check(
      fake2.uploaded.some((item) => item.includes("cover.png")),
      "允许目录内的图片正常上传",
      fake2.uploaded
    );
    check(result.images.inline.uploaded.length >= 1, "至少一张允许目录内图片进入 uploaded", result.images.inline.uploaded.length);
  } finally {
    delete process.env.MCP_ALLOWED_ROOTS;
    await rm(base, { recursive: true, force: true });
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
  console.error("沙箱测试异常:", error);
  process.exit(1);
});
