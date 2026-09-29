import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GITHUB_TOKEN = "gh_test_token_123456";
const WEBHOOK_TOKEN = "publisher_test_token_123456";
const WECHAT_APP_ID = "wx_test_appid_123";
const WECHAT_APP_SECRET = "wx_test_secret_123456";
const WECHAT_ACCESS_TOKEN = "wechat_access_token_test";

const ARTICLE_ID = "2026-09-29-ai-tools";
const SOURCE_COMMIT = "abc123def456";
const REPOSITORY = "LyraWang6688/yaai-content-hub";
const BASE = `articles/2026/${ARTICLE_ID}`;

type FixtureOptions = {
  meta?: unknown;
  assets?: unknown;
  contentHtml?: string;
  cover?: Buffer | null;
};

function buildFiles(options: FixtureOptions = {}) {
  const files = new Map<string, Buffer>();
  files.set(
    `${BASE}/meta.json`,
    Buffer.from(JSON.stringify(options.meta ?? defaultMeta()), "utf8")
  );
  files.set(`${BASE}/content.html`, Buffer.from(options.contentHtml ?? "<h1>Hello</h1><p>正文内容</p>", "utf8"));
  files.set(`${BASE}/assets.json`, Buffer.from(JSON.stringify(options.assets ?? defaultAssets()), "utf8"));
  if (options.cover !== null) {
    files.set(`${BASE}/assets/cover.jpg`, options.cover ?? Buffer.from("fake-jpeg-cover-bytes", "utf8"));
  }
  return files;
}

function defaultMeta() {
  return {
    schema_version: 1,
    article_id: ARTICLE_ID,
    title: "测试文章标题",
    author: "Lyra Wang",
    created_at: "2026-09-29",
    updated_at: "2026-09-29",
    status: "ready_to_upload",
    source_file: "source.md",
    content_file: "content.html",
    assets_file: "assets.json"
  };
}

function defaultAssets() {
  return {
    schema_version: 1,
    cover: { path: "assets/cover.jpg", required: true },
    body_images: []
  };
}

type MockOptions = {
  githubNetworkError?: boolean;
  wechatDraftError?: boolean;
  /** 模拟上游响应延迟（毫秒），用于构造并发窗口，保证第二个请求在第一个执行完成前进入 */
  delayMs?: number;
};

function createMockFetch(files: Map<string, Buffer>, options: MockOptions = {}) {
  const delay = () => (options.delayMs ? new Promise((resolve) => setTimeout(resolve, options.delayMs)) : Promise.resolve());
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const href = String(input);
    if (href.includes("api.github.com")) {
      githubCalls.push(href);
      if (options.githubNetworkError) {
        throw new TypeError("fetch failed");
      }
      await delay();
      const filePath = extractGithubPath(href);
      const file = files.get(filePath);
      if (!file) {
        return jsonResponse(404, { message: "Not Found" });
      }
      return jsonResponse(200, {
        type: "file",
        encoding: "base64",
        content: file.toString("base64"),
        name: filePath.split("/").pop(),
        size: file.length,
        sha: `sha-${filePath}`
      });
    }
    if (href.includes("api.weixin.qq.com")) {
      wechatCalls.push(href);
      await delay();
      if (href.includes("/cgi-bin/token")) {
        return jsonResponse(200, { access_token: WECHAT_ACCESS_TOKEN, expires_in: 7200 });
      }
      if (href.includes("/cgi-bin/material/add_material")) {
        return jsonResponse(200, { media_id: "material_test_1", url: "https://mmbiz.qpic.cn/test" });
      }
      if (href.includes("/cgi-bin/draft/add")) {
        if (options.wechatDraftError) {
          return jsonResponse(200, { errcode: -1, errmsg: "system error" });
        }
        return jsonResponse(200, { media_id: "draft_test_1" });
      }
      return jsonResponse(404, {});
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };
}

function extractGithubPath(href: string) {
  const url = new URL(href);
  const marker = "/contents/";
  const index = url.pathname.indexOf(marker);
  if (index === -1) {
    throw new Error(`unexpected github url: ${href}`);
  }
  return decodeURIComponent(url.pathname.slice(index + marker.length));
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers()
  } as unknown as Response;
}

let server: Server | undefined;
let baseUrl = "";
let stateDir = "";
let originalEnv: Record<string, string | undefined> = {};
let githubCalls: string[] = [];
let wechatCalls: string[] = [];

// 测试自身发出的 HTTP 请求必须使用原生 fetch；vi.stubGlobal 只影响被测代码的全局 fetch。
const nativeFetch = globalThis.fetch;

const ENV_KEYS = [
  "GITHUB_CONTENT_TOKEN",
  "PUBLISHER_WEBHOOK_TOKEN",
  "WECHAT_APP_ID",
  "WECHAT_APP_SECRET",
  "PUBLISHER_STATE_FILE"
] as const;

async function bootApp(files: Map<string, Buffer>, mockOptions: MockOptions = {}) {
  githubCalls = [];
  wechatCalls = [];
  stateDir = mkdtempSync(path.join(os.tmpdir(), "publisher-test-"));
  vi.resetModules();
  vi.stubGlobal("fetch", createMockFetch(files, mockOptions));
  process.env.GITHUB_CONTENT_TOKEN = GITHUB_TOKEN;
  process.env.PUBLISHER_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  process.env.WECHAT_APP_ID = WECHAT_APP_ID;
  process.env.WECHAT_APP_SECRET = WECHAT_APP_SECRET;
  process.env.PUBLISHER_STATE_FILE = path.join(stateDir, "publisher-state.json");
  const { createApp } = await import("../app.js");
  const app = createApp();
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function requestBody() {
  return {
    repository: REPOSITORY,
    article_id: ARTICLE_ID,
    ref: "main",
    source_commit: SOURCE_COMMIT
  };
}

async function postDraft(authorization?: string, body?: unknown) {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return nativeFetch(`${baseUrl}/api/publisher/drafts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? requestBody())
  });
}

beforeEach(() => {
  ENV_KEYS.forEach((key) => {
    originalEnv[key] = process.env[key];
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  if (server) {
    server.close();
    server = undefined;
  }
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
  ENV_KEYS.forEach((key) => {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
    delete originalEnv[key];
  });
});

describe("POST /api/publisher/drafts", () => {
  it("1. 未认证请求返回稳定 401", async () => {
    await bootApp(buildFiles());
    const noToken = await postDraft(undefined);
    expect(noToken.status).toBe(401);
    const body = (await noToken.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.retryable).toBe(false);

    const wrongToken = await postDraft(`Bearer wrong_token_999999`);
    expect(wrongToken.status).toBe(401);
    const wrongBody = (await wrongToken.json()) as { error: { code: string; retryable: boolean } };
    expect(wrongBody.error.code).toBe("UNAUTHORIZED");
    expect(wrongBody.error.retryable).toBe(false);
  });

  it("2. Article 不存在（GitHub 404）返回 ARTICLE_NOT_FOUND 且可重试", async () => {
    const files = buildFiles();
    files.delete(`${BASE}/meta.json`);
    await bootApp(files);
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe("ARTICLE_NOT_FOUND");
    expect(body.error.retryable).toBe(true);
  });

  it("3. meta.status 非 ready_to_upload 返回 ARTICLE_NOT_READY，且重复调用快速失败", async () => {
    const meta = { ...defaultMeta(), status: "draft" };
    const files = buildFiles({ meta });
    await bootApp(files);

    const first = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(first.status).toBe(422);
    const firstBody = (await first.json()) as { error: { code: string; retryable: boolean } };
    expect(firstBody.error.code).toBe("ARTICLE_NOT_READY");
    expect(firstBody.error.retryable).toBe(false);

    // 同一 article + commit 的不可重试失败：第二次直接快速返回，不再拉取 GitHub
    const githubCallsAfterFirst = githubCalls.length;
    const second = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(second.status).toBe(422);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe("ARTICLE_NOT_READY");
    expect(githubCalls.length).toBe(githubCallsAfterFirst);
  });

  it("4. cover 不存在返回 COVER_MISSING 且不可重试", async () => {
    const files = buildFiles({ cover: null });
    await bootApp(files);
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("COVER_MISSING");
    expect(body.error.retryable).toBe(false);
  });

  it("5. 正常创建微信草稿返回成功契约", async () => {
    await bootApp(buildFiles());
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        article_id: string;
        status: string;
        source_commit: string;
        wechat_draft_media_id: string;
        uploaded_at: string;
        idempotent_replay: boolean;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.article_id).toBe(ARTICLE_ID);
    expect(body.data.status).toBe("uploaded_to_wechat");
    expect(body.data.source_commit).toBe(SOURCE_COMMIT);
    expect(body.data.wechat_draft_media_id).toBe("draft_test_1");
    expect(body.data.idempotent_replay).toBe(false);
    expect(body.data.uploaded_at).toBeTruthy();

    const draftCalls = wechatCalls.filter((url) => url.includes("/cgi-bin/draft/add"));
    expect(draftCalls).toHaveLength(1);
  });

  it("6. 同一 article + source_commit 重复调用返回幂等结果且不重复建草稿", async () => {
    await bootApp(buildFiles());
    const first = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    const firstBody = (await first.json()) as { data: { wechat_draft_media_id: string; idempotent_replay: boolean } };
    expect(firstBody.data.idempotent_replay).toBe(false);

    const second = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { wechat_draft_media_id: string; idempotent_replay: boolean };
    };
    expect(secondBody.data.idempotent_replay).toBe(true);
    expect(secondBody.data.wechat_draft_media_id).toBe(firstBody.data.wechat_draft_media_id);

    const draftCalls = wechatCalls.filter((url) => url.includes("/cgi-bin/draft/add"));
    expect(draftCalls).toHaveLength(1);
  });

  it("7. GitHub 请求失败返回 GITHUB_NETWORK_ERROR 且可重试", async () => {
    await bootApp(buildFiles(), { githubNetworkError: true });
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("GITHUB_NETWORK_ERROR");
    expect(body.error.retryable).toBe(true);
  });

  it("8. 微信草稿失败返回 WECHAT_DRAFT_ADD_FAILED，且可重试调用会重新尝试", async () => {
    await bootApp(buildFiles(), { wechatDraftError: true });
    const first = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(first.status).toBe(502);
    const firstBody = (await first.json()) as { error: { code: string; retryable: boolean } };
    expect(firstBody.error.code).toBe("WECHAT_DRAFT_ADD_FAILED");
    expect(firstBody.error.retryable).toBe(true);

    const draftCallsAfterFirst = wechatCalls.filter((url) => url.includes("/cgi-bin/draft/add")).length;
    const second = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(second.status).toBe(502);
    const draftCallsAfterSecond = wechatCalls.filter((url) => url.includes("/cgi-bin/draft/add")).length;
    // retryable 失败：第二次调用会重新尝试，而不是快速失败
    expect(draftCallsAfterSecond).toBe(draftCallsAfterFirst + 1);
  });

  it("9. Secret 不出现在日志或返回值", async () => {
    const logLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });

    await bootApp(buildFiles());

    // 成功调用
    const success = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    const successText = await success.text();
    // 失败调用（GitHub 网络错误）
    vi.stubGlobal("fetch", createMockFetch(buildFiles(), { githubNetworkError: true }));
    const failure = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    const failureText = await failure.text();

    const secrets = [GITHUB_TOKEN, WECHAT_APP_SECRET, WEBHOOK_TOKEN, WECHAT_ACCESS_TOKEN];
    const allOutput = [...logLines, successText, failureText].join("\n");
    secrets.forEach((secret) => {
      expect(allOutput).not.toContain(secret);
    });
  });

  it("10. 并发重复请求只创建一个微信草稿（Promise.all 双请求结果一致）", async () => {
    // 给上游 mock 增加延迟，确保两个请求在第一个执行完成前都进入服务，命中 in-flight 合并
    await bootApp(buildFiles(), { delayMs: 20 });

    const [firstResponse, secondResponse] = await Promise.all([
      postDraft(`Bearer ${WEBHOOK_TOKEN}`),
      postDraft(`Bearer ${WEBHOOK_TOKEN}`)
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstBody = (await firstResponse.json()) as {
      data: { wechat_draft_media_id: string; idempotent_replay: boolean };
    };
    const secondBody = (await secondResponse.json()) as {
      data: { wechat_draft_media_id: string; idempotent_replay: boolean };
    };

    // 两个请求得到一致的草稿结果
    expect(firstBody.data.wechat_draft_media_id).toBe("draft_test_1");
    expect(secondBody.data.wechat_draft_media_id).toBe(firstBody.data.wechat_draft_media_id);
    // 一个请求执行上传（false），另一个等待并复用首个结果（true）
    const replays = [firstBody.data.idempotent_replay, secondBody.data.idempotent_replay].sort();
    expect(replays).toEqual([false, true]);

    // 微信 draft/add 只调用一次
    const draftCalls = wechatCalls.filter((url) => url.includes("/cgi-bin/draft/add"));
    expect(draftCalls).toHaveLength(1);
  });

  it("11. 非白名单 Content Repository 返回 403 FORBIDDEN_REPOSITORY，且不触发上游调用", async () => {
    await bootApp(buildFiles());
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`, {
      ...requestBody(),
      repository: "someone-else/unknown-repo"
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("FORBIDDEN_REPOSITORY");
    expect(body.error.retryable).toBe(false);
    // 白名单校验在任何 GitHub / 微信调用之前
    expect(githubCalls).toHaveLength(0);
    expect(wechatCalls).toHaveLength(0);
  });

  it("12. assets.schema_version 非 1 返回 ARTICLE_SCHEMA_INVALID 且不可重试", async () => {
    const assets = { ...defaultAssets(), schema_version: 2 };
    const files = buildFiles({ assets });
    await bootApp(files);
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("ARTICLE_SCHEMA_INVALID");
    expect(body.error.retryable).toBe(false);
  });

  it("13. cover.required 为 false 违反 MVP 封面必需约束，返回 COVER_MISSING", async () => {
    const assets = { ...defaultAssets(), cover: { path: "assets/cover.jpg", required: false } };
    const files = buildFiles({ assets });
    await bootApp(files);
    const response = await postDraft(`Bearer ${WEBHOOK_TOKEN}`);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("COVER_MISSING");
    expect(body.error.retryable).toBe(false);
  });
});
