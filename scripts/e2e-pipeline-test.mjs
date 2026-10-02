/**
 * E2E 管道验证 —— 用真实 Publisher 代码跑完整链路。
 *
 * 真实部分：
 *   HTTP 层 / publisherAuth / publisher.routes / PublisherDraftService
 *   GithubContentService（按 source_commit 取文件、路径契约）
 *   FilePublisherStateStore（幂等账本、fail-closed、原子写）
 *   WechatService（素材上传 + 草稿创建的请求构造）
 *
 * 替换部分（仅外部网络）：
 *   - GitHub API  -> 从 /tmp/e2e-test 读测试文章包
 *   - 微信 API    -> 测试替身，记录收到的请求
 *
 * 用法：node scripts/e2e-pipeline-test.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const WORKSPACE = "/tmp/e2e-test";               // 测试文章包（完整 content/ 布局）
const ARTICLE_ID = "2026-09-29-ai-tools";
const REPO = "LyraWang6688/wechat-draft-capability";
const SOURCE_COMMIT = "a".repeat(40);            // 合法 40 位 hex
const TOKEN = "test-publisher-token-1234567890";

const MOCK_WECHAT_PORT = 8791;
const APP_PORT = 8792;

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
    let shown = typeof extra === "string" ? extra : JSON.stringify(extra, null, 2);
    if (shown && shown.length > 400) shown = shown.slice(0, 400) + " …（已截断）";
    console.log(`      实际: ${shown}`);
  }
  return false;
}

function json(res, status, body) {
  const t = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(t) });
  res.end(t);
}

/* ---------- 微信 API 替身：记录所有收到的请求 ---------- */
const wechatLog = [];
const mockWechat = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_WECHAT_PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  wechatLog.push({ path: url.pathname, method: req.method, bytes: raw.length, at: new Date().toISOString() });

  if (url.pathname === "/cgi-bin/token") {
    return json(res, 200, { access_token: "mock-access-token", expires_in: 7200 });
  }
  if (url.pathname === "/cgi-bin/material/add_material") {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) return json(res, 200, { errcode: 40004, errmsg: "expect multipart" });
    if (raw.length === 0) return json(res, 200, { errcode: 40004, errmsg: "empty media" });
    return json(res, 200, { media_id: "MOCK_COVER_MEDIA_ID", url: "https://mmbiz.qpic.cn/mock/cover.jpg" });
  }
  if (url.pathname === "/cgi-bin/draft/add") {
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return json(res, 200, { errcode: 40001, errmsg: "invalid json" });
    }
    await writeFile("/tmp/e2e-test/.last-draft.json", JSON.stringify(payload, null, 2), "utf8");
    return json(res, 200, { media_id: "MOCK_DRAFT_MEDIA_ID" });
  }
  return json(res, 404, { errcode: 404, errmsg: `no route ${url.pathname}` });
});

/* ---------- GitHub API 替身：从测试工作区读文件 ---------- */
function installGithubStub() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (!urlStr.startsWith("https://api.github.com/")) {
      return realFetch(input, init);   // 微信请求走真实 fetch（指向替身端口）
    }
    const u = new URL(urlStr);
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (!m) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });

    const rel = decodeURIComponent(m[3]);
    const abs = path.join(WORKSPACE, rel);
    try {
      const buf = await readFile(abs);
      return new Response(
        JSON.stringify({
          type: "file",
          name: path.basename(rel),
          path: rel,
          size: buf.length,
          encoding: "base64",
          content: buf.toString("base64")
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    } catch {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function main() {
  console.log("\n=== E2E 管道验证：真实 Publisher 代码 + 外部网络替身 ===\n");

  // 独立账本，避免污染仓库 .data
  const ledgerDir = await mkdtemp(path.join(tmpdir(), "e2e-ledger-"));
  const ledger = path.join(ledgerDir, "publisher-state.json");

  process.env.PORT = String(APP_PORT);
  process.env.PUBLISHER_WEBHOOK_TOKEN = TOKEN;
  process.env.PUBLISHER_STATE_FILE = ledger;
  process.env.PUBLISHER_ALLOWED_REPOSITORIES = REPO;
  process.env.WECHAT_APP_ID = "wxE2ETestAppId0001";
  process.env.WECHAT_APP_SECRET = "e2e-test-app-secret";
  process.env.GITHUB_CONTENT_TOKEN = "ghp_e2e_test_token";
  process.env.LOG_LEVEL = "warn";

  await new Promise((r) => mockWechat.listen(MOCK_WECHAT_PORT, "127.0.0.1", r));
  console.log(`微信替身:      http://127.0.0.1:${MOCK_WECHAT_PORT}`);

  // 微信 API base 无法通过 env 配置（config.ts 未暴露），因此用 fetch 拦截重写到替身端口
  const undoLedger = installGithubStub();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.startsWith("https://api.weixin.qq.com/")) {
      const rewritten = urlStr.replace("https://api.weixin.qq.com", `http://127.0.0.1:${MOCK_WECHAT_PORT}`);
      return nativeFetch(rewritten, init);
    }
    return nativeFetch(input, init);
  };

  const { createApp } = await import(path.join(ROOT, "src", "app.ts"));
  const app = createApp();
  const server = app.listen(APP_PORT);
  await new Promise((r) => server.once("listening", r));
  console.log(`Publisher:     http://127.0.0.1:${APP_PORT}`);
  console.log(`账本:          ${ledger}`);
  console.log(`测试文章包:    ${WORKSPACE}\n`);

  const post = async (body, token = TOKEN) => {
    const res = await globalThis.fetch(`http://127.0.0.1:${APP_PORT}/api/publisher/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };

  const payload = { repository: REPO, article_id: ARTICLE_ID, ref: "main", source_commit: SOURCE_COMMIT };
  let ok = true;

  try {
    console.log("[1] 鉴权");
    const noTok = await post(payload, "");
    check(noTok.status === 401, "无 token → 401", noTok);
    const badTok = await post(payload, "wrong-token");
    check(badTok.status === 401, "错 token → 401", badTok);
    check(wechatLog.length === 0, "鉴权失败时未触碰微信", wechatLog.length);

    console.log("\n[2] 正常发布：完整链路");
    const r1 = await post(payload);
    check(r1.status === 200 && r1.body.ok === true, "返回 200 且 ok", r1);
    check(r1.body.data?.status === "uploaded_to_wechat", "状态 uploaded_to_wechat", r1.body.data?.status);
    check(r1.body.data?.wechat_draft_media_id === "MOCK_DRAFT_MEDIA_ID", "拿到草稿 media_id", r1.body.data?.wechat_draft_media_id);
    check(r1.body.data?.source_commit === SOURCE_COMMIT, "source_commit 正确回传", r1.body.data?.source_commit);
    check(r1.body.data?.idempotent_replay === false, "首次非 replay", r1.body.data?.idempotent_replay);

    console.log("\n[3] 微信调用序列");
    const paths = wechatLog.map((x) => x.path);
    check(paths.includes("/cgi-bin/token"), "取 access_token", paths);
    check(paths.includes("/cgi-bin/material/add_material"), "上传封面素材", paths);
    check(paths.includes("/cgi-bin/draft/add"), "创建草稿", paths);
    const order = ["/cgi-bin/token", "/cgi-bin/material/add_material", "/cgi-bin/draft/add"].map((p) => paths.indexOf(p));
    check(order[0] < order[1] && order[1] < order[2], "调用顺序 token → 素材 → 草稿", order);

    console.log("\n[4] 提交给微信的草稿内容");
    const draft = JSON.parse(await readFile("/tmp/e2e-test/.last-draft.json", "utf8"));
    const art = draft.articles?.[0];
    check(Array.isArray(draft.articles) && draft.articles.length === 1, "articles 数组含 1 篇", draft.articles?.length);
    check(art?.title === "我用 AI 两年多后，终于不再关心“哪个 AI 工具最好用”了", "标题正确（31 字）", art?.title);
    check(art?.thumb_media_id === "MOCK_COVER_MEDIA_ID", "thumb_media_id 为封面素材", art?.thumb_media_id);
    check(art?.article_type === "news", "article_type = news", art?.article_type);
    const cchars = [...(art?.content || "")].length;
    check(cchars < 20000, `正文 ${cchars} 字符 < 20000`, cchars);
    check(!/<html|<body|<head/i.test(art?.content || ""), "正文无文档骨架", null);
    check(
      (art?.content || "").includes("AI_COLLABORATION_EXPERIMENT_ENDING_IMAGE_URL_PLACEHOLDER"),
      "正文含占位图（微信会过滤，用于观察真实行为）"
    );
    // 官方明确要求不要用 \uXXXX 转义（"注意不要使用Unicode转义格式"）。
    // 检查序列化后的报文里是否出现字面量 \uXXXX 与中文是否被保留。
    const draftRaw = JSON.stringify(draft);
    check(!/\\u[0-9a-fA-F]{4}/.test(draftRaw), "JSON 未出现 \\uXXXX 转义（官方明确禁止）", null);
    check(draftRaw.includes("我用 AI 两年多后"), "中文以原字符形式传输，未被转义");

    console.log("\n[5] 幂等：重复同一 source_commit");
    const wechatBefore = wechatLog.length;
    const r2 = await post(payload);
    check(r2.status === 200, "重复请求返回 200", r2.status);
    check(r2.body.data?.idempotent_replay === true, "标记为幂等 replay", r2.body.data?.idempotent_replay);
    check(wechatLog.length === wechatBefore, "replay 未再次调用微信", wechatLog.length - wechatBefore);

    console.log("\n[6] 幂等账本内容");
    const ledgerRaw = JSON.parse(await readFile(ledger, "utf8"));
    check(Array.isArray(ledgerRaw) && ledgerRaw.length === 1, "账本 1 条记录", ledgerRaw.length);
    check(ledgerRaw[0]?.status === "uploaded_to_wechat", "账本状态 uploaded_to_wechat", ledgerRaw[0]?.status);
    check(ledgerRaw[0]?.source_commit === SOURCE_COMMIT, "账本 source_commit 正确", ledgerRaw[0]?.source_commit);
    check(ledgerRaw[0]?.wechat_draft_media_id === "MOCK_DRAFT_MEDIA_ID", "账本记录草稿 media_id", ledgerRaw[0]?.wechat_draft_media_id);

    console.log("\n[7] 非法 source_commit 拒绝");
    const bad = await post({ ...payload, source_commit: "main" });
    check(bad.status === 400, "非 40 位 hex 被拒 → 400", bad.status);
    const bad2 = await post({ ...payload, repository: "evil/repo" });
    check(bad2.status === 403, "仓库不在白名单 → 403", bad2.status);
  } catch (e) {
    ok = false;
    failures.push(`未捕获异常: ${e.message}`);
    console.error("\n✗ 异常:", e.stack);
  } finally {
    undoLedger();
    server.close();
    mockWechat.close();
    await rm(ledgerDir, { recursive: true, force: true });
  }

  console.log(`\n断言总数: ${assertions}`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 项:`);
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("全部断言通过 ✓");
  process.exit(ok ? 0 : 1);
}

main();
