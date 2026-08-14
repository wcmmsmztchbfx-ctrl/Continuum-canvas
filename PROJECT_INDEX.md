# LibTV Canvas Frontend - AI 架构与模块索引 (AI Project Index)

> **本文件专为 AI 辅助开发 / 新接手 AI 提供全局架构索引与代码导航。**
> 当你以 AI 身份接手本项目时，请首先阅读本文档，快速掌握系统的核心模块、状态流转、协作机制与组件体系。

---

## 1. 核心技术栈与架构概览

- **前端框架**: React 18 + TypeScript + Vite
- **画布引擎**: `@xyflow/react` (React Flow 12)
- **状态管理**: Zustand (`src/store/canvas-store.ts`)
- **协作引擎**: 自研 WebSocket / CRDT 混合锁协调器 (`src/collaboration/controller.ts`, `server/collaboration-service.ts`)
- **本地持久化**: IndexedDB (`src/persistence/`)
- **UI 风格**: Figma 风格暗色主题，模块化 ActivityBar + Layers + Canvas Workspace + InspectorPanel

---

## 2. 关键目录与文件速查表 (Quick File Map)

```
src/
├── model/
│   └── project.ts                 # 核心数据模型 (CanvasNode, ShapeNode, FrameNode, ImageNodeData, VideoNodeData, etc.)
├── store/
│   └── canvas-store.ts            # 全局 Zustand 画布状态库 (CRUD、变换、图层管理、多选、编组、历史记录)
├── components/
│   ├── shell/
│   │   ├── ActivityBar.tsx        # 左侧 48px 快速导航条 (图层、素材、API 接入、设置)
│   │   ├── TopBar.tsx             # 顶部栏 (多人协作、Agent 助手、在线成员头像)
│   │   ├── BottomStatusBar.tsx    # 底部状态栏 (缩放、网格、对齐吸附、全局全屏/全显)
│   │   └── ToolDock.tsx           # 底部/浮动工具栏 (选择、移动、画框F、矩形/圆形R、画笔P、文字T)
│   ├── inspector/
│   │   ├── InspectorPanel.tsx     # 右侧 Figma 风格属性检查器 (变换、字号、填充、描边、圆角、模式切换)
│   │   └── inspector.css          # 检查器暗色主题样式
│   ├── canvas/
│   │   ├── CanvasWorkspace.tsx    # 画布主工作区 (ReactFlow 实例、拖拽吸附、选区、快捷键绑定)
│   │   ├── LayersPanel.tsx        # 图层树列表面板 (可见性、锁定、重命名、拖拽排序)
│   │   ├── CreativeNodes.tsx      # FrameNode (画框)、ShapeNode (图形)、PathNode (矢量/手绘)
│   │   ├── TextNode.tsx           # TextNode (即时排版文本节点，无阻挡图标)
│   │   ├── ImageNode.tsx          # ImageNode (双模式：AI生成卡片 vs 自由编辑图层)
│   │   ├── VideoNode.tsx          # VideoNode (双模式：AI生成卡片 vs 自由播放图层)
│   │   ├── NodeGeneratorPanel.tsx # 节点内置 AI 生成面板 (Prompt、参考图选取、参数设置)
│   │   ├── CollaborationPresenceLayer.tsx # 协作指针与多选选区实时渲染层
│   │   └── mapping.ts             # ReactFlow Node 与 ProjectSnapshot CanvasNode 之间的适配映射
│   ├── overlays/                  # 弹窗与抽屉 (ApiIntegration, History, SidePanel, KeyboardShortcuts)
│   └── providers/                 # 模型与 API 服务商管理 (ProviderDrawer, ProviderCatalog)
├── collaboration/
│   ├── controller.ts              # 协作客户端状态机与断线重连
│   ├── connection.ts              # WebSocket 通信封装
│   └── capabilities.ts            # 用户权限 (Owner, Editor, Viewer)
├── server/
│   ├── collaboration-service.ts   # 后端协作服务 (房间仲裁、广播、租约管理)
│   └── server.ts                  # 本地 Node 开发服务器入口
└── App.tsx                        # 应用总入口组装 (布局流、快捷键分发、弹窗挂载)
```

---

## 3. 核心功能与模块机制详解

### 3.1 画布节点体系与双模式设计 (`src/model/project.ts` & `src/components/canvas/`)
- **画框 (`frame`)**: 支持预设画幅 (16:9, 9:16, 1:1, A4) 与自定义尺寸、背景填充、描边及旋转。
- **图形 (`shape`)**: 支持矩形 (rectangle) 与椭圆 (ellipse)，支持圆角 (radius)、透明度 (opacity)、描边。
- **文本 (`text`)**: 即时排版模式，支持字号 (fontSize)、字重 (fontWeight)、对齐 (textAlign)、颜色 (color)。
- **图片 (`image`) & 视频 (`video`)**:
  - `displayMode === 'generation'` (默认): 经典 AI 创作卡片，带有提示词框、参考图拾取、版本切换和生成按钮。
  - `displayMode === 'layer'` (自由图层): 纯媒体无边框图层，配合 8 控制点 `NodeResizer`，支持自由拉伸缩放、圆角、透明度、描边与旋转，受右侧 `InspectorPanel` 控制。

### 3.2 Figma 风格右侧属性检查器 (`src/components/inspector/InspectorPanel.tsx`)
- **选区响应**:
  - **无选中**: 显示画布全局属性 (名称、缩放比例、对象总数、设置入口)。
  - **单选节点**:
    - **变换 (Transform)**: X, Y, W, H, 旋转角度, 等比例缩放锁定。
    - **节点模式**: 图片/视频可一键在 “AI 生成卡片” 与 “自由编辑图层” 之间切换。
    - **文本排版 (Typography)**: 字号、字重、左/中/右对齐、颜色拾取器与 HEX 输入。
    - **填充与描边 (Fill & Stroke)**: 原生色彩选择器、十六进制颜色代码、描边粗细。
    - **外观与图层 (Layer & Opacity)**: 透明度滑动调节、上移置顶、下移置底、可见性切换、锁定切换。
  - **多选节点**: 显示选中数量、批量编组 (Ctrl+G)、批量删除。

### 3.3 左侧活动导航条 (`src/components/shell/ActivityBar.tsx`)
- 宽度为 48px，位于界面最左侧。
- 负责切换主视图抽屉：
  - `图层 (Layers)`: 展开/折叠图层侧边栏。
  - `素材 (Assets)`: 呼出资产库。
  - `API (Providers)`: 呼出 API 接入与模型服务抽屉。
  - `设置 (Settings)`: 呼出全局设置与快捷键说明。

### 3.4 多人实时协作引擎 (`src/collaboration/` & `server/collaboration-service.ts`)
- **租约机制 (Lease System)**: 节点编辑时客户端向服务端申请短期交互租约 (`runWithNodeLease` / `withBulkLease`)，防止多人同时修改同一节点产生冲突。
- **图层分离与性能优化**:
  - 指针层 (`RemoteCursorsLayer`) 与选区锁定层 (`RemoteSelectionsAndLocksLayer`) 采用独立 `memo` 渲染，避免高频指针广播触发整个 React Flow 画布重渲染。
  - 服务端 `validationDocument` 采用缓存校验，减少 JSON 序列化开销。
- **连线与流图支持**: 连线事件 (`handleConnect`) 具备降级保护，支持自由跨节点连线。

---

## 4. 常见开发与扩展指南

### 如何添加一种新的节点类型？
1. 在 `src/model/project.ts` 中的 `CanvasNode` 联合类型中增加新的 Node 接口和 Data 接口。
2. 在 `isCanvasNode` 校验函数中补充对应类型的字段验证规则。
3. 在 `src/components/canvas/` 中创建对应的节点 UI 组件，并在 `src/components/canvas/mapping.ts` 中注册至 nodeTypes。
4. 在 `src/components/inspector/InspectorPanel.tsx` 中增加该节点专属的属性编辑区块。
5. 在 `src/store/canvas-store.ts` 中如有专属动作添加相应 action。

### 如何触发全局状态更新？
- 使用 `canvasStore.getState().patchNode(nodeId, partialChanges)` 进行局部属性合并。
- 使用 `canvasStore.getState().updateCreativeNode(nodeId, changes)` 进行矢量/图形属性更新。
- 使用 `canvasStore.getState().selectNode(nodeId)` 更改当前选中项（右侧属性栏会自动响应）。

---

## 5. 测试与代码质量规范
- **运行单元测试**: `npm test`
- **构建生产包**: `npm run build`
- **代码规范**: 保持组件高内聚，纯样式抽离至专用 CSS 文件，遵守暗色主题调色板规范。
