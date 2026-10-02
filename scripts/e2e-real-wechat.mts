/**
 * 真实微信 E2E —— 用测试文章包走完整的「素材上传 + 创建草稿」链路。
 *
 * 真实调用：
 *   WechatService.uploadPermanentImage  -> cgi-bin/material/add_material
 *   WechatService.addDraftArticle       -> cgi-bin/draft/add
 *
 * 与主链路的唯一差异：文章包来自本地 /tmp/e2e-test（不经过 GitHub），
 * 因为仓库里的真文章仍是 draft、且正文超 2 万字符。
 *
 * 副作用（真实，非发布）：
 *   - 素材库新增 1 张图片素材
 *   - 草稿箱新增 1 条草稿
 *
 * 用法：node --import tsx scripts/e2e-real-wechat.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../src/config.js";
import { WechatService } from "../src/services/wechat.service.js";

const WORKSPACE = "/tmp/e2e-test";
const ARTICLE_ID = "2026-09-29-ai-tools";
const DIR = path.join(WORKSPACE, "content", "articles", "2026", ARTICLE_ID);

const failures = [];
let assertions = 0;

function check(cond, label, extra) {
  assertions += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  ✗ ${label}`);
  if (extra !== undefined) {
    let s = typeof extra === "string" ? extra : JSON.stringify(extra, null, 2);
    if (s && s.length > 300) s = s.slice(0, 300) + " …（截断）";
    console.log(`      ${s}`);
  }
  return false;
}

async function main() {
  console.log("\n=== 真实微信 E2E：封面素材上传 + 创建草稿 ===\n");

  const meta = JSON.parse(await readFile(path.join(DIR, "meta.json"), "utf8"));
  const assets = JSON.parse(await readFile(path.join(DIR, "assets.json"), "utf8"));
  const contentHtml = await readFile(path.join(DIR, "content.html"), "utf8");
  const coverPath = path.join(DIR, assets.cover.path);
  const coverBuf = await readFile(coverPath);

  console.log("文章包:");
  console.log(`  article_id : ${meta.article_id}`);
  console.log(`  title      : ${meta.title}`);
  console.log(`  title 字数 : ${[...meta.title].length}`);
  console.log(`  author     : ${meta.author}`);
  console.log(`  status     : ${meta.status}`);
  console.log(`  正文       : ${[...contentHtml].length} 字符 / ${Buffer.byteLength(contentHtml, "utf8")} 字节`);
  console.log(`  封面       : ${assets.cover.path} (${coverBuf.length} 字节)`);
  console.log();

  const credentials = { appId: appConfig.wechatAppId.trim(), appSecret: appConfig.wechatAppSecret.trim() };
  if (!credentials.appId || !credentials.appSecret) {
    console.error("✗ .env 缺少微信凭证");
    process.exit(1);
  }
  const wechat = new WechatService();

  console.log("[1] 上传封面到永久素材库 (cgi-bin/material/add_material)");
  let material;
  try {
    material = await wechat.uploadPermanentImage({
      credentials,
      filePath: coverPath,
      fileName: path.basename(coverPath)
    });
    check(true, "素材上传成功");
    check(Boolean(material.mediaId), "拿到 media_id");
    console.log(`      media_id = ${material.mediaId}`);
    console.log(`      url      = ${material.url ?? "(未返回)"}`);
  } catch (e) {
    check(false, "素材上传成功", e.message);
    console.log("\n✗ 素材上传失败，终止。");
    printFailures();
    return;
  }

  console.log("\n[2] 创建微信草稿 (cgi-bin/draft/add)");
  let draft;
  try {
    draft = await wechat.addDraftArticle({
      title: meta.title,
      author: meta.author,
      digest: meta.digest,
      content: contentHtml,
      thumbMediaId: material.mediaId,
      credentials
    });
    check(true, "草稿创建成功");
    check(Boolean(draft.mediaId), "拿到草稿 media_id");
    console.log(`      draft media_id = ${draft.mediaId}`);
  } catch (e) {
    check(false, "草稿创建成功", e.message);
    console.log("\n✗ 草稿创建失败。");
    printFailures();
    return;
  }

  console.log("\n[3] 结论");
  console.log(`  微信接受 ${[...meta.title].length} 字标题      : ✅`);
  console.log(`  微信接受 ${[...contentHtml].length} 字符正文    : ✅`);
  console.log(`  封面素材 + 草稿链路                          : ✅`);

  console.log(`\n断言总数: ${assertions}`);
  if (failures.length) {
    printFailures();
    process.exit(1);
  }
  console.log("全部断言通过 ✓");
  console.log("\n请在公众号后台「草稿箱」确认这条草稿。");
  console.log("注意：正文里那张结尾图仍是占位符 URL，微信会过滤，所以草稿里该处可能空白。");
}

function printFailures() {
  console.log(`失败 ${failures.length} 项:`);
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}

main().catch((e) => {
  console.error("异常:", e.stack || e.message);
  process.exit(1);
});
