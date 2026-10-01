# 微信公众号草稿 MCP

把 AI 工具生成的微信公众号 HTML 排版文件，通过一次 MCP 工具调用送进公众号后台草稿箱。

实现位置：

- MCP 服务器入口：[src/mcp/wechatDraftServer.ts](../src/mcp/wechatDraftServer.ts)
- HTML 解析与元数据提取：[src/services/articleHtml.service.ts](../src/services/articleHtml.service.ts)
- 上传编排：[src/services/articlePublish.service.ts](../src/services/articlePublish.service.ts)
- 微信 API 封装（复用）：[src/services/wechat.service.ts](../src/services/wechat.service.ts)

## 1. 为什么这样设计：token 消耗与文章长度无关

这是本项目最重要的设计约束。

**反例**：把 HTML 正文作为工具参数传进去。

```jsonc
// ✗ 正文经过模型上下文，一篇 5000 字带样式的 HTML 就是几万 token
{ "name": "upload", "arguments": { "content_html": "<section style=...>...</section>" } }
```

**本项目的做法**：正文只走磁盘。

```jsonc
// ✓ 工具入参只有一个路径，几十个字符
{ "name": "upload_wechat_draft", "arguments": { "path": "/Users/me/articles/2026-09-30-ai-brief/article.html" } }
```

AI 排版工具（或 AI 自己）先把 HTML 写到磁盘，MCP 再从磁盘读取、上传。因此：

- 一篇 800 字文章和一篇 8000 字文章，工具调用的 token 消耗完全一样。
- 图片同理：本地图片由 MCP 直接读文件上传，不进模型上下文。
- 元数据（标题/作者/摘要/封面）优先从同目录 `meta.json` 和 HTML 的 `<h1>`、`<meta>` 标签自动提取，**不需要模型复述一遍**。

`upload_wechat_draft` 的唯一必填参数就是 `path`，这一点由自动化测试断言保证。

## 2. 三个工具

| 工具 | 作用 | 调用微信接口 |
|---|---|---|
| `upload_wechat_draft` | 读取 HTML → 上传封面与正文图片 → 创建公众号草稿 | 是 |
| `inspect_wechat_article` | 预检：回显自动识别的元数据、封面候选、正文图片清单、体积、阻塞问题 | 否 |
| `wechat_draft_status` | 检查凭证是否可用（实际请求一次 `access_token`，不返回密钥） | 是 |

### `upload_wechat_draft`

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | HTML 文件路径，或包含 `article.html` 的文章目录 |
| `title` | 否 | 覆盖标题 |
| `author` | 否 | 覆盖作者 |
| `digest` | 否 | 覆盖摘要 |
| `column` | 否 | 栏目名（微信草稿接口无对应字段，仅回显） |
| `coverImagePath` | 否 | 封面图路径或 http(s) 链接 |
| `imageStrategy` | 否 | `upload-local`（默认）/ `leave` / `upload-all` |
| `needOpenComment` | 否 | 是否开启留言，默认 false |
| `onlyFansCanComment` | 否 | 是否仅粉丝可留言，默认 false |

返回示例：

```json
{
  "ok": true,
  "message": "已创建微信公众号草稿：AI 简报 2026-09-30",
  "draftMediaId": "MEDIA_ID_xxx",
  "coverMediaId": "COVER_MEDIA_ID_xxx",
  "title": "AI 简报 2026-09-30",
  "author": "王英",
  "digest": "今天的五条 AI 动态…",
  "metaSources": { "title": "meta.json.title", "author": "meta.json.author" },
  "contentBytes": 18324,
  "cover": { "mediaId": "COVER_MEDIA_ID_xxx", "source": "/path/cover.png" },
  "images": { "uploaded": 3, "leftAsIs": 2, "skipped": [] },
  "warnings": []
}
```

## 3. 文章目录约定

MCP 会自动发现这些文件，因此**模型不需要描述它们**：

```text
my-article/
├── article.html      # 正文（必需；也支持 index.html，或直接用 path 指向任意 .html）
├── meta.json         # 元数据（可选但推荐）
├── cover.png         # 封面（可选；也支持 封面.jpg / thumb.png，或用 coverImagePath 指定）
└── images/           # 正文本地图片
    ├── fig1.png
    └── fig2.jpg
```

仓库里有一个可直接验证的示例：[examples/sample-article/](../examples/sample-article/)。用 `inspect_wechat_article` 传 `"path": "examples/sample-article"` 就能看到完整的自动识别结果。

### `meta.json`

全部字段可选，缺失时回退到从 HTML 提取：

```json
{
  "title": "AI 简报 2026-09-30",
  "author": "王英",
  "digest": "今天的五条 AI 动态",
  "column": "AI 简报",
  "cover": "images/cover.png"
}
```

### 元数据提取优先级

| 字段 | 优先级 |
|---|---|
| `title` | 工具参数 > `meta.json.title` > `<meta name="wechat:title">` > `<h1>` > `<title>` |
| `author` | 工具参数 > `meta.json.author` > `<meta name="author">` > `WECHAT_DEFAULT_AUTHOR` |
| `digest` | 工具参数 > `meta.json.digest` > `<meta name="description">` > 正文前 120 字 |
| `column` | 工具参数 > `meta.json.column` > `<meta name="column">` |
| 封面 | `coverImagePath` > `meta.json.cover` > 文章目录下 `cover/封面/thumb/banner/头图` + 图片扩展名 > 正文第一张本地图片 |

每次上传的返回值里都有 `metaSources`，说明每个字段实际来自哪里，便于排查而不用反复试错。

## 4. 正文 HTML 的处理规则

微信 `draft/add` 的 `content` 只接受**正文片段**，不接受完整文档骨架。MCP 会自动：

- 剥离 `<!DOCTYPE>`、`<html>`、`<head>`、`<body>` 包裹，只保留 `<body>` 内部内容。
- 移除 `<script>`、`<style>` 和 HTML 注释。
- 保留全部内联样式（`style="..."`）和 `<h1>` 等排版结构，不做 sanitize 改写。
- 校验微信 draft/add 的字段上限：`title` ≤ 32 字、`author` ≤ 16 字、`digest` ≤ 120 字、`content` 不超过 2KB 且少于 2 万字符。超出时本地直接报错，而不是等微信返回模糊错误——后者发生在图片都已上传成素材之后，会留下无法回收的孤儿素材。

### 正文图片策略

| `imageStrategy` | 本地图片（`src="images/fig1.png"`） | 外链图片（`src="https://..."`） | `data:` URI |
|---|---|---|---|
| `upload-local`（默认） | 上传，替换为微信图片 URL | 保持原样 | 报告为 skipped |
| `leave` | 保持原样 | 保持原样 | 报告为 skipped |
| `upload-all` | 上传并替换 | 下载后上传并替换 | 报告为 skipped |

同一张图片在正文里出现多次时只上传一次（按文件路径 / URL 去重）。

**正文图片走 `media/uploadimg`。** 官方 draft/add 文档要求正文图片 URL 必须来自
`cgi-bin/media/uploadimg`，且该接口上传的图片**不占用公众号素材库 10 万张配额**。
它只支持 jpg/png 且小于 1MB，因此遇到其它格式或调用失败时会自动回退到永久素材，
并在返回值的 `images.channels` 里说明回退情况，不会静默降级。
封面则必须用永久素材，因为 `thumb_media_id` 要求永久 MediaID。

**建议**：正文图片优先放本地目录。外链图片依赖第三方图床，可能被防盗链拦截或过期，
而且微信明确会过滤外部图片 URL，发布时图片就丢了。

### 图片写法要求

解析器按「逐个 `<img>` 标签 + 显式 `src` 属性」识别图片：

| 写法 | 行为 |
|---|---|
| `<img src="a.png">` | 正常识别 |
| `<img data-src="a.png">` | **不会被上传**。`data-src` 不是 `src`，微信也不渲染懒加载属性；会在 `images.skipped` 里明确报告，请改用 `src` |
| `<img srcset="a.png 2x">` | 不会被当作图片源 |
| `<img alt="a > b" src="a.png">` | 属性值里的 `>` 会提前截断标签解析（已知限制），避免在 `alt` 中使用裸 `>` |

## 5. 配置

### 5.1 微信公众号凭证

在项目根目录 `.env` 里填：

```bash
WECHAT_APP_ID=wx1234567890abcdef
WECHAT_APP_SECRET=your-app-secret
# 可选
WECHAT_DEFAULT_AUTHOR=王英
```

凭证解析顺序：

1. `.env` / MCP 客户端配置的 `env` 中的 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`
2. 兜底：复用飞书多维表格已绑定的微信凭证（`.data/integration-config.json`）

密钥不会出现在工具返回值里，`wechat_draft_status` 只回显 `wx12****cdef` 形式的掩码。

### 5.2 可选运行参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MCP_IMAGE_STRATEGY` | `upload-local` | 仅作为状态回显；实际策略由工具参数决定 |
| `MCP_ALLOWED_ROOTS` | 空（不限制） | 逗号分隔的允许根目录。设置后 MCP 只能读取这些目录下的文章，防止模型给出任意路径 |
| `WECHAT_CONTENT_MAX_BYTES` | `2048` | 正文体积上限（官方 draft/add 写「不可超过 2kb」）。若实测你的账号接受更大正文，可放开此项；字符数上限 2 万仍生效 |
| `WECHAT_CONTENT_MAX_CHARS` | `20000` | 正文字符数上限（官方「必须少于 2 万字符」） |
| `WECHAT_TITLE_MAX_CHARS` | `32` | 标题字符数上限 |
| `WECHAT_AUTHOR_MAX_CHARS` | `16` | 作者字符数上限 |
| `WECHAT_DIGEST_MAX_CHARS` | `120` | 摘要字符数上限 |
| `WECHAT_DEFAULT_AUTHOR` | 空 | 未指定作者时的兜底值 |
| `DOTENV_CONFIG_PATH` | 空（读项目根 `.env`） | 指定另一份 `.env`，用于多公众号切换或隔离测试 |
| `WECHAT_API_BASE` | `https://api.weixin.qq.com` | 仅本地联调/测试替身需要改 |
| `MCP_LOG_TARGET` | `stderr` | stdio 模式下日志必须走 stderr，否则会破坏 JSON-RPC 通道；MCP 入口已强制设置 |

**建议**：如果只在固定目录里写文章，设置 `MCP_ALLOWED_ROOTS`。

```bash
MCP_ALLOWED_ROOTS=/Users/wangying/Documents/articles
```

沙箱检查覆盖**所有**从磁盘读文件的通道，不只是 `path` 参数：

- 文章 HTML（`path`）
- 封面（`coverImagePath` 参数、`meta.json` 的 `cover`/`coverImage`/`thumb`）
- 正文图片（`<img src="...">`）

比较前会先做 `realpath`，因此允许目录内指向外部的**符号链接无法逃逸**；
`..` 序列与 `/a/b` vs `/a/bc` 这类前缀相似路径也会被正确区分。

越界表现按通道区分：

| 通道 | 越界行为 |
|---|---|
| `path` | 直接报错 `ARTICLE_PATH_NOT_ALLOWED` |
| 封面（`coverImagePath`） | 报错 `COVER_PATH_NOT_ALLOWED` |
| `meta.json` 的 cover / 正文图片 src | 跳过该项并记入 `warnings` / `images.skipped`，不中断整篇上传 |

## 6. 客户端配置

### 6.1 Claude Desktop / Cursor / Trae（stdio）

`claude_desktop_config.json` 或对应客户端的 MCP 配置：

```json
{
  "mcpServers": {
    "wechat-draft": {
      "command": "npx",
      "args": ["tsx", "/Users/wangying/Documents/workplace/wechat-article-pilot/src/mcp/wechatDraftServer.ts"],
      "cwd": "/Users/wangying/Documents/workplace/wechat-article-pilot",
      "env": {
        "WECHAT_APP_ID": "wx1234567890abcdef",
        "WECHAT_APP_SECRET": "your-app-secret",
        "MCP_ALLOWED_ROOTS": "/Users/wangying/Documents/articles"
      }
    }
  }
}
```

推荐直接用 `node` 跑编译产物，启动更快、不依赖 tsx：

```json
{
  "mcpServers": {
    "wechat-draft": {
      "command": "node",
      "args": ["/Users/wangying/Documents/workplace/wechat-article-pilot/dist/mcp/wechatDraftServer.js"],
      "cwd": "/Users/wangying/Documents/workplace/wechat-article-pilot",
      "env": {
        "WECHAT_APP_ID": "wx1234567890abcdef",
        "WECHAT_APP_SECRET": "your-app-secret"
      }
    }
  }
}
```

用编译产物前先执行：

```bash
npm run build
```

凭证两种放法任选其一：写进上面的 `env`，或写进项目根目录 `.env`。**不要同时放两份**，否则排查时容易搞不清哪份生效（实际以 MCP 客户端 `env` 为准，因为 dotenv 不覆盖已有环境变量）。

## 7. 本地验证

### 7.1 端到端自动化测试

测试会启动一个微信 API 测试替身（[scripts/mock-wechat-server.mjs](../scripts/mock-wechat-server.mjs)），构造夹具文章，完整跑一遍 MCP 协议握手和上传链路，并断言提交给微信 `draft/add` 的 payload。

```bash
npm test               # 一次性跑完全部四组（共 145 项断言）
npm run test:unit      # 72 项：解析/校验/脱敏纯函数
npm run test:sandbox   # 16 项：MCP_ALLOWED_ROOTS 沙箱逃逸
npm run test:fallback  # 10 项：uploadimg 失败回退永久素材
npm run mcp:e2e        # 47 项：MCP 协议 + 完整上传链路（src）
npm run mcp:e2e:dist   # 同上，但跑 dist 编译产物
```

`npm run mcp:e2e` 覆盖：MCP 握手、工具清单、`path` 是唯一必填参数、元数据提取优先级、
封面发现、图片分类与替换、正文骨架剥离、外链保持原样、缺失图片上报、**凭证确实来自 `.env`**、
凭证校验、路径越界防护、**stdout 协议纯净性**。

测试会刻意从继承环境里剔除所有 `WECHAT_*` 变量，另写一个独立的 `.env` 并用 `DOTENV_CONFIG_PATH`
指向它。因此它验证的是真实的 `.env` 读取链路，而不是靠环境变量把凭证"喂"进去——这一点如果退化了，
测试会失败。同理，e2e 启动 MCP 子进程时**不注入** `MCP_LOG_TARGET`，并逐行校验 stdout 上
只出现合法 JSON-RPC 报文，这样「日志污染 stdout 导致握手失败」这类回归会被立刻抓住。

### 7.2 多套凭证切换

`config.ts` 支持 `DOTENV_CONFIG_PATH`，可以指向任意 `.env` 文件，方便在多个公众号之间切换，或在不碰生产凭证的前提下测试：

```bash
DOTENV_CONFIG_PATH=/path/to/account-b.env npm run mcp
```

### 7.3 手工验证真实凭证

`wechat_draft_status` 工具会实际请求一次微信 `access_token`，是最直接的凭证检查方式。也可以直接用一行命令验证，不经过 MCP：

```bash
node --env-file=.env --import tsx --input-type=module -e "
process.env.MCP_LOG_TARGET = 'stderr';
const { WechatService } = await import('./src/services/wechat.service.ts');
const service = new WechatService();
const result = await service.uploadPermanentImage({
  credentials: { appId: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET },
  filePath: './cover.png'
});
console.log(JSON.stringify(result, null, 2));
"
```

注意：这会真实上传一张永久图片素材到你的公众号素材库。想只验证凭证而不上传，把上面换成调用 `wechat_draft_status` 工具即可。

## 8. 常见问题

**`MISSING_WECHAT_CREDENTIALS`**
`.env` 或 MCP 客户端 `env` 里没有 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`。调用 `wechat_draft_status` 可以看到当前凭证来源。

**`ARTICLE_NOT_READY_FOR_WECHAT`**
返回值里的 `blockingIssues` 会列出具体原因，通常是缺标题、缺封面、标题超 32 字、或正文超过 2KB／2 万字符。先用 `inspect_wechat_article` 预检。

**`MISSING_COVER_IMAGE`**
微信 `draft/add` 强制要求 `thumb_media_id`。把封面命名为 `cover.png` / `cover.jpg` / `封面.jpg` 放在文章目录，或用 `coverImagePath` 指定。

**微信返回 `errcode: 40007` 或 `invalid media_id`**
封面素材过期。微信永久素材不会自动过期，但如果你用的是临时素材或换过公众号，需要重新上传。重新调用一次 `upload_wechat_draft` 即可。

**微信返回 `errcode: 45009`（接口调用超过限制）**
`access_token` 或素材上传触发了频率限制。MCP 内部按 `appId` 缓存 `access_token`（提前 5 分钟过期），正常情况下不会频繁刷新。

**草稿里图片裂图**
说明正文里还留着外链图片，第三方图床拦截了微信抓取。改用本地图片并把 `imageStrategy` 设为 `upload-local`（默认）或 `upload-all`。

**上传成功但在草稿箱看不到**
草稿是按公众号区分的。确认 `WECHAT_APP_ID` 对应的是你要发布文章的那个公众号。

## 9. 设计边界

- 只创建草稿，**不发布**。发布需要人工在公众号后台确认，这是产品选择也是安全边界。
- 不做 Markdown → HTML 转换。AI 排版工具负责产出带内联样式的 HTML，MCP 只负责搬运。
- 不修改正文 HTML 的排版与样式，只做文档骨架剥离和图片链接替换。
- 不支持 `data:` URI 图片（微信素材接口不接受 base64），会在 `images.skipped` 里报告。
- 单篇图文。多图文（一次草稿含多篇文章）暂不支持。
- 不存储上传历史。草稿 ID 只在返回值里，需要留存的话由调用方记录。
