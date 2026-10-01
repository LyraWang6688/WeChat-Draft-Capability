# AI 项目交接说明

本文档用于把 `wechat-article-pilot` 交给下一位 AI 或开发者时快速建立上下文。接手者应先读本文，再读 `PROJECT_BRIEF.md`、`docs/LARK_CLI_INIT_CONTEXT.md`、`docs/WORKFLOW_FEASIBILITY.md` 和 `docs/REMOTE_SERVER_DEV.md`。

## 1. 项目目标

本项目是一个「飞书多维表格 × 微信公众号后台」桥接工具。

P0 阶段先跑通飞书侧闭环：

- 创建飞书应用。
- 完成用户授权。
- 自动创建多维表格工作台。
- 自动新增「推送草稿表」和 15 个模板字段。
- 自动创建两条 Base Workflow。
- Workflow 触发后端 webhook。
- 后端根据 `record_id` 读取完整记录。
- 后端写回同步状态。
- 飞书通知当前授权用户。

微信侧当前只保留 `AppID / AppSecret` 前端占位，尚未真正保存或调用微信公众号 API。

## 2. 技术栈和部署

- 前端：静态 `HTML + CSS + Vanilla JS`，暂不迁移 React / Tailwind。
- 后端：`Node.js + Express + TypeScript`。
- 飞书侧：服务器上的 `lark-cli`。
- 部署：Ubuntu VM + PM2 + Nginx。
- 服务器目录：`/opt/wechat-article-pilot-dev`。
- 线上开发域名：`draft-api.bamamei.online`，Nginx 反代到 `127.0.0.1:3010`。

## 3. 当前关键实现

### 3.1 飞书 CLI 初始化

- `lark-cli config init --new` 是交互式阻塞命令，不能当成同步 HTTP 请求。
- 当前代码已改为后端异步会话，前端轮询状态，避免 Nginx `504 Gateway Time-out`。
- 创建应用链接由按钮本身承载：点击「创建新应用」后，按钮变成「打开飞书创建链接」。

### 3.2 用户授权

- 授权使用 `lark-cli auth login --scope <scopes> --no-wait --json`。
- 点击「开始授权」后，按钮变成「打开飞书授权链接」。
- 页面上已经删除「我已完成授权」按钮。
- 后端新增异步授权完成检测：
  - `POST /api/lark/shared/auth/login/complete/start`
  - `GET /api/lark/shared/auth/login/complete/status?sessionId=...`
- 后端通过后台会话执行 `lark-cli auth login --device-code <device_code> --json`，前端轮询完成状态。
- 授权完成后，前端自动进入「多维表格初始化」并继续创建 Base / 表 / 工作流。

### 3.3 P0 必需授权 scope

当前授权必须包含：

```text
base:app:create
base:table:read
base:table:create
base:table:update
base:table:delete
base:field:read
base:field:create
base:field:update
base:view:write_only
base:record:read
base:record:create
base:record:update
base:workflow:create
base:workflow:update
```

曾经漏掉 `base:field:create`、`base:field:update`、`base:view:write_only`，导致 `base +table-create --fields ...` 创建「推送草稿表」失败。

### 3.4 前端初始化向导

- 页面是左右布局。
- 左侧是配置进度器。
- 右侧是单板块向导。
- 已删除顶部总览和「最新操作提示」全局提示区，因为它们会破坏左右高度协调。
- 第一板块「飞书应用初始化」已简化，只保留：
  - `创建新应用`
  - `开始授权`
  - 授权后四项能力说明
- 不要再新增全局提示卡片。状态反馈优先放在当前卡片和左侧进度器。

## 4. 当前最新提交

最新提交应为：

```text
460be9b fix: simplify notify workflow action
```

这个提交的目的：修复「同步结果通知」工作流在飞书 UI 中显示「未知操作」的问题。

## 5. 当前最重要待办

### P0-1：验证通知工作流是否还显示「未知操作」

更新服务器到最新代码后，重新创建「推送草稿表：同步结果通知」工作流。

检查飞书 UI：

- 如果第二个节点从「未知操作」变成「发送飞书消息」，说明 `LarkMessageAction` 最小结构可用。
- 如果仍然是「未知操作」，下一位 AI 必须继续对照官方 schema/guide 排查，不要凭感觉猜 JSON。

官方参考文件在本机：

```text
C:\Users\Admin\.trae-cn\skills\lark-base\references\lark-base-workflow-schema.md
C:\Users\Admin\.trae-cn\skills\lark-base\references\lark-base-workflow-guide.md
```

当前通知动作已收敛为最小结构：

```ts
receiver: [
  {
    value_type: "user",
    value: {
      id: notifyUserOpenId,
      name: notifyUserName
    }
  }
],
send_to_everyone: false,
title: [{ value_type: "text", value: "公众号草稿同步结果" }],
content: [
  {
    value_type: "text",
    value: "推送草稿表中有记录状态已更新，请打开多维表格查看同步结果。"
  }
],
btn_list: []
```

不要先加回动态记录链接按钮。先验证最小 `LarkMessageAction` 能被飞书 UI 识别。

### P0-2：验证推送工作流触发后端 webhook

通知工作流 UI 正常后，再测试：

- 修改一条记录 `status = ready_to_upload`。
- 检查飞书工作流是否请求后端 webhook。
- 后端是否收到 `base_token / table_id / record_id`。
- 后端是否能根据 `record_id` 读取完整记录。

### P0-3：验证状态写回和通知闭环

后端读取记录成功后，继续验证：

- 后端写回 `uploaded_to_wechat` 或 `failed`。
- 写回状态是否触发第二条通知工作流。
- 是否会误触发第一条同步工作流造成循环。

### P1：微信公众号 API 接入

飞书侧闭环稳定后再开始微信侧：

- 保存并保护 `AppID / AppSecret`。
- 获取 `access_token`。
- 上传永久素材。
- 创建或更新公众号草稿。
- 把微信接口返回结果写回飞书记录。

## 6. 关键风险和经验

- `lark-cli config init --new` 和 `auth login --device-code` 都可能阻塞，不能直接放在同步 HTTP 请求里。
- CLI 成功不等于用户流程成功，前端必须展示或承载用户下一步动作。
- 后端应返回稳定字段，不要让前端递归猜 `raw`。
- `base +workflow-create` 返回成功，不代表飞书 UI 能识别节点；UI 显示「未知操作」通常说明 workflow JSON 某个 action data 结构不符合编辑器 schema。
- 已经创建出来的旧工作流不会自动更新，需要删除旧工作流或重新创建。
- 当前 P0 是单用户模式：一个用户、一个飞书应用、一个 Base、不共享、通知当前授权用户。
- 多人协作、按记录人员字段通知、指定负责人通知，不属于当前 P0。

## 7. 服务器更新命令

```bash
cd /opt/wechat-article-pilot-dev
git pull
npm install
npm run typecheck
pm2 restart wechat-article-pilot-dev
pm2 logs wechat-article-pilot-dev --lines 80
```

确认版本：

```bash
cd /opt/wechat-article-pilot-dev
git log -1 --oneline
```

应看到：

```text
460be9b fix: simplify notify workflow action
```

## 8. 本地检查命令

每次修改后至少执行：

```bash
node --check public/app.js
npm run typecheck
git diff --check
```

如果改了前端 UI，建议本地启动并用浏览器快照确认：

```bash
npm run dev
```

## 9. 给下一位 AI 的明确要求

- 不要把交互式 CLI 当同步 HTTP 请求。
- 不要新增破坏左右高度的全局提示面板。
- 不要随意迁移 React/Tailwind。
- 不要凭自然语言猜飞书 workflow JSON。
- 不要一次性加复杂 workflow 字段；先最小可识别，再逐步加功能。
- 每次推送后，都给用户服务器更新命令和确认版本命令。

## 10. 补充（MCP 通道已落地）

本节记录 2026-09-30 新增的本地 stdio MCP 通道，接手者若只关心「AI 生成 HTML → 公众号草稿箱」这条链路，看这里。

### 10.1 新增文件

```text
src/mcp/wechatDraftServer.ts               MCP stdio 服务器入口，注册三个工具
src/services/articleHtml.service.ts        HTML 解析、元数据提取、封面发现、图片扫描
src/services/articlePublish.service.ts     上传编排：封面素材 -> 正文图片替换 -> 草稿创建
scripts/mock-wechat-server.mjs             微信 API 测试替身（仅本地联调）
scripts/mcp-e2e.mjs                        端到端自动化测试（41 项断言）
docs/MCP_WECHAT_DRAFT.md                   完整使用文档
```

改动文件：

- `src/config.ts`：新增 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_DEFAULT_AUTHOR` / `WECHAT_CONTENT_MAX_BYTES` / `WECHAT_API_BASE` / `logToStderr`。
- `src/utils/logger.ts`：支持把日志切到 stderr。
- `src/services/wechat.service.ts`：`uploadPermanentImage` 支持内存 Buffer、`addDraftArticle` 支持留言开关、API 基地址改为可配置。
- `src/services/integrationConfig.service.ts`：新增 `listWechatBindings()`。
- `.env.example`、`README.md`、`package.json`：新增 MCP 相关配置、文档与脚本。

### 10.2 必须记住的约束

- **stdout 是 JSON-RPC 通道**。stdio 模式下任何写入 stdout 的日志都会破坏 MCP 协议握手。MCP 入口在 import 之前就设置 `MCP_LOG_TARGET=stderr`，`logger` 据此改写 `console.error`。新增日志代码时不要直接 `console.log`。
- **工具入参只传文件路径，不传正文**。这是控制 token 消耗的核心设计，`upload_wechat_draft` 的唯一必填参数就是 `path`，自动化测试对此有断言。不要为了"方便"再加一个 `content_html` 参数。
- **正文从磁盘读，图片也从磁盘读**。本地图片由 MCP 直接读文件上传微信素材库，不经过模型上下文。
- **改动 `articlePublish.service.ts` 的返回结构时，同步改 `scripts/mcp-e2e.mjs` 的断言**。测试是唯一能防止返回结构悄悄漂移的护栏。

### 10.3 验证命令

```bash
npm run typecheck
npm run build
npm run mcp:e2e          # 跑 src 源码
npm run mcp:e2e:dist     # 跑 dist 编译产物
```

`npm run mcp:e2e` 会自己启动和关闭微信 API 测试替身，不需要真实公众号凭证，也不会真实上传。

### 10.4 两条微信通道的关系

现在有两处调用微信 API，共用同一个 `WechatService`：

```text
飞书通道   Base Workflow -> webhook -> SyncArticleService -> WechatService
MCP 通道   AI 排版工具写 HTML 到磁盘 -> MCP 工具调用 -> ArticlePublishService -> WechatService
```

两条通道互不影响，凭证来源不同：

- 飞书通道从 `.data/integration-config.json` 读取与多维表格绑定的凭证。
- MCP 通道优先读 `.env` 的 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`，找不到再兜底复用 `.data` 里的绑定。

### 10.5 已明确不做的事

- 不发布，只创建草稿。
- 不做 Markdown → HTML 转换。
- 不 sanitize 正文样式，只剥离文档骨架和替换图片链接。
- 不支持 `data:` URI 图片。
- 不支持单次多图文。

### 10.6 第二轮修复（对抗式审查后）

第二轮做了一次独立的对抗式代码审查，发现并修复了以下问题。这些问题里有几个是原测试**完全没覆盖**的，
接手时请留意不要回退：

| 编号 | 问题 | 修复方式 |
|---|---|---|
| D1 | **致命**：`wechatDraftServer.ts` 里 `process.env.MCP_LOG_TARGET = "stderr"` 写在 import 之后，但 ESM 会先求值 import，导致 logger 早已按「写 stdout」初始化。**默认启动即污染 JSON-RPC 通道，MCP 客户端握手失败** | 新增引导层 `src/mcp/main.ts`（先设环境变量，再动态 import 服务器）；`logger` 改为**每次写入时**读取该变量，不再固化成常量；e2e 不再注入该变量并逐行校验 stdout，防止回归 |
| D2 | `MCP_ALLOWED_ROOTS` 只做字符串前缀比较，且只管 `path` 参数。四条绕过路径：符号链接逃逸、`coverImagePath` 越界、正文图片 `../` 越界、`meta.json` 的 cover 越界 | `realpath` 后再比较；`coverImagePath` / `meta.json` cover / 正文 `src` 全部纳入检查 |
| D3 | `\bsrc\s*=` 中 `\b` 在 `-` 后成立，`data-src` 被当作 `src`：工具报成功，实际图片不显示 | 改为逐 `<img>` 标签 + 显式 `src` 属性匹配；`no-src`（懒加载写法）显式报告为 skipped |
| D4 | 正文限制写成 64KB，官方 draft/add 写「不可超过 2kb，少于 2 万字符、小于 1M」 | 默认改为 2KB + 2 万字符，并校验 title≤32 / author≤16 / digest≤120 |
| D5 | 正文图片走 `material/add_material`，官方要求走 `media/uploadimg`（且 uploadimg 不占 10 万张素材配额） | 新增 `WechatService.uploadArticleImage`：优先 uploadimg，失败/格式不支持时回退永久素材并在返回值说明 |
| D7 | `redactText` 对 URL 形态密钥只遮中间一段（32 位泄漏 24 位），还把 `upload_wechat_draft_failed` 截成 `upload_wechat_***iled` | 改为「敏感键名 + 值」脱敏，且不得再加捕获组（会右移 replace 回调参数） |
| D8 | `skipped` 里回显完整 base64 data URI，反噬 token 设计 | 改为固定占位符，不回显内容 |
| D10 | `.env` 残留 `WECHAT_API_BASE` 时 `wechat_draft_status` 会对测试替身报「凭证有效」 | 返回值新增 `apiBase` / `apiBaseIsProduction` / `warning` |
| D11 | `!response.expires_in` 把合法的 0 当缺失 | 只校验 access_token，expires_in 缺失时退化为 300 秒 |
| D12 | `envCredentials` 死代码 | 删除 |

### 10.7 测试护栏（共 145 项断言）

```bash
npm test               # 四组全跑
npm run test:unit      # 72 项 解析/校验/脱敏
npm run test:sandbox   # 16 项 沙箱逃逸
npm run test:fallback  # 10 项 uploadimg 回退
npm run mcp:e2e        # 47 项 MCP 协议 + 上传链路
npm run mcp:e2e:dist   # 对 dist 产物再跑一遍
```

两条最重要的护栏，改动相关代码时不要削弱：

1. **e2e 不注入 `MCP_LOG_TARGET`，且逐行断言 stdout 只有合法 JSON-RPC**。这直接覆盖 D1。
2. **e2e 从继承环境剔除所有 `WECHAT_*`，用独立 `.env` + `DOTENV_CONFIG_PATH` 提供凭证**。
   这保证「凭证取自 `.env`」是真的被测到，而不是被环境变量掩盖。

### 10.8 已知限制（有意保留）

- 图片解析用正则，不引入 HTML 解析库。`alt="a > b"` 这类属性值含裸 `>` 会截断标签解析。
- `data:` URI 图片不支持（微信素材接口不收 base64），会报告为 skipped。
- 单篇图文，不支持一次草稿多篇文章。
- 只创建草稿，不发布。
