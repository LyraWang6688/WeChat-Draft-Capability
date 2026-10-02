> **HISTORICAL ONLY — Legacy Feishu**
> 本文保留旧 Feishu 架构时期的原始记录，不代表当前架构、待办或部署指令。
> Feishu Runtime Exposure 已关闭；对应 physical implementation 已在 approved repository hygiene cleanup 中退役。本文仅保留历史背景，不作为当前架构、任务或部署指令。
> 当前唯一 Agent 入口为 [AGENTS.md](../../../AGENTS.md)，工程事实见 [Current Engineering Handoff](../../AI_HANDOFF.md)。

# 服务器远程开发流程

本项目当前推荐把服务器作为“开发执行机”：代码、后端进程、`lark-cli` 配置和运行日志都集中在服务器上，设备 A / B / C 只负责远程编辑或访问页面。

## 目标形态

```text
设备 A / B / C
远程编辑服务器项目或访问测试页面
        ↓
服务器 /opt/wechat-article-pilot-dev
运行 Express 后端和 lark-cli
        ↓
飞书多维表格 / 飞书 Workflow
```

这样可以避免每次小改动都经历“本地修改 -> push GitHub -> 服务器 pull -> Docker build -> 重启”的完整部署链路。

## 目录规划

```text
/opt/wechat-article-pilot-dev
开发测试目录，远程编辑这里，运行 npm run dev 或 PM2 dev 进程

/opt/wechat-article-pilot-prod
未来正式部署目录，后续再接 Docker / PM2 / Nginx / 正式域名
```

当前阶段优先维护 `dev` 目录，`prod` 目录等飞书侧闭环稳定后再整理。

## 服务器准备

1. 安装 Node.js 20+。
2. 安装 `lark-cli`，并确保服务器 shell 可以直接执行 `lark-cli --version`。
3. 安装 PM2：

```bash
npm install -g pm2
```

4. 拉取项目到开发目录：

```bash
mkdir -p /opt
cd /opt
git clone https://github.com/LyraWang6688/wechat-article-pilot.git wechat-article-pilot-dev
cd /opt/wechat-article-pilot-dev
npm install
```

5. 配置环境变量：

```bash
cp .env.example .env
```

如 `lark-cli` 不在 PATH，设置：

```text
LARK_CLI_BIN=/absolute/path/to/lark-cli
```

## 飞书 CLI 初始化

服务器只需要安装并能执行 `lark-cli`。飞书应用初始化和用户授权应通过项目网页触发后端执行，不建议用户直接在服务器终端手动跑完整流程。

等价的授权命令形式是：

```bash
lark-cli auth login --scope "<P0 必需权限，可重复传入>" --no-wait --json
lark-cli auth status --json --verify
```

后续设备 A / B / C 访问页面时，真正执行飞书操作的仍然是服务器上的 `lark-cli`。

## 开发运行

最轻量方式：

```bash
npm run dev
```

为了避免 SSH 断开导致服务退出，推荐用 PM2 管理开发进程：

```bash
npm run pm2:dev
npm run pm2:dev:logs
```

常用命令：

```bash
npm run pm2:dev:restart
npm run pm2:dev:stop
pm2 status
```

开发期可以先不使用 Docker。Docker 更适合后续预发布和正式上线。

## 跨设备修改代码

推荐两种方式：

- 远程开发：设备 A / B / C 通过 SSH、VS Code Remote、Trae 远程环境等方式直接编辑 `/opt/wechat-article-pilot-dev`。
- 阶段性 GitHub：功能稳定后再 `git commit` / `git push`，GitHub 用作版本沉淀，不作为每次小改动测试的必经流程。

## 测试入口

服务器开发机使用已经预留好的测试地址：

```text
https://draft-api.bamamei.online
```

飞书 Workflow webhook 后续也直接填写服务器测试地址：

```text
https://draft-api.bamamei.online/api/webhooks/feishu/base-record-sync
```

进入页面后，先点击“检查环境”，确认：

- 后端主机是服务器。
- Node.js 版本正常。
- `lark-cli` 可用。
- 当前授权用户可用。

也可以直接访问：

```text
GET /api/system/env
```

## 迁移到生产

当 P0 飞书侧闭环稳定后，再整理生产部署：

- 使用 `/opt/wechat-article-pilot-prod`。
- 接入正式域名和 HTTPS。
- 使用 PM2、Docker、Nginx 或平台进程管理。
- 将 `.env`、飞书应用、`lark-cli` profile、日志策略整理为生产配置。
