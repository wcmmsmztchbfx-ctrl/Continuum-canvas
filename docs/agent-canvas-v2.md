# Agent 画布命令 v2

通过 `CANVAS_AGENT_RUNTIME_VERSION=2` 为**新任务**启用。缺省值为 1，便于分批验证。回退为 1 不会改变既有 v2 任务；没有 executionVersion 的旧记录仍按原工具与 Skill 解释。任务记录附加固定 Skill 包、版本和 SHA-256 摘要，不迁移画布数据。

入口为 `list_canvas_commands` → `describe_canvas_command` → `run_canvas_command`。目录、参数、实例和执行处理由 server/agent/commands.ts 同一注册表提供。Skill 的专项操作文档在创建任务时从该注册表生成契约附录，随后连同清单内所有资源固定在任务记录中。read_skill 仅允许读取固定清单，不访问任意文件。

| 分组 | 命令 |
| --- | --- |
| 节点 | nodes.create/rename/delete/duplicate/rename_canvas |
| 几何 | geometry.move/resize/rotate/layout/align/distribute |
| 层级 | hierarchy.group/ungroup/reparent/layer/reorder |
| 样式与路径 | styles.set/text/flags/shape、path.set |
| 连线 | edges.connect/remove |
| 引用 | references.attach/detach |
| 素材关联 | assets.associate/image_version |
| 生成配置 | generation.prompt/settings |

run_canvas_command 参数示例：

```json
{
  "command": "geometry.align",
  "parameters": {"nodeIds": ["node-a", "node-b"], "alignment": "left"},
  "expectedRevision": 12,
  "dryRun": true
}
```

先回读节点，确认修订与完整影响集，再将 dryRun 设为 false 提交。预演不会写文档、推高修订、创建撤销项或提交生成。正式提交重新检查修订、实际节点状态、任务选区、锁定、当前授权和协作租约。容器、父级 childIds、相关边及端点属于完整影响集，读取本身不授予写入权限。授权不足需要重新选区创建新任务，本轮没有扩权流程。

回执包含 operationId、command、committed、status、revision、verified、verificationRevision、affectedNodeIds、affectedEdgeIds 和 actual。未变化返回 unchanged；预演返回 preview；实际提交才返回 committed。意图和回执通过已有 Agent run store 持久化，WorkspaceService 操作编号负责去重；崩溃/响应丢失恢复沿用该编号。UI 展示预演/提交/核验状态和影响数量。

只读查询在 v2 返回实际 data（样式数组、路径、媒体身份和生成配置等）、节点层级索引、关联边页和总数；可用 edgeOffset/edgeLimit 分页。不会为了操作样式而只向模型提供坐标。

v2 仍调用原 request_generation，保留授权次数、队列、冻结配置、稳定请求身份、停止和晚到结果保护。更新配置或提示词不会生成。素材关联解析后端已有 assetId，核验类型；图片复用 addImageVersion 追加版本。浏览器裁剪、翻转、批注、视频取帧与剪贴板不进入后台命令。

撤销使用条件变更记录，覆盖节点/边字段、层级、对象顺序和画布名称。顺序只重排仍存在的原对象槽位，保留后来人工插入的对象；人工已改写的字段与排序不会被覆盖。相机不属于 Agent 变更。

验证分两类：参数契约、真实计算、持久化和浏览器机制使用确定性 fixture；真实模型是否能从自然语言正确发现与调用工具，单独记录实际模型轨迹。前者不能代替后者。参见 agent-evaluation.md。
