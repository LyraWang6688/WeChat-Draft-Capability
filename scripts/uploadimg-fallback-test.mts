/**
 * media/uploadimg 失败时的回退路径测试。
 *
 * 官方要求正文图片走 media/uploadimg，但该接口只支持 jpg/png 且小于 1MB，
 * 也可能因账号权限失败。此时必须自动回退永久素材，保证正文图片不丢。
 *
 * 用法：node --import tsx scripts/uploadimg-fallback-test.mts
 */
process.env.WECHAT_API_BASE = process.env.WECHAT_API_BASE || "http://127.0.0.1:8798";

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MOCK_PORT = 8798;
process.env.WECHAT_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;

const { ArticlePublishService } = await import("../src/services/articlePublish.service.js");
const { WechatService } = await import("../src/services/wechat.service.js");
const { appConfig } = await import("../src/config.js");

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
    console.log(`      实际: ${typeof actual === "string" ? actual : JSON.stringify(actual, null, 2)}`);
  }
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

async function waitForPort(port: number, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cgi-bin/token?grant_type=client_credential&a=1&b=2`);
      if (response.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`mock 端口 ${port} 未就绪`);
}

async function main() {
  console.log(`\nWECHAT_API_BASE = ${appConfig.wechatApiBase}`);

  // 用 MOCK_FAIL_UPLOADIMG=1 启动替身，让 uploadimg 返回错误码
  const mock = spawn(
    process.execPath,
    [path.join(process.cwd(), "scripts", "mock-wechat-server.mjs"), "--port", String(MOCK_PORT)],
    {
      cwd: process.cwd(),
      env: { ...process.env, MOCK_FAIL_UPLOADIMG: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  mock.stderr.on("data", () => {});
  await waitForPort(MOCK_PORT);

  const root = await mkdtemp(path.join(tmpdir(), "uploadimg-fallback-"));
  try {
    await mkdir(path.join(root, "images"), { recursive: true });
    await writeFile(path.join(root, "images", "cover.png"), PNG);
    await writeFile(path.join(root, "images", "body.png"), PNG);
    await writeFile(
      path.join(root, "article.html"),
      '<body><h1>回退测试</h1><p>正文。</p><img src="images/body.png"></body>',
      "utf8"
    );

    console.log("\n[1] uploadimg 失败时应回退永久素材，且正文图片仍可用");
    const wechat = new WechatService();
    const service = new ArticlePublishService(wechat);
    const result = await service.publishArticle({
      path: path.join(root, "article.html"),
      credentials: { appId: "wxfallback", appSecret: "secret" }
    });

    check(result.ok === true, "上传整体成功（不因 uploadimg 失败而中断）");
    check(result.draftMediaId.startsWith("mock-draft-"), "草稿已创建", result.draftMediaId);
    check(result.images.inline.uploaded.length === 1, "1 张正文图片进入 uploaded", result.images.inline.uploaded.length);

    const entry = result.images.inline.uploaded[0];
    check(entry?.via === "material", "标记为回退到永久素材（via=material）", entry?.via);
    check(
      typeof entry?.note === "string" && entry.note.length > 0,
      "给出回退说明，而不是静默降级",
      entry?.note
    );
    check(entry?.url === undefined || !String(entry.url).includes("uploadimg"), "URL 不是 uploadimg 的", entry?.url);

    console.log("\n[2] 回退后正文图片链接仍被正确替换");
    check(
      result.content.htmlBytes > 0,
      "正文体积已计算"
    );
    // 直接读 mock 记录的 draft payload 校验
    const { readFile } = await import("node:fs/promises");
    const draft = JSON.parse(
      await readFile(path.join(process.cwd(), ".data", "mock-last-draft.json"), "utf8")
    );
    const content = draft.payload.articles[0].content as string;
    check(
      content.includes("https://mmbiz.qpic.cn/mock/mock-material-2.png"),
      "正文里的图片已替换为永久素材 URL（封面先占用了 material-1）",
      content
    );
    check(!content.includes("images/body.png"), "原始相对路径已不存在于正文", content);
    check(
      draft.payload.articles[0].thumb_media_id === "mock-material-1",
      "封面仍使用永久素材 media_id",
      draft.payload.articles[0].thumb_media_id
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    mock.kill("SIGTERM");
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
  console.error("回退测试异常:", error);
  process.exit(1);
});
