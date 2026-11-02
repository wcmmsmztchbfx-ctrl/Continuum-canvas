# Agent 画布能力与兼容边界

本轮以用户批准的 Agent 侧重构为边界。所有手工入口继续使用原 store、事件和保存时机。命令执行器只在私有副本上调用 vanilla store，生成候选文档；不连接 React、不操作浏览器、不调用全局 canvasStore。

| 界面能力 | 操作实现 | 原副作用与提交边界 | 保存路径 | 验证依据 |
| --- | --- | --- | --- | --- |
| 工具栏、菜单创建节点 | App、CanvasWorkspace、nodesSlice.addNode | 各入口默认尺寸独立；创建后选择新节点 | save session → WorkspaceService / Yjs | canvas-store、创建节点 smoke；commands 类型测试 |
| 拖动、数值输入、尺寸 | nodesSlice.moveNodes/resizeNode/patchNode、拖动预览 | 连续预览不入历史，结束一次提交；相机独立 | 原保存队列；协作入口租约 | 原 store 及拖动测试；新增 preview characterization |
| 智能排版 | nodesSlice.layoutNodes | 原网格列数、按尺寸取列宽行高、48px 横纵间距、包围盒中心 | 同上 | commands 与原 store 保存文档逐项对照 |
| 编组、解组、删除容器 | nodesSlice + normalizeCanvasHierarchy | 编组 padding 40/标题 60；删除容器保留未删子节点并保持世界坐标；清理相关边 | 同上 | commands 容器与层级一致性；service-v2 完整影响集授权 |
| 画框归属、层级 | storeHelpers.applyReparent、reorderNodes/moveNodeLayer | 世界坐标保持；父级 childIds 与顺序同步；手工选择行为不变 | 同上 | parity、canvas-v2 顺序撤销、服务端租约 |
| 文字、填充、描边、效果 | 属性面板 → patchNode/updateCreativeNode | 多层数组与旧字段回退共存；颜色/数值原预览时机保留 | 同上 | typed command 校验、原属性面板回归 |
| 路径与形状 | CanvasWorkspace 手势 / path、shape 数据 | 不重写 pen/brush 手势；Agent 接受局部坐标锚点 | 同上 | 真实类型 fixture、无效字段拒绝 |
| 引用增删 | edgesSlice.attachReference/detachReference/deleteEdges | 数字 @别名分配、移除后压紧、提示词对应清理 | 同上 | 原引用测试与 commands 原 store 对照 |
| 图片编辑与版本 | ImageEditorModal → 上传 → addImageVersion | 浏览器裁剪、翻转、批注；保留原版本身份 | 素材服务 + 原文档保存 | 原图片编辑 smoke；Agent 只关联稳定 assetId/切换已有版本 |
| 视频取帧 | 浏览器 video/canvas → 上传图片 | 首帧/当前帧/尾帧与 source.timeSec | 同上 | 原视频与取帧回归；不新增后台取帧 |
| 素材、剪贴板、历史 | assetRegistry/localMedia/clipboard/generationHistory | 稳定 assetId、引用关系、来源和历史；系统剪贴板仍手工入口 | 素材服务 + 文档 | 原导入/历史 smoke；关联类型与版本测试 |
| 生成配置与提示词 | generationSlice | 合法比例调整尺寸并保持中心；配置与提示词更改不提交生成 | 原文档保存 | parity、service-v2 无付费任务断言 |
| 生成提交与恢复 | 原 request_generation、jobs、generationController | 冻结参数、次数预算、稳定请求身份、结果保护与历史回写 | 原 jobs / assets / Agent run store | 原 45 项 Agent 生命周期测试及生成 smoke |
| 普通撤销/协作撤销 | historySlice / Yjs undo controller | 各自历史边界保留；远端同步重基并保留相机 | 原保存与协作协议 | 原 history/remote merge 测试；多人/租约/撤销浏览器场景 |
| Agent 撤销 | canvas.applyChanges | v1 保留旧记录解释；v2 逐字段、连线、顺序、画布名称条件撤销；保留后续人工内容 | 原持久化意图、提交回执 | canvas-v2、service-v2 后续人工内容和响应丢失恢复 |
| 离线、修订、冲突 | IndexedDB/outbox/save session/workspace journal | 不迁移数据、不改保存协议；命令提交前重新核验修订 | 原路径 | 原 offline/recovery 单测和 smoke；v2 修订冲突、重启恢复 |
| 性能 | viewport runtime / media demand / layer window | 无编辑器渲染结构改动；不把相机写入 Agent 变更 | 原路径 | 四项性能门禁、完整前端和浏览器回归 |

导演台、视频合成是特殊 group 卡片；脚本、音频等属于特殊 text 卡片。禁用菜单、旧模拟模块不计入新增能力。普通协作者 Agent 前后端权限差异另列既存问题，本轮不改变普通成员编辑、生成功能。
