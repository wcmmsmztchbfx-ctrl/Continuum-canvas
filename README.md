<p align="center">
  <img src="./public/continuum-logo.svg" width="88" height="88" alt="Continuum Logo" />
</p>
<h1 align="center">Continuum · 连点成片</h1>
<p align="center">把想法、素材与生成过程，组织在同一张无限画布里。</p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#画布-agent">画布 Agent</a> ·
  <a href="./docs/agent-runtime.md">使用指南</a> ·
  <a href="./PROJECT_INDEX.md">架构导航</a> ·
  <a href="./LICENSE">MIT 许可</a>
</p>

Continuum 是一个可自托管的 AI 视觉创作工作台。将图片、视频、文字和矢量图形放进画布，用节点连线组织创作过程，也可以让 Agent 根据自然语言指令完成画布操作与内容生成。

## 在一张画布中完成创作

| 能力 | 可以做什么 |
| --- | --- |
| 无限画布 | 平移缩放、多选、编组、吸附、图层管理，以及撤销与重做。 |
| 图片与视频 | 导入素材、管理资产、提取视频帧、查看生成历史，将参考素材连接到生成节点。 |
| 矢量与排版 | 使用钢笔、路径、形状、文字和画框，调整尺寸、填充、描边、透明度和视觉效果。 |
| 多模型生成 | 通过统一网关连接图片、视频供应商与本地工作流，按服务支持情况选择模型和参数。 |
| 自主 Agent | 读取画布技能、规划步骤、调用工具、澄清需求，并展示执行过程与阶段结果。 |
| 实时协作 | 自托管协作房间、成员权限、在线状态与画布同步。 |
| 大画布体验 | 按视口加载媒体，按显示尺寸选择预览清晰度，限制并发请求并复用缓存。 |

## 画布 Agent

输入「帮我生成一个苹果」，Agent 可以创建图片节点、填写提示词、提交生成，并将结果写回画布。

- **执行可见**：技能读取、工具调用、任务计划和阶段报告会显示在对话中。
- **遇到歧义先澄清**：通过选项或文字确认关键细节后继续。
- **引用由你确认**：选择图片节点后先出现候选缩略图，点击后才加入对话；支持多图引用。
- **后端持续执行**：关闭网页后，只要后端在线，任务仍可继续；重新打开原画布可以查看进度。
- **执行中可干预**：补充要求、暂停、继续或停止任务；支持安全撤销本次画布变更。
- **多段对话**：新建或切换独立对话，分别保留历史与草稿；新回复逐字显示，执行预算耗尽时汇总实际进度后暂停。

Agent 需要配置支持工具调用的对话模型；图片理解需要视觉能力，生成图片或视频还需要对应的生成服务。实际能力与费用取决于所接入的模型。详细操作与当前边界见 [Agent 使用指南](./docs/agent-runtime.md)。

## 快速开始

需要 **Node.js 22.18+** 和 **npm 10+**。

```bash
git clone https://github.com/wcmmsmztchbfx-ctrl/Continuum-canvas.git
cd Continuum-canvas
npm ci
npm run dev
```

打开 **http://127.0.0.1:4173**。开发服务同时启动前端与后端，后端端口为 `4174`。首次启动为空工作区，创建项目和画布后即可使用。

在应用的 API 设置中配置生成供应商和 Agent 对话模型。需要自定义端口、存储目录或网络访问时，可参考 [.env.example](./.env.example)，在本机创建 `.env.local`。

要为新任务启用新版画布命令与操作 Skill，在 `.env.local` 中设置 `CANVAS_AGENT_RUNTIME_VERSION=2` 后重启服务。已有任务保留创建时的执行器版本。版本说明见 [画布 Agent v2](./docs/agent-canvas-v2.md)，对话行为见 [对话与答复](./docs/agent-conversations.md)。

Windows 下也可以使用后台服务命令：

```bash
npm run dev:service
npm run dev:status
npm run dev:stop
```

## 自托管运行

```bash
npm run build
npm start
```

生产服务默认通过 `http://127.0.0.1:4173` 同时提供网页、API 与协作连接。局域网和公网部署配置见 [.env.example](./.env.example)。

远程分享首次使用时，会从 Cloudflare 官方 GitHub 发布页下载对应平台的 `cloudflared`，完成后缓存到 `data/bin/`，后续直接复用。下载支持标准 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量；不配置时直连。也可以按照 [官方安装说明](https://developers.cloudflare.com/tunnel/downloads/) 安装到系统 PATH，或在 `.env.local` 中通过 `CLOUDFLARED_PATH` 指定程序路径，然后重启后端。macOS 自动安装需要系统自带的 `tar`。局域网协作不需要下载此组件。

## 数据与配置

- 画布、素材、任务记录和服务端配置默认保存在本机 `data/`；迁移前请备份该目录。
- API 密钥由后端保存和用于生成请求，管理接口通过登录凭证与角色权限控制访问。
- `.env`、本地环境文件、`data/`、运行日志、测试输出和内部诊断记录不进入版本库；`.env.example` 只保留空配置项与示例。
- 测试使用独立数据目录和模拟服务，不调用真实付费生成。

## 开发与验证

技术栈：**React 19 · TypeScript · Vite 8 · React Flow · Zustand · Node.js · Yjs**。

```bash
npm run lint
npm test
npm run test:server
npm run test:performance
npm run build
npm run test:e2e:smoke
```

浏览器测试首次运行前安装测试浏览器：`npx playwright install chromium`。本地默认使用 Chrome，CI 使用 Chromium。代码组织与持久化边界见 [架构导航](./PROJECT_INDEX.md)。

## 授权说明

项目自身的代码与文档采用 [MIT License](./LICENSE)，允许商用、修改和分发，需保留版权与许可声明。第三方组件分别遵循其原有许可证，详见 [第三方声明](./THIRD_PARTY_NOTICES.md)。`package.json` 的 `private: true` 用于防止误发布 npm 包，不限制 MIT 授予的权利。

生产构建会生成 `dist/third-party-licenses.md`，分发网页构建产物时应一并保留。Sharp/libvips 等原生组件、按需下载的 cloudflared，以及供应商服务的许可与再分发说明见第三方声明。

本仓库不附带商业模型、供应商凭证或用户上传／生成的媒体。第三方产品与模型名称仅用于标识兼容接入，不表示其官方出品、赞助或背书；服务费用、模型权重和媒体使用权由相应服务条款及素材权利决定。
