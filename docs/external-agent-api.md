# Continuum Canvas 外部 Agent 接入

外部 Agent 不应再读取并覆盖整份画布文件。所有操作通过本机 REST v1 或 MCP 工具提交，服务端会把事务实时广播给已打开的画布。

第一次接入可先阅读 [`mcp-agent-quickstart.md`](./mcp-agent-quickstart.md)；完整 MCP 工具参数、调用范例、三稿审批链路和错误恢复规则见 [`mcp-agent-guide.md`](./mcp-agent-guide.md)。

## 1. 创建作用域令牌

先在同一浏览器管理员会话中调用：

```http
POST /api/agent/v1/tokens
Content-Type: application/json

{
  "canvasId": "canvas-id",
  "projectId": "project-id",
  "name": "Codex",
  "scopes": [
    "canvas:read",
    "canvas:write",
    "workflow:approve",
    "director:generate"
  ]
}
```

响应中的 `secret` 只显示一次。默认不要授予 `canvas:delete`。

后续 REST 请求使用：

```http
Authorization: Bearer cva_xxx
```

接口仅接受来自本机回环地址的请求。

## 2. MCP 配置

启动命令：

```powershell
npm run mcp
```

环境变量：

- `CANVAS_AGENT_API_ORIGIN`：画布后端地址，默认 `http://127.0.0.1:4173`。
- `CANVAS_AGENT_TOKEN`：上一步创建的作用域令牌。
- `CANVAS_ID`：可选的默认画布 ID。

MCP 只负责工具协议和参数转换，所有写入仍由 REST 服务完成。

## 3. 推荐工作流

1. `canvas_get_context` 获取画布和 revision。
2. `canvas_create_nodes` 一次写入所有完整文案文本框。
3. 使用回执里的真实节点 ID 调用 `workflow_stage_for_approval`。
4. 在 Agent 对话中向用户展示候选节点 ID并等待选择。
5. 用户确认后调用 `workflow_approve`。
6. `workflow_wait` 等待完成、失败或 `awaiting_input`。
7. 如有问卷，展示选项并调用 `director_answer`。
8. 持续等待直到 `complete` 或 `partial_failure`，返回全部 `artifacts`。

文案候选必须包含完整的“简版导演手册”和从 `00:00.00` 开始的连续时间轴。只有方向摘要、缺少动作或缺少时间轴的文本会被工作流接口拒绝。

## 4. 并发与安全

- 每个 `operationId` 在同一画布内幂等。
- 写入前可传 `baseRevision`；过期时返回 `canvas_revision_conflict` 和当前 revision。
- 一批 operations 在内存中完整校验后才提交，不会留下半成品。
- 审批会为每个通过稿创建独立导演台，最多同时运行三个任务。
- 图片和视频中间产物不会令任务提前结束；只有上游明确结束才进入终态。
- 删除、审批和导演生成使用相互独立的权限。
