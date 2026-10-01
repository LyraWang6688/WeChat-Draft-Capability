/**
 * 端到端验证：MCP stdio 服务器 + 微信 API 测试替身。
 *
 * 覆盖：
 *   1. MCP initialize / tools/list 握手
 *   2. inspect_wechat_article 预检（不调用微信接口）
 *   3. upload_wechat_draft 完整链路（封面素材 -> 正文图片替换 -> 草稿创建）
 *   4. wechat_draft_status 凭证校验
 *   5. 断言提交给微信 draft/add 的 payload 符合预期
 *
 * 用法：
 *   node scripts/mcp-e2e.mjs                # 用 tsx 直接跑 src/mcp/wechatDraftServer.ts
 *   node scripts/mcp-e2e.mjs --dist         # 跑编译产物 dist/mcp/wechatDraftServer.js
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const MOCK_PORT = 8799;
/** 由 .env 夹具提供，不是继承环境变量——用来验证「凭证取自 .env」 */
const FIXTURE_APP_ID = "wxenvfile00000001";
const FIXTURE_APP_SECRET = "secret-loaded-from-env-file";
const useDist = process.argv.includes("--dist");
const failures = [];
let assertionCount = 0;

function check(condition, label, extra) {
  assertionCount += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  ✗ ${label}`);
  if (extra !== undefined) {
    console.log(`      实际值: ${typeof extra === "string" ? extra : JSON.stringify(extra, null, 2)}`);
  }
  return false;
}

/** 1x1 PNG，避免依赖外部图片资源 */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

async function buildFixture(root) {
  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(path.join(root, "images", "cover.png"), ONE_PIXEL_PNG);
  await writeFile(path.join(root, "images", "fig1.png"), ONE_PIXEL_PNG);
  await writeFile(path.join(root, "images", "fig2.jpg"), ONE_PIXEL_PNG);

  await writeFile(
    path.join(root, "meta.json"),
    `${JSON.stringify(
      {
        title: "meta.json 里的标题",
        author: "测试作者",
        digest: "meta.json 提供的摘要",
        column: "工具炼金术",
        cover: "images/cover.png"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>这段 title 应该被 meta.json 覆盖</title>
  <style>body { margin: 0; }</style>
</head>
<body>
  <h1>HTML 里的 h1 标题</h1>
  <p style="font-size:16px;color:#333;">第一段正文，用来生成摘要。</p>
  <p><img src="images/fig1.png" style="width:100%;" /></p>
  <p><img src='images/fig2.jpg' /></p>
  <p><img src="https://example.com/remote.png" /></p>
  <p><img src="images/missing.png" /></p>
  <p><img data-src="images/lazy.png" class="lazy" alt="懒加载图" /></p>
</body>
</html>`;

  await writeFile(path.join(root, "article.html"), html, "utf8");
  return {
    articleDir: root,
    htmlPath: path.join(root, "article.html")
  };
}

/** 极简 MCP stdio 客户端：按 id 匹配响应 */
class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrText = "";
    /** stdout 上出现的、不是合法 JSON-RPC 报文的行 */
    this.stdoutPollution = [];

    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // stdout 上出现了非 JSON 内容 —— stdio 协议已被污染
          this.stdoutPollution.push(line);
          continue;
        }
        if (message.jsonrpc !== "2.0") {
          // 是合法 JSON，但不是 JSON-RPC 报文（典型情况：日志被写到了 stdout）
          this.stdoutPollution.push(line);
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
          } else {
            resolve(message.result);
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      this.stderrText += chunk.toString("utf8");
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

function parseToolText(result) {
  const textPart = (result.content || []).find((item) => item.type === "text");
  if (!textPart) {
    throw new Error(`工具返回没有 text 内容：${JSON.stringify(result)}`);
  }
  return JSON.parse(textPart.text);
}

/** 与 src/mcp/wechatDraftServer.ts 里的 maskAppId 保持一致 */
function maskAppId(appId) {
  if (appId.length <= 8) {
    return `${appId.slice(0, 2)}****`;
  }
  return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

async function main() {
  if (useDist) {
    // dist 产物可能不存在（例如刚删过 dist 又直接跑 --dist）。
    // 不预检的话，子进程会立刻退出，表现成 60 秒后一句「MCP 请求超时」，很难排查。
    const distEntry = path.join(projectRoot, "dist", "mcp", "main.js");
    try {
      await access(distEntry);
    } catch {
      console.error(`\n✗ 找不到编译产物：${distEntry}`);
      console.error("  请先执行 npm run build，或直接用 npm run mcp:e2e:dist（会先 build 再测）。\n");
      process.exit(1);
    }
  }

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mcp-wechat-e2e-"));
  const fixture = await buildFixture(fixtureRoot);

  console.log("\n[0] 准备测试替身与夹具");
  console.log(`  夹具目录: ${fixtureRoot}`);

  const mock = spawn(process.execPath, [path.join(projectRoot, "scripts", "mock-wechat-server.mjs"), "--port", String(MOCK_PORT)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  mock.stderr.on("data", (chunk) => process.stderr.write(`  [mock] ${chunk}`));
  await waitForPort(MOCK_PORT);

  const serverCommand = useDist
    ? { args: [path.join(projectRoot, "dist", "mcp", "main.js")], label: "dist/mcp/main.js" }
    : {
        args: ["--import", "tsx", path.join(projectRoot, "src", "mcp", "main.ts")],
        label: "src/mcp/main.ts"
      };

  console.log(`  MCP 入口: ${serverCommand.label}`);

  // 关键：不通过 env 注入微信凭证，而是写一个独立的 .env，
  // 用 DOTENV_CONFIG_PATH 让 dotenv 加载它。这样才真正验证了「凭证取自 .env」这条需求。
  const envFilePath = path.join(fixtureRoot, ".env");
  await writeFile(
    envFilePath,
    [
      `WECHAT_APP_ID=${FIXTURE_APP_ID}`,
      `WECHAT_APP_SECRET=${FIXTURE_APP_SECRET}`,
      `WECHAT_API_BASE=http://127.0.0.1:${MOCK_PORT}`,
      "MCP_IMAGE_STRATEGY=upload-local",
      ""
    ].join("\n"),
    "utf8"
  );
  console.log(`  .env 夹具: ${envFilePath}`);

  // 从继承环境中剔除可能存在的真实微信凭证，避免掩盖 .env 读取逻辑的缺陷
  const inheritedEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (key.startsWith("WECHAT_")) {
      delete inheritedEnv[key];
    }
  }

  // 关键：刻意不注入 MCP_LOG_TARGET，也不给 stderr 提示。
  // 真实的 MCP 客户端就是这么启动的；如果入口靠 import 之前赋值来保证 stdio 纯净，
  // 这里就会立刻暴露（stdout 被日志污染 -> 握手失败）。
  delete inheritedEnv.MCP_LOG_TARGET;

  const server = spawn(process.execPath, serverCommand.args, {
    cwd: projectRoot,
    env: {
      ...inheritedEnv,
      LOG_LEVEL: "info",
      DOTENV_CONFIG_PATH: envFilePath,
      MCP_ALLOWED_ROOTS: fixtureRoot
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const client = new McpClient(server);
  let exitCode = 0;

  try {
    console.log("\n[1] MCP 握手");
    const initResult = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-harness", version: "1.0.0" }
    });
    check(initResult.serverInfo?.name === "wechat-draft", "serverInfo.name = wechat-draft", initResult.serverInfo);
    client.notify("notifications/initialized", {});

    console.log("\n[2] tools/list 工具清单");
    const tools = await client.request("tools/list", {});
    const toolNames = (tools.tools || []).map((tool) => tool.name).sort();
    check(toolNames.includes("upload_wechat_draft"), "暴露 upload_wechat_draft");
    check(toolNames.includes("inspect_wechat_article"), "暴露 inspect_wechat_article");
    check(toolNames.includes("wechat_draft_status"), "暴露 wechat_draft_status");

    const uploadTool = (tools.tools || []).find((tool) => tool.name === "upload_wechat_draft");
    const requiredParams = uploadTool?.inputSchema?.required || [];
    check(
      requiredParams.length === 1 && requiredParams[0] === "path",
      "upload_wechat_draft 唯一必填参数是 path（token 关键设计）",
      requiredParams
    );

    console.log("\n[3] inspect_wechat_article 预检（不调用微信接口）");
    const inspectResult = parseToolText(await client.request("tools/call", {
      name: "inspect_wechat_article",
      arguments: { path: fixture.htmlPath }
    }));
    check(inspectResult.ok === true, "预检返回 ok");
    check(inspectResult.ready === true, "预检判定为可上传", inspectResult.blockingIssues);
    check(inspectResult.meta.title === "meta.json 里的标题", "meta.json 覆盖 HTML h1 标题", inspectResult.meta.title);
    check(inspectResult.meta.author === "测试作者", "作者来自 meta.json", inspectResult.meta.author);
    check(inspectResult.meta.digest === "meta.json 提供的摘要", "摘要来自 meta.json", inspectResult.meta.digest);
    check(inspectResult.meta.column === "工具炼金术", "栏目来自 meta.json", inspectResult.meta.column);
    check(
      String(inspectResult.cover || "").endsWith(path.join("images", "cover.png")),
      "封面按 meta.json cover 解析",
      inspectResult.cover
    );
    check(inspectResult.inlineImages.length === 5, "识别出 5 张正文图片", inspectResult.inlineImages.length);
    const kinds = inspectResult.inlineImages.map((image) => image.kind).sort();
    check(
      JSON.stringify(kinds) === JSON.stringify(["local", "local", "local", "no-src", "remote"]),
      "图片类型分类正确（3 local + 1 remote + 1 懒加载 no-src）",
      kinds
    );

    console.log("\n[4] upload_wechat_draft 完整链路");
    const uploadResult = parseToolText(await client.request("tools/call", {
      name: "upload_wechat_draft",
      arguments: { path: fixture.articleDir }
    }));
    check(uploadResult.ok === true, "上传返回 ok", uploadResult.error);
    check(uploadResult.draftMediaId === "mock-draft-1", "拿到微信草稿 media_id", uploadResult.draftMediaId);
    check(uploadResult.title === "meta.json 里的标题", "草稿标题正确", uploadResult.title);
    check(uploadResult.author === "测试作者", "草稿作者正确", uploadResult.author);
    check(uploadResult.cover?.mediaId === "mock-material-1", "封面素材独立返回 mediaId", uploadResult.cover);
    check(uploadResult.images?.uploaded === 2, "上传了 2 张正文图片（封面单独计数）", uploadResult.images);
    check(uploadResult.images?.leftAsIs === 1, "外链图片按 upload-local 策略保持原样", uploadResult.images);
    const skippedReasons = (uploadResult.images?.skipped || []).map((item) => item.reason).join(" | ");
    check(
      uploadResult.images?.skipped?.length === 2,
      "缺失图片与懒加载图都不被误上传（skipped=2）",
      uploadResult.images?.skipped
    );
    check(skippedReasons.includes("不存在"), "缺失的本地图片被报告为「不存在」", skippedReasons);
    check(skippedReasons.includes("只有 data-src"), "data-src 懒加载图被显式报告（回归 D3）", skippedReasons);

    console.log("\n[5] 断言提交给微信的草稿 payload");
    const draftRaw = await readFile(path.join(projectRoot, ".data", "mock-last-draft.json"), "utf8");
    const draft = JSON.parse(draftRaw);
    const article = draft.payload.articles[0];
    check(article.title === "meta.json 里的标题", "payload.title 正确", article.title);
    check(article.thumb_media_id === "mock-material-1", "payload.thumb_media_id 指向封面素材", article.thumb_media_id);
    check(article.article_type === "news", "payload.article_type = news", article.article_type);
    check(article.need_open_comment === 0, "payload.need_open_comment 默认 0", article.need_open_comment);
    check(!/<html|<body|<head/i.test(article.content), "正文已剥离 html/body 骨架");
    check(!/<style/i.test(article.content), "正文已剥离 <style> 标签");
    check(
      article.content.includes("https://mmbiz.qpic.cn/uploadimg/inline-1.png"),
      "本地图片 fig1 走 media/uploadimg 并替换为返回 URL"
    );
    check(
      article.content.includes("https://mmbiz.qpic.cn/uploadimg/inline-2.png"),
      "本地图片 fig2 走 media/uploadimg 并替换为返回 URL"
    );
    check(
      uploadResult.images?.channels?.uploadimg === 2,
      "返回结果标记 2 张正文图片走 uploadimg 通道（不占素材库配额）",
      uploadResult.images?.channels
    );
    check(
      uploadResult.images?.channels?.material === undefined,
      "没有图片回退到永久素材（mock 的 uploadimg 正常）",
      uploadResult.images?.channels
    );
    check(article.content.includes("https://example.com/remote.png"), "外链图片保持原样");
    check(article.content.includes("images/missing.png"), "缺失图片保持原样");
    check(/<h1[^>]*>/.test(article.content), "正文保留 h1（排版完整）");
    check(article.content.includes('style="font-size:16px;color:#333;"'), "正文内联样式被保留");

    console.log("\n[6] wechat_draft_status 凭证校验");
    const statusResult = parseToolText(await client.request("tools/call", {
      name: "wechat_draft_status",
      arguments: {}
    }));
    check(statusResult.ok === true, "凭证校验通过", statusResult);
    check(statusResult.accessTokenValid === true, "access_token 有效");
    check(
      String(statusResult.credentialsSource || "").includes("env"),
      "凭证来源确认为 env(.env) —— 验证「凭证取自 .env」",
      statusResult.credentialsSource
    );
    check(
      statusResult.appIdMasked === maskAppId(FIXTURE_APP_ID),
      "使用的是 .env 夹具里的 AppID，不是继承环境变量",
      statusResult.appIdMasked
    );
    check(
      !JSON.stringify(statusResult).includes(FIXTURE_APP_SECRET),
      "AppSecret 未出现在返回值中"
    );

    console.log("\n[7] 路径越界防护");
    const outsideResult = await client.request("tools/call", {
      name: "inspect_wechat_article",
      arguments: { path: "/etc/hosts" }
    });
    const outsidePayload = parseToolText(outsideResult);
    check(outsideResult.isError === true, "越界路径被拒绝");
    check(outsidePayload.error?.code === "ARTICLE_PATH_NOT_ALLOWED", "返回 ARTICLE_PATH_NOT_ALLOWED", outsidePayload.error);

    console.log("\n[8] stdio 协议纯净性（回归 D1）");
    // 本进程启动时没有注入 MCP_LOG_TARGET，LOG_LEVEL=info。
    // 如果入口顺序错了，第一条日志会写进 stdout，这里就能抓到。
    check(
      client.stdoutPollution.length === 0,
      "stdout 上没有任何非 JSON-RPC 内容（日志未污染协议通道）",
      client.stdoutPollution.slice(0, 3)
    );
    check(
      client.stderrText.length > 0,
      "日志确实写到了 stderr（而不是被静默丢弃）",
      client.stderrText.length
    );
  } catch (error) {
    exitCode = 1;
    failures.push(`未捕获异常：${error.message}`);
    console.error(`\n✗ 测试过程中抛出异常：${error.stack || error.message}`);
  } finally {
    client.close();
    mock.kill("SIGTERM");
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  console.log(`\n断言总数: ${assertionCount}`);
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 项：`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log("全部断言通过 ✓");
  process.exit(exitCode);
}

async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cgi-bin/token?grant_type=client_credential&appid=x&secret=y`);
      if (response.ok) {
        return;
      }
    } catch {
      // 端口尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`测试替身端口 ${port} 未就绪`);
}

main();
