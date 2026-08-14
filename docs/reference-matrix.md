# LibTV canvas reference matrix

## Scope and evidence

- Reference: `https://www.liblib.tv/canvas?spaceId=2843121&projectId=636acc13e3504082b3cdb3a6c40d0d37`
- Audit date: 2026-07-15
- Local target: `/canvas?spaceId=local&projectId=reference`
- Remote actions that spend credits, publish, invite, upload, purchase, or change account data were not submitted.
- Membership, points, shop, sales, and recharge surfaces are visual-only scope. No commercial logic is implemented locally.
- Status values: `consistent`, `missing`, `wrong`, `performance`, `visual-only`, `not-applicable`.

## Shell geometry

Primary reference capture: `tests/visual/reference/canvas-primary-2552x1308.png`.

| Region | x | y | width | height |
| --- | ---: | ---: | ---: | ---: |
| Workspace control | 16 | 20 | 234 | 40 |
| Mode switch frame | 1186 | 19 | 180 | 42 |
| Active mode segment | 1191 | 24 | 83 | 32 |
| Share button | 2162 | 20 | 40 | 40 |
| Asset/shop button | 2210 | 20 | 42 | 40 |
| Membership cluster | 2260 | 10 | 179 | 50 |
| Agent button | 2447 | 20 | 89 | 40 |
| Bottom tool dock | 1126 | 1246 | 300 | 50 |

Reference styles:

- Canvas background `#141414` with a restrained dot grid.
- Top controls are 40px high; mode segments are 32px high with 8px radius.
- Nodes retain readable labels and visible connections at 20% zoom.
- Dock and status controls remain viewport-fixed at `1366x768`, `1440x900`, and `1920x1080`.

## Direct canvas operations

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| CAN-01 | Blank left-drag draws a marquee. It does not pan the canvas. Fully enclosed nodes are selected; a larger marquee selects multiple nodes. | consistent | E2E selects one and two nodes with marquee drags. |
| CAN-02 | Middle-button drag pans in normal selection mode. Space/mouse and touchpad panning are also documented by the shortcut panel. | consistent | Middle drag changes viewport while node positions remain fixed. |
| CAN-03 | Plain wheel pans; Ctrl+wheel/pinch zooms around the pointer. | consistent | React Flow pan/zoom behavior is enabled without replacing native wheel handling. |
| CAN-04 | Zoom range is 10%-800%; menu offers zoom in, zoom out, fit, 50%, 100%, and 800%. | consistent | Status zoom menu exposes all commands and editable percentage. |
| CAN-05 | Grid snap is off by default. Clicking `网格吸附` enables it; dragging is otherwise continuous. | consistent | Preference default is false and drag positions are not quantized. |
| CAN-06 | Blank double-click opens `添加节点` at the pointer. React Flow double-click zoom is disabled. | consistent | Native wrapper double-click opens once on `.react-flow__pane`; node double-click does not open it. |
| CAN-07 | Escape closes add/settings/model/reference popovers. Outside click closes the topmost floating surface. | consistent | Overlay stack closes one layer at a time without clearing selection. |
| CAN-08 | Blank right-click replaces temporary add/connection menus with the blank context menu. | consistent | Right-click first cancels pending state, then opens the new context menu at the pointer. |
| CAN-09 | Auto-layout rearranges nodes and then asks `是否保留此次整理结果？`; `还原` restores exact positions. | consistent | Local preview supports keep/restore before committing persistence. |
| CAN-10 | Minimap is hidden by default and toggled from the status bar. | consistent | Toggle renders/removes a React Flow minimap without shifting shell controls. |
| CAN-11 | Connection visibility toggle removes all edge DOM and changes to `显示节点连线`; toggling again restores edges. | consistent | Exact labels and state are reflected in the status bar. |
| CAN-12 | Fit canvas animates to visible content and persists the final viewport. | consistent | Fit command updates and persists viewport once. |

## Nodes, selection, and connections

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| NOD-01 | Clicking a node selects it and opens its type editor. Clicking blank releases selection. | consistent | Exactly one editor is open for a single selection. |
| NOD-02 | Marquee multi-select followed by Ctrl+G creates a parent group; Ctrl+Shift+G removes it and restores children. | consistent | Group and ungroup are both undoable and preserve absolute child positions. |
| NOD-03 | Ctrl+D creates a selected duplicate. Delete removes selected nodes. Ctrl+Z restores either action. | consistent | Unit and E2E cover duplicate/delete/undo. |
| NOD-04 | Dragging is continuous with snap off. The media DOM element and URL remain stable throughout the drag. | consistent | 80-step drag performs no edge-count multiplied hit testing and no media remount/source change. |
| NOD-05 | Each node has zero-size React Flow handles at left/right center, wrapped by an 80x80 hit target and a 20x20 plus control. | consistent | Handle hit region and plus geometry match at all zooms. |
| NOD-06 | Dragging right handle to another node's left handle immediately creates a persisted edge. | consistent | Edge count increments once; undo restores it. |
| NOD-07 | Dropping a connection on blank keeps a connection preview at the pointer and opens `引用该节点生成`: text, image, video, video synthesis disabled, director, audio, script, reference disabled. | consistent | No visible placeholder card; selecting a type creates and connects one node. |
| NOD-08 | Node right-click menu contains compliance/save/subject disabled rows, copy node, duplicate, paste, delete, and copy to clipboard. | consistent | Menu labels, order, disabled states, shortcuts, and closing behavior match. |
| NOD-09 | Blank context menu contains upload, save to assets disabled, add node, undo, redo, and paste. | consistent | Exact labels/order/disabled states and dynamic undo/redo state. |
| NOD-10 | Node resizing is not exposed on the audited image/video/text placeholders; media cards keep their aspect-controlled size. | not-applicable | Do not add visible resize handles unless another reference state proves them. |

## Edge rendering and animation

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| EDG-01 | Idle edge: 40px transparent hit path plus 2px `--canvas-edge` base path. | consistent | Hit path widened from 20px to 40px (experience fix) so fast pointer sweeps reliably trigger the hover highlight and flow. DOM and computed stroke widths match. |
| EDG-02 | Selected edge: 3px selected base plus three moving 4px light segments. | consistent | Only the selected edge animates. |
| EDG-03 | Selecting a node animates only incident edges; unrelated edges remain two-path idle edges. | consistent | Incident edges have five paths; unrelated edges have two. |
| EDG-04 | Hovering an edge triggers the same light flow; leaving stops it. | consistent | Pointer enter/leave is owned by the edge hit path, without document listeners. |
| EDG-05 | Flow gradient fades from transparent to rgba(100,180,255,.9); outer blur 4/.45 and inner blur 1.5/.7. | consistent | SVG gradients and filters match. |
| EDG-06 | Connection preview uses a 6px blue glow, 2px base, and three moving segments. | consistent | Preview geometry and animation match the persisted edge. |

## Node creation and editors

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| ADD-01 | Add menu order: text, image, video, video synthesis Beta, director NEW, audio, script, asset library NEW; resource section: upload, choose from generation history. | consistent | Toolbar and pointer menus share the exact grouped content. |
| ADD-02 | New image node opens the image editor: references, mark, style, prompt, model, settings, preset, utilities, cost, generate. | consistent | Empty image node can complete a local simulated generation. |
| ADD-03 | New video node opens the video editor: references, mark, effects, character library, camera motion, prompt, model, mode, settings, utilities, cost, generate, advanced settings. | consistent | Empty video node can complete a local simulated generation. |
| ADD-04 | New text node is a square editable Markdown/text card with suggested actions. | consistent | Text editing persists and does not trigger canvas shortcuts. |
| ADD-05 | Video synthesis node displays `空空如也，请连接视频节点后操作`. | consistent | Dedicated lightweight node type and empty state. |
| ADD-06 | Director node displays a 3D scene description and `打开导演台`. | consistent | Dedicated visual node; button opens a local visual-only panel. |
| ADD-07 | Audio node displays an audio placeholder and `音频生视频` suggestion. | consistent | Dedicated lightweight node type. |
| ADD-08 | Script entry is a nested entry; script nodes are text/script-oriented. | consistent | Nested affordance is visible and a script node can be created locally. |

## Generation configuration and local loop

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| GEN-01 | Image settings: low/standard/high; 1K/2K/4K; 13 aspect ratios; 1/2/4 images. Summary `16:9 · 标准画质 · 2K · 1张`. | consistent | All options update the summary and persist. |
| GEN-02 | Video settings: Auto/16:9/4:3/1:1/3:4/9:16/21:9; 480P/720P/1080P/4K; duration 4-15s default 5; audio on/off; 1/2/4. | consistent | All options update `16:9 · 720P · 5s · 1个 · audio`. |
| GEN-03 | Video mode menu: text-to-video disabled where invalid, universal reference, image-to-video, first/last frame, image reference. | consistent | Menu is present and mode constraints update locally. |
| GEN-04 | Model menus show model name, approximate duration, and description. Promotional badges are visual-only. | consistent | Lightweight deterministic model list; no purchase or credit logic. |
| GEN-05 | Submit starts generation state, then produces a result node when appropriate. | consistent | Local mock transitions idle -> generating -> result/error without remote calls. |
| GEN-06 | Existing result generation creates a connected result node; empty-node generation fills the current node. | consistent | Both paths are undoable and references are preserved. |

## Shell and overlays

| ID | Reference operation and result | Local status | Acceptance |
| --- | --- | --- | --- |
| SHL-01 | Toolbar order/labels: add node, toolbox, asset library, character library, history, shortcuts, tutorial. | consistent | Exact accessible labels and mutually exclusive active panels. |
| SHL-02 | Toolbox is a left library of reusable presets with `使用` actions. | consistent | Visual library only; choosing a preset adds a local mock node set. |
| SHL-03 | Asset library opens style/effect entries and full library dialogs. | consistent | Visual-only asset browsing; no remote collection/commercial actions. |
| SHL-04 | Character library shows selected character details, references, filters, and `应用至画布`. | consistent | Applying creates a local reference node only. |
| SHL-05 | History has image/video/audio tabs, sort, batch action, zoom controls, and empty state. | consistent | Local history only. |
| SHL-06 | Shortcut panel lists creation, zoom, pan, undo/redo, and delete shortcuts. | consistent | Labels and key combinations match the reference. |
| SHL-07 | Tutorial popover contains guide, customer service, sales, and social entries. | visual-only | Keep shell UI; sales/contact actions are disabled locally. |
| SHL-08 | Asset manager is a left workspace panel with canvas/assets tabs, type filter, node search, locate, and per-node more menu. | consistent | Locate selects and centers a node. |
| SHL-09 | Workflow displays the graph. Storyboard displays text/image/video sections and reference controls. | consistent | Mode switch is functional and returns without losing graph state. |
| SHL-10 | Membership, points, shop, and Agent remain visible shell UI. | visual-only | No recharge, upgrade, purchase, or credit deduction logic. |

## Quality gates

| ID | Gate | Result |
| --- | --- | --- |
| QLT-01 | Unit tests, type check, lint, production build, full E2E, and visual regression pass. | pass: 149 unit tests and 37 E2E tests |
| QLT-02 | Key layouts pass at `1366x768`, `1440x900`, and `1920x1080` with no incoherent overlap. | pass: automated geometry plus browser screenshots |
| QLT-03 | An 80-step media drag keeps the same element, source URL, and connected state. | pass |
| QLT-04 | Pointer movement performs no `edges x pointer steps` document hit-test loop. | pass |
| QLT-05 | Idle edges do not run animation frames; only hovered, selected, or incident edges animate. | pass |
| QLT-06 | Refresh restores project snapshot, viewport, panel preference, snap state, and connection visibility. | pass |
