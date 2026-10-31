# Continuum 架构导航

Continuum 将画布编辑、生成服务和后台 Agent 分开管理，共享持久化、素材与协作接口。

## 技术栈

- 前端：React 19、TypeScript、Vite 8、React Flow 12、Zustand。
- 后端：Node.js，供应商适配器，持久任务队列与素材存储。
- 协作：Yjs、WebSocket、成员权限与编辑租约。
- 验证：Vitest、Playwright，以及独立的性能测试场景。

## 模块入口

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/Root.tsx` | 工作区和画布页面组装，保存与协作生命周期。 |
| `src/model/`、`src/store/` | 节点、连线、选区、编辑命令、撤销历史与远端变更合并。 |
| `src/components/canvas/` | 画布渲染、几何操作、矢量编辑、视口索引与媒体显示。 |
| `src/components/inspector/` | 变换、样式、路径和生成参数编辑。 |
| `src/components/sidebar/` | 图层、素材、演化关系与 Agent 对话。 |
| `src/services/agent/` | Agent 请求、任务观察与画布结果同步。 |
| `src/services/media*` | 媒体资源、预览存储、请求队列与生命周期管理。 |
| `src/persistence/`、`src/workspace/` | 本地保存、后端同步、修订号与冲突处理。 |
| `src/collaboration/` | 协作连接、会话、能力与租约状态。 |
| `src/contracts/` | 前后端共享协议。 |
| `server/http-gateway.ts` | HTTP 路由、身份检查与静态资源。 |
| `server/workspace-service.ts` | 版本化画布写入与工作区提交。 |
| `server/collaboration-service.ts` | 协作房间、权限、Yjs 文档与检查点。 |
| `server/agent/` | 后台任务、模型循环、技能、结构化工具、回执与恢复。 |
| `skills/canvas-agent/` | 内置画布操作、排版、参考图、图像及视频生成技能。 |
| `server/providers/`、`server/jobs.ts` | 模型适配、生成请求、任务轮询与结果保存。 |
| `server/asset-store.ts`、`server/asset-preview.ts` | 素材原文件、预览变体与访问。 |
| `tests/e2e/`、`tests/performance/` | 用户流程、协作场景与性能回归。 |

## 编辑与保存

人工操作通过画布状态库修改快照并进入撤销历史。非协作画布通过版本化工作区服务保存；协作画布通过房间文档与检查点持久化。后台 Agent 的变更使用相同的保存和权限边界，避免整张画布覆盖。

视口和编辑内容分别处理。媒体按可见区域和屏幕显示尺寸请求预览，拖动与缩放期间限制资源升级和并发加载；面板列表按需渲染。

## Agent 执行

用户消息创建后端持久任务。每轮模型上下文包含基础画布 Skill，模型通过已注册的结构化工具执行操作。工具结果和任务事件持久化，前端轮询展示；页面关闭不承担取消任务的职责。

图片候选只有经用户点击确认才进入附件。生成任务复用现有供应商、任务与素材服务，写入前重新检查任务状态、权限和画布修订。暂停、停止、澄清与撤销的细节见 [Agent 使用指南](./docs/agent-runtime.md)。

## 开发约定

- 运行配置与用户数据保存在 `data/` 和本地环境文件中，不提交到仓库。
- 测试样例使用匿名标识、保留域名和模拟媒体，禁止加入真实凭证或用户素材链接。
- 界面显示与后台执行分开测试，重要任务路径同时验证持久化与恢复。
- 修改协议时同步检查服务端校验、客户端处理与协作边界。

启动与测试命令见 [README](./README.md)。
