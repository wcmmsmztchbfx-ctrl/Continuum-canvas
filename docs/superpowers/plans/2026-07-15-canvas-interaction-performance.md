# Canvas Interaction Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove drag jank and media flashing, then add reference-matched blank-pane double-click creation and right-click exit behavior.

**Architecture:** Keep React Flow and the current overlay system. Remove document-wide work from the edge hot path, cache edge geometry, keep drag state local until stop, and route blank-pane gestures through narrow callbacks into the existing App overlay state.

**Tech Stack:** React 19, TypeScript, `@xyflow/react`, Zustand, Vitest, Testing Library, Playwright.

---

### Task 1: Lock The Drag And Edge Performance Contract

**Files:**
- Modify: `src/components/canvas/CanvasEdge.test.tsx`
- Modify: `tests/e2e/canvas-functional-parity.spec.ts`

- [ ] **Step 1: Add a failing unit regression test**

Render `CanvasEdge`, dispatch pointer movement on `document`, and assert a spy on `document.elementFromPoint` is never called. The current per-edge global listener must make this test fail.

- [ ] **Step 2: Add a failing browser regression test**

Wrap `document.elementFromPoint`, drag a visible image node through at least 30 pointer positions, and assert the application does not perform one hit test per edge per move. Also retain one reference to the image element and assert it stays connected with the same `src` throughout the drag.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```powershell
npx vitest run src/components/canvas/CanvasEdge.test.tsx
npx playwright test tests/e2e/canvas-functional-parity.spec.ts --grep "drag hot path" --workers=1
```

Expected: both fail because the current edge implementation installs document pointer listeners.

### Task 2: Refactor Edge Hover And Animation Geometry

**Files:**
- Modify: `src/components/canvas/CanvasEdge.tsx`

- [ ] **Step 1: Remove per-edge document listeners**

Delete the edge `useEffect` that subscribes to `document`. Drive the local hover state only from `onPointerEnter` and `onPointerLeave` on `.canvas-edge__interaction`.

- [ ] **Step 2: Cache path metrics**

Split path preparation from animation sampling:

```ts
interface FlowPathMetrics {
  table: ReturnType<typeof buildLengthTable>
  totalLength: number
  segmentLength: number
}
```

Build this object with `useMemo([path])`; generate only the three moving segments from cached metrics on each active frame.

- [ ] **Step 3: Verify GREEN**

Run the Task 1 tests and expect both to pass while the existing edge layer, gradient, filter, selection, and hover tests remain green.

### Task 3: Make Node Dragging Continuous

**Files:**
- Modify: `src/persistence/uiPreferences.ts`
- Modify: `src/persistence/uiPreferences.test.ts`
- Modify: `src/components/canvas/canvas.css`
- Modify: `tests/e2e/canvas-functional-parity.spec.ts`

- [ ] **Step 1: Add failing defaults and movement assertions**

Change the preferences test to expect `snapToGrid: false`. In Playwright, move the pointer one screen pixel at a time and assert the dragged node changes position on consecutive moves instead of repeating snapped positions.

- [ ] **Step 2: Verify RED**

Run the focused preference and drag tests. Expect the preference assertion and continuous-position assertion to fail.

- [ ] **Step 3: Implement continuous drag styling and defaults**

Set `DEFAULT_UI_PREFERENCES.snapToGrid` to `false`. Add drag-only CSS that applies `will-change: transform`, disables frame transitions, and keeps media content on a stable compositor layer only while `.react-flow__node.dragging` is present.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and confirm smooth position updates, stable image identity, and no long document hit-test loop.

### Task 4: Add Blank-Pane Double Click And Right-Click Exit

**Files:**
- Modify: `src/components/canvas/CanvasWorkspace.tsx`
- Modify: `src/components/canvas/CanvasWorkspace.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `tests/e2e/overlay-interactions.spec.ts`

- [ ] **Step 1: Add failing workspace tests**

Pass `onPaneDoubleClick`, call the captured React Flow `onPaneClick` with `detail: 2`, and assert `{ x: clientX, y: clientY }` is reported. Assert `zoomOnDoubleClick` is `false`.

- [ ] **Step 2: Add failing App and browser tests**

Double click a blank pane and assert the `添加节点` menu is visible at the pointer. Right click another blank point and assert the add menu closes while the blank context menu opens.

- [ ] **Step 3: Verify RED**

Run the focused workspace, App, and overlay browser tests. Expect failure because no double-click callback exists.

- [ ] **Step 4: Implement the gesture bridge**

Add `onPaneDoubleClick` to `CanvasWorkspaceProps`. Detect `event.detail === 2` inside `onPaneClick`, disable double-click zoom, and report screen coordinates. In `App`, store an optional add-node position, pass it to `AddNodeMenu`, translate it to flow space when creating a node, and rely on `closeFloatingUi()` before opening the blank context menu.

- [ ] **Step 5: Verify GREEN**

Run the focused tests and confirm toolbar creation still uses centered placement.

### Task 5: Full Verification

**Files:**
- Verify: all changed source and test files

- [ ] **Step 1: Run static and unit checks**

```powershell
npm test
npm run lint
npm run build
```

Expected: all commands exit 0 with no warnings from project code.

- [ ] **Step 2: Run browser behavior and visual checks**

```powershell
npx playwright test --workers=1
```

Expected: every interaction, persistence, geometry, and screenshot test passes.

- [ ] **Step 3: Re-run the drag probe**

Repeat the 80-step performance probe. Expected: no application-driven `elementFromPoint` loop, no image disconnect/reload, continuous unsnapped positions, and no repeatable long frame caused by edge hover handling.
