# Continuum Canvas MCP Agent 使用手册

本文面向需要操作 Continuum Canvas 的通用 Agent。MCP 服务只负责工具协议、参数校验和 REST 转发；画布事务、权限、工作流、导演任务和产物交付均由 Continuum Canvas 后端执行。

第一次接手本项目时，建议先阅读更短的 [`mcp-agent-quickstart.md`](./mcp-agent-quickstart.md)，跑通标准链路后再用本文查询完整参数。

## 1. 使用边界

Agent 必须遵守以下规则：

- 先读取画布上下文，再执行写操作。
- 不直接修改画布 JSON、Yjs 文件或服务端数据目录。
- 不使用整份快照覆盖画布。
- 创建、更新和连线尽量使用一个原子批次。
- 对可重试的写操作复用同一个 `operationId`。
- 用户批准前不得启动付费导演生成。
- 工作流候选必须是画布中已经存在的完整文本节点，不能只提交方向摘要。
- 不把第一张图片或第一个视频视为导演任务完成；以工作流终态为准。
- 不声称可以读取模型私有思维链。只能展示上游公开返回的思考摘要、执行步骤、消息和选项。
- 除非任务明确要求删除且令牌包含 `canvas:delete`，否则不要调用删除工具。

## 2. 前置条件

### 2.1 启动画布服务

在项目目录启动 Continuum Canvas：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\Continuum-canvas'
npm run dev
```

默认 MCP 所连接的 REST 地址是：

```text
http://127.0.0.1:4173
```

如果后端运行在其他端口，通过 `CANVAS_AGENT_API_ORIGIN` 指定实际地址。

### 2.2 创建 Agent 令牌

令牌通过本机管理员会话创建，并且绑定唯一的 `projectId + canvasId`。推荐权限：

```json
[
  "canvas:read",
  "canvas:write",
  "workflow:approve",
  "director:generate"
]
```

默认不要授予 `canvas:delete`。令牌明文只在创建时返回一次，后端只保存摘要。

创建接口：

```http
POST /api/agent/v1/tokens
Content-Type: application/json

{
  "projectId": "PROJECT_ID",
  "canvasId": "CANVAS_ID",
  "name": "通用 Agent",
  "scopes": [
    "canvas:read",
    "canvas:write",
    "workflow:approve",
    "director:generate"
  ]
}
```

请安全保存响应中的 `secret`，格式为 `cva_...`。

## 3. 启动和配置 MCP

MCP 是标准输入输出（stdio）服务，启动命令为：

```powershell
npm run mcp
```

必须传入的环境变量：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `CANVAS_AGENT_TOKEN` | 是 | 绑定画布的 `cva_...` 令牌 |
| `CANVAS_AGENT_API_ORIGIN` | 否 | REST 地址，默认 `http://127.0.0.1:4173` |
| `CANVAS_ID` | 否 | 默认画布 ID；省略时每个画布工具都要传 `canvasId` |

通用 MCP 客户端配置示例：

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

不同客户端的外层配置字段可能不同，但 `command`、`args`、`cwd` 和三个环境变量含义不变。

## 4. 通用调用约定

### 4.1 返回值

工具成功时同时返回：

- `content`：格式化后的 JSON 文本。
- `structuredContent`：可直接被 Agent 读取的结构化结果。

Agent 应优先读取 `structuredContent`。

### 4.2 operationId

所有画布写工具都接受可选 `operationId`。未传时 MCP 会自动生成 UUID；需要安全重试时必须由调用方显式提供并复用。

```json
{
  "operationId": "script-batch-20260910-001"
}
```

同一画布内重复提交同一个 `operationId`：

- 不会重复创建节点或连线。
- 返回原始回执。
- 回执中的 `replayed` 为 `true`。

不要把同一个 `operationId` 用于不同业务操作。

### 4.3 revision 与冲突

读取画布后会得到 `revision`。写操作可把它作为 `baseRevision`：

```json
{
  "baseRevision": 12
}
```

如果画布已经被其他人或 Agent 更新，操作会整体拒绝并返回 `canvas_revision_conflict`。正确处理方式：

1. 再次调用 `canvas_get_context`。
2. 根据最新节点和连线重新计算操作。
3. 使用新的 `operationId` 和最新 `baseRevision` 提交。

不要在冲突后去掉 `baseRevision` 盲目重放旧修改。

### 4.4 批内别名

创建节点时可以声明 `alias`。同一原子批次中的后续底层操作可以通过 `$别名` 引用新节点。MCP 的创建和连线是两个独立工具调用，因此跨工具调用时应读取创建回执的 `receipt.aliases`，再使用真实节点 ID 建立连线。

创建回执示例：

```json
{
  "receipt": {
    "aliases": {
      "draft_a": "f2b83c4d-...",
      "draft_b": "62092c37-..."
    },
    "createdNodeIds": ["f2b83c4d-...", "62092c37-..."],
    "revision": 13,
    "replayed": false
  }
}
```

## 5. 画布工具

### 5.1 canvas_get_context

读取画布、当前 `revision`、节点和连线。传 `nodeIds` 时额外返回指定节点及其相邻连线。

输入：

```json
{
  "canvasId": "CANVAS_ID",
  "nodeIds": ["NODE_ID_1", "NODE_ID_2"]
}
```

典型用途：

- 每轮操作前读取最新 revision。
- 获取候选文案、参考图片和 Skill 节点的真实 ID。
- 检查导演台及交付物连线。

### 5.2 canvas_find_nodes

按名称、节点类型、正文或提示词搜索节点。搜索在 MCP 端对最新画布上下文执行。

输入：

```json
{
  "canvasId": "CANVAS_ID",
  "query": "带货口播",
  "kind": "skill"
}
```

`kind` 可使用画布节点类型或业务节点类型，例如：

- `text`
- `image`
- `video`
- `frame`
- `skill`
- `director`

### 5.3 canvas_create_nodes

原子批量创建节点。

支持的 `kind`：

- `text`
- `image`
- `video`
- `frame`
- `skill`
- `director`

完整文本候选示例：

```json
{
  "canvasId": "CANVAS_ID",
  "operationId": "create-three-scripts-20260910-001",
  "baseRevision": 12,
  "nodes": [
    {
      "alias": "draft_a",
      "kind": "text",
      "name": "方案 A｜沉甸甸送礼反差",
      "text": "版本标题：方案 A……\n\n简版导演手册……\n\n人物与场景……\n\n详细钩子过程……\n\n转入口播……\n\n主体与收尾……\n\n场景动作与台词时间轴\n00:00.00–00:02.10……",
      "position": { "x": 1200, "y": 400 },
      "size": { "width": 520, "height": 900 }
    },
    {
      "alias": "draft_b",
      "kind": "text",
      "name": "方案 B｜开箱数量冲击",
      "text": "完整文案……",
      "position": { "x": 1780, "y": 400 },
      "size": { "width": 520, "height": 900 }
    },
    {
      "alias": "draft_c",
      "kind": "text",
      "name": "方案 C｜家庭团圆场景",
      "text": "完整文案……",
      "position": { "x": 2360, "y": 400 },
      "size": { "width": 520, "height": 900 }
    }
  ]
}
```

图片或视频节点可设置：

```json
{
  "kind": "video",
  "name": "单元 01",
  "prompt": "镜头描述",
  "aspectRatio": "9:16",
  "resolution": "720P",
  "durationSec": 15,
  "referenceNodeIds": ["REFERENCE_NODE_ID"]
}
```

### 5.4 canvas_update_nodes

批量更新已有节点。

输入：

```json
{
  "canvasId": "CANVAS_ID",
  "operationId": "revise-draft-a-20260910-002",
  "baseRevision": 13,
  "updates": [
    {
      "nodeId": "SCRIPT_NODE_ID",
      "patch": {
        "name": "方案 A｜修改版",
        "text": "修改后的完整文本",
        "position": { "x": 1200, "y": 420 },
        "size": { "width": 560, "height": 960 }
      }
    }
  ]
}
```

可更新字段：`name`、`text`、`prompt`、`position`、`size`、`aspectRatio`、`resolution`、`durationSec`、`referenceNodeIds`。

### 5.5 canvas_connect_nodes

批量建立连线。

支持关系：

| relation | 含义 |
| --- | --- |
| `flow` | 流程、文案到导演台等主链路 |
| `output` | 明确的产出关系 |
| `reference` | 图片、视频等参考素材 |
| `skill` | Skill 对 Agent/导演台的注入关系 |

输入：

```json
{
  "canvasId": "CANVAS_ID",
  "operationId": "connect-references-20260910-001",
  "baseRevision": 14,
  "connections": [
    {
      "source": "PRODUCT_IMAGE_NODE_ID",
      "target": "DIRECTOR_NODE_ID",
      "relation": "reference",
      "referenceAlias": 1
    },
    {
      "source": "DIRECTOR_SKILL_NODE_ID",
      "target": "DIRECTOR_NODE_ID",
      "relation": "skill"
    }
  ]
}
```

审批工作流会自动为通过稿创建导演台及其 `flow`、`reference`、`skill` 连线，正常情况下不要提前手工创建这些导演台连线。

### 5.6 canvas_delete_nodes

删除节点及其相邻连线。需要 `canvas:delete` 权限。

```json
{
  "canvasId": "CANVAS_ID",
  "operationId": "delete-abandoned-draft-20260910-001",
  "baseRevision": 15,
  "nodeIds": ["NODE_ID"]
}
```

删除不可用于绕过审批或清理仍在运行的导演任务。

### 5.7 canvas_auto_layout

对全部节点或指定节点自动布局。

```json
{
  "canvasId": "CANVAS_ID",
  "operationId": "layout-three-drafts-20260910-001",
  "baseRevision": 15,
  "strategy": "storyboard_horizontal",
  "nodeIds": ["DRAFT_A_ID", "DRAFT_B_ID", "DRAFT_C_ID"]
}
```

策略：

- `storyboard_horizontal`：横向分镜排列。
- `grid`：三列网格。
- `tree`：按树形层级排列。

## 6. 工作流与导演工具

### 6.1 workflow_stage_for_approval

登记待确认工作流。该工具不会启动导演生成。

调用前必须确保：

- 每个候选 `nodeId` 都指向画布中的文本节点。
- 每份文本包含版本标题和完整内容。
- 包含“简版导演手册”。
- 包含“人物与场景”。
- 包含“钩子过程”。
- 包含“转入口播”。
- 包含“主体与收尾”。
- 包含“场景动作与台词时间轴”。
- 时间轴从 `00:00.00` 开始，并存在形如 `00:00.00–00:02.10` 的时间段。

输入：

```json
{
  "canvasId": "CANVAS_ID",
  "projectId": "PROJECT_ID",
  "candidates": [
    { "nodeId": "DRAFT_A_ID", "title": "方案 A｜沉甸甸送礼反差" },
    { "nodeId": "DRAFT_B_ID", "title": "方案 B｜开箱数量冲击" },
    { "nodeId": "DRAFT_C_ID", "title": "方案 C｜家庭团圆场景" }
  ],
  "referenceNodeIds": [
    "CHARACTER_IMAGE_ID",
    "GIFT_BOX_IMAGE_ID",
    "PRODUCT_IMAGE_ID"
  ],
  "skillNodeIds": ["DIRECTOR_SKILL_NODE_ID"],
  "settings": {
    "providerId": "xiaoyunque",
    "preferenceMode": "video",
    "model": "Seedance 2.0 Fast VIP",
    "imageModel": "",
    "aspectRatio": "9:16",
    "duration": 15,
    "resolution": "720P"
  }
}
```

保存返回的：

- `workflow.id`
- `workflow.updatedAt`
- 三个候选的节点 ID 和标题

然后在当前 Agent 对话中向用户展示候选并等待明确选择。

### 6.2 workflow_approve

只有用户明确批准后才能调用。

```json
{
  "workflowId": "WORKFLOW_ID",
  "approvedNodeIds": ["DRAFT_A_ID", "DRAFT_C_ID"]
}
```

审批后，后端会为每个通过稿自动执行：

1. 创建独立导演台节点。
2. 建立文案到导演台的 `flow` 连线。
3. 建立素材到导演台的 `reference` 连线。
4. 建立 Skill 到导演台的 `skill` 连线。
5. 注入完整文案、Skill、参考素材和生成参数。
6. 最多并行启动三个导演任务。

未被批准的候选不会创建导演台，也不会产生付费任务。

### 6.3 workflow_get

立即读取工作流状态：

```json
{
  "workflowId": "WORKFLOW_ID"
}
```

重点读取：

- `workflow.status`
- `workflow.updatedAt`
- `workflow.directorRuns[]`
- `directorRuns[].status`
- `directorRuns[].reply`
- `directorRuns[].thinking`
- `directorRuns[].executionSteps`
- `directorRuns[].questionnaire`
- `directorRuns[].artifacts`
- `directorRuns[].error`

### 6.4 workflow_wait

等待状态发生变化，避免高频轮询：

```json
{
  "workflowId": "WORKFLOW_ID",
  "afterUpdatedAt": "2026-09-10T08:00:00.000Z",
  "timeoutMs": 30000
}
```

- `afterUpdatedAt` 应传上一次响应的 `workflow.updatedAt`。
- `timeoutMs` 最大按 60 秒处理，推荐 30 秒。
- 超时不是失败；读取返回状态后继续等待即可。
- 页面可以关闭，后台仍会继续轮询小云雀。

工作流状态：

| 状态 | Agent 行为 |
| --- | --- |
| `awaiting_approval` | 向用户展示候选，等待批准 |
| `running` | 继续调用 `workflow_wait` |
| `awaiting_input` | 展示对应导演任务的问卷，等待用户选择 |
| `complete` | 汇总全部导演任务和全部产物 |
| `partial_failure` | 返回成功产物，并说明失败任务及可重试项 |
| `failed` | 展示错误，询问是否重试 |

### 6.5 director_answer

当某个 `DirectorRun.status` 为 `awaiting_input` 时，读取其 `questionnaire`，把公开选项展示给用户，再提交答案：

```json
{
  "runId": "DIRECTOR_RUN_ID",
  "optionId": "OPTION_ID",
  "value": "逐段生成，尾帧参考"
}
```

不要替用户猜测会明显影响费用、时长或内容方向的选项。

### 6.6 director_retry

仅用于 `failed` 状态的导演任务：

```json
{
  "runId": "DIRECTOR_RUN_ID"
}
```

重试会沿用原候选文案、参考素材、Skill 和导演参数，并增加 `attempt`。其他已完成或正在运行的导演任务不受影响。

## 7. 标准三稿链路

后续 Agent 应按以下顺序执行：

1. 调用 `canvas_get_context`，记录 `projectId`、`canvasId` 和 `revision`。
2. 使用 `canvas_find_nodes` 定位产品参考图和导演 Skill 节点。
3. 根据验收规则生成三份完整文案，而不是三个标题或摘要。
4. 使用一次 `canvas_create_nodes` 将三份文案写成三个独立文本节点。
5. 从 `receipt.aliases` 或 `createdNodeIds` 取得真实节点 ID。
6. 必要时调用 `canvas_auto_layout` 整理三个候选节点。
7. 调用 `workflow_stage_for_approval`，登记候选、参考素材、Skill 和导演参数。
8. 在当前对话中向用户展示 `workflowId`、候选标题和节点 ID，然后停止，不得提前审批。
9. 用户明确选择后调用 `workflow_approve`，只提交通过的节点 ID。
10. 使用 `workflow_wait` 持续等待。
11. 遇到 `awaiting_input` 时，展示公开问卷并用 `director_answer` 提交用户答案。
12. 到达终态后，逐个汇总所有 `directorRuns[].artifacts`，不能只返回第一个产物。
13. 如为 `partial_failure`，保留成功结果，只对失败的 `runId` 使用 `director_retry`。

## 8. 完整伪代码

```text
context = canvas_get_context()
revision = context.revision

references = canvas_find_nodes(query="产品参考")
skills = canvas_find_nodes(kind="skill", query="导演")

drafts = 生成三份符合完整时间轴规则的文案

created = canvas_create_nodes(
  operationId=稳定且唯一的业务 ID,
  baseRevision=revision,
  nodes=drafts
)

candidateIds = created.receipt.createdNodeIds

workflow = workflow_stage_for_approval(
  candidates=candidateIds + 标题,
  referenceNodeIds=references,
  skillNodeIds=skills,
  settings=导演参数
)

向用户展示候选并等待

approved = 用户明确通过的 candidateIds
workflow_approve(workflow.id, approved)

state = workflow_get(workflow.id)
while state.status in [running, awaiting_input]:
  if state.status == awaiting_input:
    向用户展示 questionnaire 并等待答案
    director_answer(run.id, 用户答案)
  state = workflow_wait(
    workflowId=workflow.id,
    afterUpdatedAt=state.updatedAt,
    timeoutMs=30000
  )

汇总每个 run 的全部 artifacts、公开回复、执行步骤和错误
```

## 9. 错误处理

### agent_access_denied

可能原因：

- 未传 `CANVAS_AGENT_TOKEN`。
- 令牌已撤销或过期。
- 令牌属于另一个画布或项目。
- 缺少当前操作所需权限。
- 请求不是来自本机回环地址。

处理：停止写入并让用户创建或更新正确作用域的令牌。

### canvas_revision_conflict

说明画布已发生新修改。重新读取上下文、重新规划，并用新的 `operationId` 提交。

### invalid_workflow_input

常见原因：

- 候选节点不存在或不是文本节点。
- 文案缺少导演手册或时间轴必需章节。
- 时间轴没有从 `00:00.00` 开始。
- 参考素材或 Skill 节点不存在。
- 审批节点不属于该工作流。
- 对非失败任务执行重试，或对非等待状态提交答案。

### 导演任务 failed

读取 `directorRuns[].error`。不要删除成功任务的产物；向用户说明失败的是哪一稿，并在用户同意后调用 `director_retry`。

### 等待超时

`workflow_wait` 返回时仍为 `running` 属于正常情况。更新 `afterUpdatedAt` 后继续等待，不要重复审批或创建工作流。

## 10. 交付检查表

在告诉用户任务完成前，Agent 应确认：

- 三份候选确实是三个独立文本节点。
- 每份文案都包含完整导演手册和连续时间轴。
- 只为用户批准的候选创建了导演台。
- 每个通过稿对应独立 `DirectorRun` 和导演台节点。
- 参考图、Skill 和文案连线没有串线。
- 所有公开回复、思考摘要、执行步骤和问卷均可从运行状态读取。
- 每张图片、每个视频都分别出现在 `artifacts` 中并建立画布节点。
- 工作流已经进入 `complete`、`partial_failure` 或 `failed`，而不是仍在 `running`。
- 重试使用原 `runId`，写操作重试复用原 `operationId`。

## 11. 当前限制

- MCP 仅支持本机 REST 服务。
- 一个 Agent 令牌只授权一个画布和项目。
- MCP 当前通过 stdio 提供服务。
- `canvas_find_nodes` 是读取整份当前上下文后在 MCP 进程内筛选，不是向量检索。
- 本期没有单独的画布确认面板；候选确认在外部 Agent 对话中完成。
- 本文描述的是底座调用协议，不是已安装的文案创作 Skill。
