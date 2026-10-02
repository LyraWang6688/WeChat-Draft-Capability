/**
 * 一次性探针：判定微信公众号 draft/add 的 content 字段真实上限。
 *
 * 背景：官方文档同一段里同时写着「大小不可超过2kb」与「必须少于2万字符，小于1M」，
 * 自相矛盾且无官方澄清。本脚本用真实凭证做受控实测，给出确定答案。
 *
 * 真实副作用（本脚本会在结束时回收）：
 *   - 素材库新增 1 张 1x1 PNG 永久素材（结束时 material/del_material 删除）
 *   - 每次成功的 draft/add 会在草稿箱新增 1 条草稿（结束时 draft/delete 删除）
 *
 * 注意：content 的字符上限恒先于字节上限生效——2 万字符最多只能撑到约 60KB 字节，
 * 所以「1M 字节上限」在实践中不可达，真正需要判定的是 2KB 是否被强制。
 *
 * 用法：PROBE_CONFIRM=yes LOG_LEVEL=error node --import tsx scripts/probe-draft-content-limit.mts
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfig } from "../src/config.js";
import { HttpError } from "../src/errors/HttpError.js";
import { WechatService } from "../src/services/wechat.service.js";

const API = "https://api.weixin.qq.com";

if (process.env.PROBE_CONFIRM !== "yes") {
  console.error("拒绝执行：这会真实调用微信 API 并在你的草稿箱创建草稿。");
  console.error("确认后请用：PROBE_CONFIRM=yes LOG_LEVEL=error node --import tsx scripts/probe-draft-content-limit.mts");
  process.exit(2);
}

const credentials = { appId: appConfig.wechatAppId.trim(), appSecret: appConfig.wechatAppSecret.trim() };
if (!credentials.appId || !credentials.appSecret) {
  console.error("✗ .env 缺少 WECHAT_APP_ID / WECHAT_APP_SECRET，无法实测");
  process.exit(1);
}

const createdDraftIds: string[] = [];
let materialMediaId: string | undefined;
let rawToken: string | undefined;
let tempDir: string | undefined;

/**
 * 封面必须用真实可裁剪的图片：1x1 PNG 会让微信返回 53402「封面裁剪失败」，
 * 从而掩盖正文超限的真实原因，导致整个探针结论失效。
 */
const COVER_PATH = path.resolve("content/articles/2026/2026-09-29-ai-tools/assets/cover.jpg");

type ProbeResult = {
  label: string;
  chars: number;
  bytes: number;
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  mediaId?: string;
};

const results: ProbeResult[] = [];

async function fetchJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { parseError: text.slice(0, 300), httpStatus: response.status } as Record<string, unknown>;
  }
}

/**
 * 构造正文填充。
 *
 * 关键：必须让「字节数」与「字符数」解耦，否则无法判定被拒的到底是 2KB 字节限制
 * 还是 2 万字符限制。ASCII 的字节/字符比是 1，中文是 3，两者合起来才能分辨。
 * 因此每个段落只放一段连续填充串，而不是「一个中文字 + 大段英文标签」。
 */
function buildContent(kind: "ascii" | "cjk", targetChars: number) {
  const unit = kind === "ascii" ? "a" : "字";
  const open = `<section style="font-size:16px;line-height:1.75;color:#333;"><p style="margin:0 0 12px;">`;
  const close = `</p></section>`;
  const fillerLength = Math.max(targetChars - open.length - close.length, 0);
  return `${open}${unit.repeat(fillerLength)}${close}`;
}

async function main() {
  console.log("=== 微信 draft/add content 上限实测 ===\n");
  console.log(`公众号 AppID：${credentials.appId.slice(0, 6)}****${credentials.appId.slice(-4)}\n`);

  // --- 0. 取 token（同时验证 IP 白名单）---
  const tokenPayload = await fetchJson(
    `${API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(credentials.appId)}&secret=${encodeURIComponent(credentials.appSecret)}`,
    { method: "GET" }
  );
  if (tokenPayload.errcode) {
    console.log(`✗ 取 access_token 失败：errcode=${tokenPayload.errcode} errmsg=${tokenPayload.errmsg}`);
    if (tokenPayload.errcode === 40164) {
      console.log("  → 本机出口 IP 不在公众号 IP 白名单内，实测无法进行。");
      console.log("     需去 微信开发者平台 → 我的业务 → 公众号 → 基础信息 → 开发信息 添加本机公网 IP。");
    }
    process.exit(1);
  }
  rawToken = tokenPayload.access_token as string;
  console.log("✓ access_token 获取成功（IP 白名单通过）\n");

  // --- 1. 上传封面素材（必须是真实可裁剪的图片，否则会得到 53402 掩盖真实原因）---
  const wechat = new WechatService();
  const coverBuffer = await readFile(COVER_PATH);
  tempDir = await mkdtemp(path.join(tmpdir(), "draft-probe-"));
  const coverPath = path.join(tempDir, "probe-cover.jpg");
  await writeFile(coverPath, coverBuffer);
  console.log(`封面：${COVER_PATH}（${coverBuffer.length} 字节）`);
  try {
    const material = await wechat.uploadPermanentImage({ credentials, filePath: coverPath, fileName: "probe-cover.jpg" });
    materialMediaId = material.mediaId;
    console.log(`✓ 封面素材已上传：media_id=${materialMediaId}\n`);
  } catch (error) {
    console.log(`✗ 封面素材上传失败：${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }

  const realArticlePath = path.resolve("content/articles/2026/2026-09-29-ai-tools/content.html");
  const realArticleHtml = await readFile(realArticlePath, "utf8");

  const probes: Array<{ label: string; content: string; note: string }> = [
    {
      label: "A 2.5KB ASCII",
      content: buildContent("ascii", 2500),
      note: "越过官方文档所写的 2KB"
    },
    {
      label: "B 60KB 中文",
      content: buildContent("cjk", 19900),
      note: "字节远超 2KB，字符数仍 < 2万"
    },
    {
      label: "C 真实文章",
      content: realArticleHtml,
      note: "仓库中那篇文章的 content.html 原文"
    },
    {
      label: "D 20100 字符 ASCII",
      content: buildContent("ascii", 20100),
      note: "越过 2 万字符上限，预期失败"
    }
  ];

  for (const probe of probes) {
    const chars = [...probe.content].length;
    const bytes = Buffer.byteLength(probe.content, "utf8");
    try {
      const draft = await wechat.addDraftArticle({
        title: `上限探针${probe.label.slice(0, 1)}`,
        author: "probe",
        digest: "",
        content: probe.content,
        thumbMediaId: materialMediaId!,
        credentials
      });
      createdDraftIds.push(draft.mediaId);
      results.push({ label: probe.label, chars, bytes, ok: true, mediaId: draft.mediaId });
      console.log(`✓ ${probe.label}：成功（${chars} 字符 / ${bytes} 字节）→ draft media_id=${draft.mediaId}`);
    } catch (error) {
      const details = error instanceof HttpError ? (error.details as Record<string, unknown> | undefined) : undefined;
      results.push({
        label: probe.label,
        chars,
        bytes,
        ok: false,
        errcode: details?.errcode as number | undefined,
        errmsg: (details?.errmsg as string | undefined) ?? (error instanceof Error ? error.message : String(error))
      });
      console.log(
        `✗ ${probe.label}：失败（${chars} 字符 / ${bytes} 字节）→ errcode=${details?.errcode ?? "n/a"} errmsg=${details?.errmsg ?? (error as Error).message}`
      );
    }
  }

  await cleanup();

  console.log("\n=== 结论 ===");
  for (const r of results) {
    console.log(
      `${r.ok ? "可通过" : "被拒绝"}  ${r.label.padEnd(18)} ${String(r.chars).padStart(6)} 字符 ${String(r.bytes).padStart(7)} 字节${r.ok ? "" : `  errcode=${r.errcode}`}`
    );
  }

  // 封面相关错误会掩盖正文超限的真实原因，必须先把这类探针排除，否则会得出错误结论
  // （上一版就因此把「封面裁剪失败」误判成了「2KB 生效」）。
  const COVER_ERROR_CODES = new Set([53402, 40007, 41005]);
  const invalid = results.filter((r) => !r.ok && r.errcode !== undefined && COVER_ERROR_CODES.has(r.errcode));
  if (invalid.length > 0) {
    console.log(`\n⚠ 有 ${invalid.length} 条探针被封面类错误（errcode 53402 等）挡住，结论不可用，需修好封面后重跑。`);
    return;
  }

  const over2kb = results.filter((r) => r.bytes > 2048);
  const over2kChars = results.filter((r) => r.chars > 20000);
  console.log(`\n2KB 字节限制是否真实生效：${over2kb.some((r) => !r.ok) ? "是" : "否（>2KB 的正文可以正常创建草稿）"}`);
  console.log(`2 万字符限制是否真实生效：${over2kChars.some((r) => !r.ok) ? "是" : "否（本次未被触发）"}`);
}

async function cleanup() {
  console.log("\n--- 回收副作用 ---");
  if (!rawToken) {
    console.log("无 token，跳过回收");
    return;
  }
  for (const mediaId of createdDraftIds) {
    const payload = await fetchJson(`${API}/cgi-bin/draft/delete?access_token=${encodeURIComponent(rawToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media_id: mediaId })
    });
    console.log(
      payload.errcode ? `  ✗ 删除草稿 ${mediaId} 失败：errcode=${payload.errcode} ${payload.errmsg}` : `  ✓ 已删除草稿 ${mediaId}`
    );
  }
  if (materialMediaId) {
    const payload = await fetchJson(`${API}/cgi-bin/material/del_material?access_token=${encodeURIComponent(rawToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media_id: materialMediaId })
    });
    console.log(
      payload.errcode
        ? `  ✗ 删除素材 ${materialMediaId} 失败：errcode=${payload.errcode} ${payload.errmsg}`
        : `  ✓ 已删除素材 ${materialMediaId}`
    );
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch(async (error) => {
  console.error("探针异常终止：", error);
  await cleanup();
  process.exit(1);
});
