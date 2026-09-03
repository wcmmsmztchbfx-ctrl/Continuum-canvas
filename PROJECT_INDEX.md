# Continuum 连点成片 - AI 架构与模块索引 (AI Project Index)

> **本文件专为 AI 辅助开发 / 新接手 AI 提供全局架构索引与代码导航。**
> 当你以 AI 身份接手本项目时，请首先阅读本文档，快速掌握系统的核心模块、状态流转、协作机制与组件体系。

---

## 1. 核心技术栈与架构概览

- **前端框架**: React 18 + TypeScript + Vite 8
- **画布引擎**: `@xyflow/react` (React Flow 12)
- **状态管理**: Zustand (`src/store/canvas-store.ts`)
- **协作引擎**: 自研 WebSocket / CRDT 混合锁协调器 (`src/collaboration/controller.ts`, `server/collaboration-service.ts`)
- **本地持久化**: IndexedDB (`src/persistence/`)
- **UI 风格**: Figma 风格暗色主题，模块化 ActivityBar + Layers + Canvas Workspace + InspectorPanel
- **测试框架**: Vitest + Playwright (Smoke & Nightly)

---

## 2. 关键目录与文件速查表 (Quick File Map)

```
src/
├── model/
│   └── project.ts                 # 核心数据模型 (CanvasNode, PathAnchor, PathNode, ShapeNode, FrameNode, ImageNodeData, etc.)
├── store/
│   └── canvas-store.ts            # 全局 Zustand 画布状态库 (CRUD、变换、图层管理、多选、编组、历史记录)
├── components/
│   ├── shell/
│   │   ├── TopBar.tsx             # 顶部栏 (多人协作、在线成员头像)
│   │   ├── WorkspaceMenu.tsx      # 左上角浮动胶囊 (工作区切换、画布选择、展开图层 [ ▤ ])
│   │   ├── BottomStatusBar.tsx    # 底部状态栏 (缩放、网格、对齐吸附、全局全屏/全显)
│   │   └── ToolDock.tsx           # 底部/浮动工具栏 (选择、移动、画框F、矩形/圆形R、画笔/钢笔P、文字T)
│   ├── inspector/
│   │   ├── InspectorPanel.tsx     # 右侧 Figma 风格属性检查器 (变换、透明度、填充、描边实虚线、模糊/阴影滤镜、路径控制)
│   │   ├── ScrubbableLabel.tsx    # 左右拖拽滑动手感数字标签 (X, Y, W, H, 字号, 圆角, 线宽, 透明度)
│   │   └── inspector.css          # 检查器暗色主题样式
│   ├── canvas/
│   │   ├── CanvasWorkspace.tsx    # 画布主工作区 (ReactFlow 实例、拖拽吸附、选区、快捷键绑定)
│   │   ├── CanvasPenOverlay.tsx   # 钢笔绘制交互层 (实时贝塞尔曲线、橡皮筋虚线、起点14px吸附闭合、Shift 45° 约束)
│   │   ├── CanvasPathEditorOverlay.tsx # 矢量二次编辑层 (顶点/贝塞尔控制手柄拖拽微调、Alt解耦手柄、线段插点、按键删点)
│   │   ├── pathUtils.ts           # 矢量几何与贝塞尔数学纯函数库 (SVG 指令生成、外接矩形自适应、归一化、吸附)
│   │   ├── LayersPanel.tsx        # 图层树列表面板 (可见性、锁定、重命名、拖拽排序)
│   │   ├── CreativeNodes.tsx      # FrameNode (画框)、ShapeNode (图形)、PathNode (矢量/钢笔路径)
│   │   ├── TextNode.tsx           # TextNode (即时排版文本节点，字号/字重/对齐)
│   │   ├── ImageNode.tsx          # ImageNode (双模式：AI生成卡片 vs 自由编辑图层)
│   │   ├── VideoNode.tsx          # VideoNode (双模式：AI生成卡片 vs 自由播放图层，支持时间戳关键帧提取)
│   │   ├── NodeGeneratorPanel.tsx # 节点内置 AI 生成面板 (Prompt、参考图选取、参数设置)
│   │   ├── ImageEditorModal.tsx   # 内置图像编辑器 (非破坏性衍生版本回溯)
│   │   ├── CollaborationPresenceLayer.tsx # 协作指针与多选选区实时渲染层
│   │   └── mapping.ts             # ReactFlow Node 与 ProjectSnapshot CanvasNode 之间的适配映射
│   ├── overlays/                  # 弹窗与抽屉 (AssetManager, SettingsModal, SidePanel, KeyboardShortcuts)
│   └── providers/                 # 模型与 API 服务商管理 (ProviderDrawer, ProviderCatalog)
├── collaboration/
│   ├── controller.ts              # 协作客户端状态机与断线重连
│   ├── connection.ts              # WebSocket 通信封装
│   └── capabilities.ts            # 用户权限 (Owner, Editor, Viewer)
├── server/
│   ├── providers/                 # 多模型适配器 (MiniMax, OpenAI, ComfyUI, 火山引擎, 可灵, 即梦, RunningHub, etc.)
│   ├── collaboration-service.ts   # 后端协作服务 (房间仲裁、广播、租约管理)
│   └── http-gateway.ts            # REST API 网关、静态资源托管、任务执行与文件存储
└── App.tsx                        # 应用总入口组装 (布局流、快捷键分发、弹窗挂载)
```

---

## 3. 核心功能与模块机制详解

### 3.1 钢笔工具与矢量编辑模式 (`src/components/canvas/`)
- **实时绘制 (`CanvasPenOverlay.tsx`)**：
  - 单击放置直线折点，拖拽拉出对称平滑贝塞尔手柄（`in` 与 `out`）；
  - 动态橡皮筋虚线引导；
  - 靠近起点 14px 范围内自动吸附并高亮绿色闭合光环，点击即可一键闭合；
  - 按住 `Shift` 进行 0°/45°/90° 水平垂直角度约束；
  - `Backspace` / `Delete` 撤回上一个锚点；`Enter` / `Esc` 提交开放路径；
  - 绘制完成后自动切回选择工具并选中新路径。
- **矢量编辑态 (`CanvasPathEditorOverlay.tsx`)**：
  - 双击 `PathNode` 或在属性面板点击【编辑路径】进入；
  - 显示所有顶点锚点方块与选中锚点的贝塞尔手柄连线；
  - 拖拽锚点移动顶点位置，拖拽手柄微调曲率；
  - 按住 `Alt` 键拖拽单边手柄实现**解耦非对称曲线**；
  - 点击线段任意空白位置插入新锚点，选中锚点按 `Delete` / `Backspace` 删除；
  - 双击空白处或按 `Esc` / `Enter` 退出编辑模式，自动重算外接矩形包裹与相对坐标。

### 3.2 Figma 风格右侧属性检查器 (`src/components/inspector/InspectorPanel.tsx` & `ScrubbableLabel.tsx`)
- **极简黑白线条图标**：全模块配备精细简约黑白图标修饰；
- **数值标签拖拽滑动调节 (Scrubbable Drag Inputs)**：
  - 悬停于 X, Y, W, H, 旋转, 字号, 圆角, 线宽, 透明度标签时左右滑动平滑微调数值，按住 `Shift` 享 10 倍步长；
- **视觉效果卡片 (Effects)**：
  - 高斯模糊 (Gaussian Blur) 开关与半径调节；
  * 外投影 (Drop Shadow) 开关、偏移 X/Y、模糊半径与色彩选择器；
- **描边与线型 (Stroke)**：线宽调节、实线 (Solid) / 虚线 (Dashed) 分段切换；
- **独立透明度 (Opacity)**：专用透明度分组与百分比拖拽微调；
- **路径专属控制 (Path)**：【编辑路径】快捷按钮与【路径闭合 (Closed)】开关；
- **多选批量操作**：批量调节透明度、批量修改填充颜色与编组 (Ctrl+G)。

### 3.3 画布节点体系与双模式设计 (`src/model/project.ts` & `src/components/canvas/`)
- **画框 (`frame`)**: 预设画幅 (16:9, 9:16, 1:1, A4) 与自定义尺寸、背景填充、描边及旋转。
- **图形 (`shape`)**: 矩形 (rectangle) 与椭圆 (ellipse)，支持圆角 (radius)、透明度 (opacity)、描边。
- **文本 (`text`)**: 即时排版模式，支持字号 (fontSize)、字重 (fontWeight)、对齐 (textAlign)、颜色 (color)。
- **图片 (`image`) & 视频 (`video`)**:
  - `displayMode === 'generation'` (默认): 经典 AI 创作卡片，带有提示词框、参考图拾取、版本切换和生成按钮；
  - `displayMode === 'layer'` (自由图层): 纯媒体无边框图层，配合 8 控制点 `NodeResizer`，支持自由拉伸缩放、圆角、透明度、描边与滤镜。
- **视频关键帧提取**: 播放视频时一键抓取当前精确时间戳的关键帧，生成独立图片节点无缝衔接图生图/图生视频。

### 3.4 多模型供应商适配器 (`server/providers/`)
- 已内置并开箱即用：MiniMax、OpenAI 兼容接口、ComfyUI 本地工作流、火山引擎 VolcEngine、RunningHub、ModelScope、快手可灵 Kling、阿里通义千问 DashScope、即梦 Jimeng、AIStartLab。
- 密钥由本地安全网关注入，前端界面绝不接收或暴露明文密钥。

### 3.5 多人实时协作引擎 (`src/collaboration/` & `server/collaboration-service.ts`)
- **租约机制 (Lease System)**: 节点编辑时申请短期交互租约，避免并发修改冲突；
- **图层分离与性能优化**: 指针层与选区锁定层采用独立 `memo` 渲染，避免高频指针广播触发整个画布重绘；
- **内网穿透与自托管协同**: 支持通过局域网 (LAN Share) 或临时穿透隧道实现一键联机。

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

## 5. 测试与代码质量门禁
- **代码规范检查**: `npm run lint` (0 warning, 0 error)
- **前端单元测试**: `npm test` (82 个测试套件，745 项测试全绿)
- **服务端单元测试**: `npm run test:server` (38 个测试套件，483 项测试全绿)
- **生产构建检查**: `npm run build`
- **E2E 核心冒烟测试**: `npm run test:e2e:smoke` (19 项测试全绿)
