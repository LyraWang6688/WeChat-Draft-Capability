/**
 * 本地联调用的微信公众号 API 测试替身。
 *
 * 只实现 MCP 上传链路需要的三个接口：
 *   GET  /cgi-bin/token
 *   POST /cgi-bin/material/add_material
 *   POST /cgi-bin/draft/add
 *
 * 用法：node scripts/mock-wechat-server.mjs [--port 8799]
 * 它会把收到的最后一次草稿请求写到 .data/mock-last-draft.json，便于断言。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 8799;

const materialCounter = { value: 0 };
const draftCounter = { value: 0 };
const uploadImgCounter = { value: 0 };

/** 让测试可以模拟 uploadimg 失败，从而覆盖回退到永久素材的分支 */
const FAIL_UPLOADIMG = process.env.MOCK_FAIL_UPLOADIMG === "1";

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  if (url.pathname === "/cgi-bin/token") {
    return json(res, 200, {
      access_token: "mock-access-token",
      expires_in: 7200
    });
  }

  if (url.pathname === "/cgi-bin/media/uploadimg") {
    if (FAIL_UPLOADIMG) {
      return json(res, 200, { errcode: 40005, errmsg: "mock: uploadimg disabled" });
    }
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return json(res, 200, { errcode: 40004, errmsg: "invalid media type: expect multipart/form-data" });
    }
    if (rawBody.length === 0) {
      return json(res, 200, { errcode: 40004, errmsg: "empty media body" });
    }
    uploadImgCounter.value += 1;
    return json(res, 200, {
      url: `https://mmbiz.qpic.cn/uploadimg/inline-${uploadImgCounter.value}.png`
    });
  }

  if (url.pathname === "/cgi-bin/material/add_material") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return json(res, 200, {
        errcode: 40004,
        errmsg: "invalid media type: expect multipart/form-data"
      });
    }
    if (rawBody.length === 0) {
      return json(res, 200, {
        errcode: 40004,
        errmsg: "empty media body"
      });
    }
    materialCounter.value += 1;
    const mediaId = `mock-material-${materialCounter.value}`;
    return json(res, 200, {
      media_id: mediaId,
      url: `https://mmbiz.qpic.cn/mock/${mediaId}.png`
    });
  }

  if (url.pathname === "/cgi-bin/draft/add") {
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      return json(res, 200, { errcode: 40001, errmsg: `invalid json: ${error.message}` });
    }
    draftCounter.value += 1;
    const mediaId = `mock-draft-${draftCounter.value}`;
    await mkdir(path.resolve(process.cwd(), ".data"), { recursive: true });
    await writeFile(
      path.resolve(process.cwd(), ".data", "mock-last-draft.json"),
      `${JSON.stringify({ mediaId, payload, receivedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    return json(res, 200, { media_id: mediaId });
  }

  return json(res, 404, { errcode: 404, errmsg: `mock: no route for ${url.pathname}` });
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`[mock-wechat] listening on http://127.0.0.1:${port}\n`);
});

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}
