# Continuum Canvas MCP：给下一个 Agent 的快速使用教程

这份教程面向第一次接手 Continuum Canvas 的通用 Agent。目标不是介绍内部实现，而是让 Agent 能可靠完成下面这条链路：

`读取画布 → 写入多个完整文案 → 等待用户确认 → 挂载参考图与 Skill → 启动导演台 → 处理选项 → 收齐全部产物`

完整参数说明见 [`mcp-agent-guide.md`](./mcp-agent-guide.md)。

## 一、先确认三件事

1. Continuum Canvas 服务已经启动，默认地址为 `http://127.0.0.1:4173`。
2. MCP 客户端已配置 `continuum-canvas` 服务。
3. 环境变量中已有绑定当前画布的 `CANVAS_AGENT_TOKEN` 和 `CANVAS_ID`。

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "continuum-canvas": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "C:\\Users\\Administrator\\Desktop\\Continuum-canvas",
      "env": {
        "CANVAS_AGENT_API_ORIGIN": "http://127.0.0.1:4173",
        "CANVAS_AGENT_TOKEN": "cva_REPLACE_ME",
        "CANVAS_ID": "CANVAS_ID"
      }
    }
  }
}
```

不要把真实令牌写进教程、代码仓库或对话回复。默认令牌也不应包含删除权限。

## 二、Agent 必须遵守的规则

- 每轮先调用 `canvas_get_context`，不要凭记忆使用节点 ID 或 revision。
- 只通过 MCP 操作画布，不直接改 JSON、Yjs 文件或服务端数据目录。
- 写操作使用有业务含义且稳定的 `operationId`；同一次失败重试必须复用原值。
- 候选稿必须是完整文案，不能只写标题、方向摘要或几句创意。
- 用户明确批准前，禁止调用 `workflow_approve` 启动付费生成。
- 页面无需刷新，也无需保持打开；后台任务会持续运行并实时回写画布。
- 收到第一张图或第一个视频不代表任务完成，必须等工作流进入终态。
- 只展示服务公开返回的回复、思考摘要、执行步骤和问卷，不能声称获取了模型私有思维链。

## 三、最常用的完整流程

### 第 1 步：读取画布

调用：

```text
canvas_get_context({})
```

记录返回的：

- `canvas.projectId`
- `canvas.canvasId`
- `revision`
- 已有节点和连线

随后用 `canvas_find_nodes` 找参考素材和导演 Skill：

```text
canvas_find_nodes({ kind: "image", query: "参考" })
canvas_find_nodes({ kind: "skill", query: "导演" })
```

必须核对真实节点 ID。不要把图片文件名、节点标题或上一次运行的 ID 当作本次 ID。

### 第 2 步：生成并写入多个完整候选稿

例如一次写入三稿：

```text
canvas_create_nodes({
  operationId: "campaign-x-create-3-scripts-v1",
  baseRevision: <刚读取的 revision>,
  nodes: [
    { alias: "draft_1", kind: "text", name: "版本一｜……", text: <完整文案一> },
    { alias: "draft_2", kind: "text", name: "版本二｜……", text: <完整文案二> },
    { alias: "draft_3", kind: "text", name: "版本三｜……", text: <完整文案三> }
  ]
})
```

每份口播候选至少必须包含：

- 版本标题
- 简版导演手册
- 人物与场景
- 详细钩子过程
- 转入口播
- 主体与收尾
- 场景动作与台词时间轴
- 从 `00:00.00` 开始、连续覆盖目标时长的时间段、动作和台词

创建成功后，从 `receipt.aliases` 或 `receipt.createdNodeIds` 读取真实节点 ID。

如果返回 `canvas_revision_conflict`，重新读取画布、重新核对操作，并使用新的 `operationId` 和最新 revision；不要去掉 revision 强行覆盖。

### 第 3 步：登记待确认工作流

这一步只登记，不产生费用：

```text
workflow_stage_for_approval({
  canvasId: <canvasId>,
  projectId: <projectId>,
  candidates: [
    { nodeId: <版本一节点 ID>, title: "版本一｜……" },
    { nodeId: <版本二节点 ID>, title: "版本二｜……" },
    { nodeId: <版本三节点 ID>, title: "版本三｜……" }
  ],
  referenceNodeIds: [<参考图 1>, <参考图 2>, <参考图 3>],
  skillNodeIds: [<导演 Skill 节点 ID>],
  settings: {
    providerId: "xiaoyunque",
    preferenceMode: "video",
    model: "Seedance 2.0 Fast VIP",
    aspectRatio: "9:16",
    duration: 15,
    resolution: "720P"
  }
})
```

把返回的 `workflow.id`、候选标题和候选节点 ID 告诉用户，然后停止，等待用户明确选择。

### 第 4 步：只审批用户选择的版本

如果用户只选择版本二：

```text
workflow_approve({
  workflowId: <workflow.id>,
  approvedNodeIds: [<版本二节点 ID>]
})
```

后端会自动完成：

- 创建版本二专属导演台
- 建立文案到导演台的 `flow` 连线
- 建立每张参考图到导演台的 `reference` 连线
- 建立导演 Skill 到导演台的 `skill` 连线
- 注入完整文案、全部素材、Skill 和生成参数
- 启动并持续轮询小云雀任务

不要再手工创建第二个导演台，也不要重复审批。

## 四、七张参考图 + 专用 Skill 的版本二示例

当用户要求“版本二带七张图片和专门创作 Skill”时，关键在登记工作流时完整传入节点 ID：

```text
workflow_stage_for_approval({
  canvasId: <canvasId>,
  projectId: <projectId>,
  candidates: [
    { nodeId: <版本一 ID>, title: "版本一｜……" },
    { nodeId: <版本二 ID>, title: "版本二｜……" },
    { nodeId: <版本三 ID>, title: "版本三｜……" }
  ],
  referenceNodeIds: [
    <图片 1 ID>, <图片 2 ID>, <图片 3 ID>, <图片 4 ID>,
    <图片 5 ID>, <图片 6 ID>, <图片 7 ID>
  ],
  skillNodeIds: [<专用导演创作 Skill ID>],
  settings: {
    providerId: "xiaoyunque",
    preferenceMode: "video",
    model: "Seedance 2.0 Fast VIP",
    aspectRatio: "9:16",
    duration: 15,
    resolution: "720P"
  }
})
```

用户确认版本二后，只把版本二 ID 交给 `workflow_approve`。七张图与 Skill 不需要再次手动连接，后端会为批准的导演台统一连接。

## 五、等待、选项与多产物

先读取一次：

```text
workflow_get({ workflowId: <workflow.id> })
```

然后持续长轮询：

```text
workflow_wait({
  workflowId: <workflow.id>,
  afterUpdatedAt: <上次返回的 workflow.updatedAt>,
  timeoutMs: 30000
})
```

根据状态处理：

| 状态 | Agent 应做什么 |
| --- | --- |
| `running` | 更新 `afterUpdatedAt` 后继续等待 |
| `awaiting_input` | 把公开问卷原样展示给用户，等待选择 |
| `complete` | 汇总每个导演任务的全部产物 |
| `partial_failure` | 保留成功结果，指出失败的 run |
| `failed` | 展示错误；用户同意后调用 `director_retry` |

遇到二次选择时，不要替用户决定会影响费用、时长或创作方向的选项。用户选择后，提交选项中的真实 `value`：

```text
director_answer({
  runId: <等待输入的 run.id>,
  optionId: <questionnaire 中的 option.id>,
  value: <questionnaire 中的 option.value>
})
```

提交后继续使用 `workflow_wait`，直至终态。

`directorRuns[].artifacts` 是数组。必须逐项读取，不能只返回 `artifacts[0]`。图片和视频会分别本地化成独立画布节点，并连接到所属导演台。

## 六、如何判断真正完成

只有满足下面条件才向用户报告完成：

1. `workflow.status` 已是 `complete`、`partial_failure` 或 `failed`。
2. 不存在仍为 `running` 或 `awaiting_input` 的导演任务。
3. 已遍历所有 `directorRuns`。
4. 已遍历每个 run 的全部 `artifacts`。
5. 已报告公开回复、执行步骤、选项或错误。
6. 已确认画布中存在对应导演台、素材连线、Skill 连线和产物节点。

即使回复文本写着“成片已生成”，只要状态仍是 `running`，就继续等待。小云雀可能先返回分段视频、预览或中间产物，随后才返回最终成片或问卷。

## 七、常见错误的正确处理

### 写入后画布没变化

先确认服务和浏览器连接的是同一个 `canvasId`。正常情况下无需刷新；重新调用 `canvas_get_context` 验证服务端是否已有节点。

### 重试后出现重复节点

同一写操作必须复用原 `operationId`。不要为网络超时立即生成一个新的 operationId。

### 只收到一张图或一个视频

检查是否只读了 `artifacts[0]`。继续等待工作流终态，并遍历完整 `artifacts` 数组。

### 看不到详细思考过程

只有上游公开返回 `thinking` 或 `executionSteps` 时才能展示；没有返回时应明确写“暂无公开摘要”，不能自行补造内部思维链。

### 页面关闭或服务重启

页面关闭不影响后台导演任务。服务重启后会恢复未完成的运行和轮询；Agent 只需用原 `workflowId` 调用 `workflow_get` 或 `workflow_wait`，不要创建新工作流。

## 八、给接手 Agent 的最短检查表

```text
[ ] 先读 context 和 revision
[ ] 找到真实参考图 ID 与 Skill ID
[ ] 写入的是完整文案，不是方向摘要
[ ] 使用稳定 operationId
[ ] stage 后先让用户确认
[ ] approve 只包含用户通过的稿件
[ ] running 就继续 wait
[ ] awaiting_input 就展示问卷并等用户
[ ] 遍历全部 runs 和全部 artifacts
[ ] 只有进入终态才报告完成
```

