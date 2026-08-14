# Canvas Edge And Generation Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the reference canvas edge activation, connection preview, connector geometry, and image/video generation detail controls without adding backend behavior.

**Architecture:** Keep edge animation inside the custom React Flow edge and derive incident-edge activation from the existing selected node state. Store generation settings as optional, validated node data so the existing snapshot repository persists them automatically; keep defaults in the settings UI for backward-compatible snapshots.

**Tech Stack:** React 19, TypeScript, `@xyflow/react`, Zustand, Vitest, Testing Library, Playwright, CSS/SVG.

---

The directory is not a Git repository, so this plan uses test checkpoints instead of commit steps.

### Task 1: Lock Edge State Behavior With Tests

**Files:**
- Modify: `src/components/canvas/CanvasEdge.test.tsx`
- Modify: `src/components/canvas/CanvasWorkspace.test.tsx`
- Modify: `tests/e2e/canvas-functional-parity.spec.ts`

- [ ] **Step 1: Replace the always-animated edge expectation**

Assert that an idle edge contains one transparent interaction path and one static base path, with no flow segments.

```tsx
expect(container.querySelector('.canvas-edge__interaction')).toBeTruthy()
expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(0)
```

- [ ] **Step 2: Add active-edge expectations**

Assert that selected, hovered, and selected-node-linked edges render exactly three sampled flow paths, while unrelated edges stay idle.

```tsx
expect(container.querySelectorAll('.canvas-edge__flow')).toHaveLength(3)
expect(linkedEdge.data?.linkedToSelected).toBe(true)
expect(unrelatedEdge.data?.linkedToSelected).toBe(false)
```

- [ ] **Step 3: Add connection-preview and connector geometry expectations**

Assert the preview has a 6px glow base, 2px main line, and three flow segments. In Playwright, normalize handle and icon bounds by viewport zoom and assert 80px and 20px canvas-space sizes centered on node side midpoints.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/components/canvas/CanvasEdge.test.tsx src/components/canvas/CanvasWorkspace.test.tsx
```

Expected: failures because the current implementation renders dash animation on every edge and does not decorate incident edges.

### Task 2: Implement Reference Edge And Connector Behavior

**Files:**
- Modify: `src/components/canvas/CanvasEdge.tsx`
- Modify: `src/components/canvas/CanvasWorkspace.tsx`
- Modify: `src/components/canvas/mapping.ts`
- Modify: `src/components/canvas/canvas.css`

- [ ] **Step 1: Add pure sampled flow geometry**

Parse the cubic path returned by `getBezierPath`, build an arc-length lookup, and return three 12%-length subpaths at evenly spaced phases.

```ts
type FlowSegment = { d: string; start: Point; end: Point }

function createFlowSegments(path: string, phase: number): FlowSegment[] {
  // Sample the cubic, map distance to points, and emit three wrapped subpaths.
}
```

- [ ] **Step 2: Render idle and active paths conditionally**

Use local pointer state plus `selected` and `data.linkedToSelected` to decide whether flow definitions and paths exist.

```ts
const flowActive = hovered || selected || Boolean(data?.linkedToSelected)
```

- [ ] **Step 3: Rebuild the connection preview**

Render the measured reference stack: `rgba(100, 180, 255, 0.4)` at 6px, the hover line at 2px, and three filtered gradient segments at 4px.

- [ ] **Step 4: Decorate incident edges from selection state**

Whenever node selection changes, set `edge.data.linkedToSelected` only for edges whose source or target is selected.

- [ ] **Step 5: Match connector geometry and settled motion**

Keep the React Flow handle at zero size, the hit area at 80 canvas pixels, the plus at 20 canvas pixels, and remove the current scale travel so activation is an opacity transition at the measured inward offset.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the Task 1 Vitest command and the focused Playwright tests for edge state and connection dragging.

### Task 3: Add Persisted Image And Video Detail Settings

**Files:**
- Create: `src/components/canvas/GenerationSettingsPopover.tsx`
- Create: `src/components/canvas/GenerationSettingsPopover.test.tsx`
- Modify: `src/components/canvas/NodeGeneratorPanel.tsx`
- Modify: `src/components/canvas/ImageNode.tsx`
- Modify: `src/components/canvas/VideoNode.tsx`
- Modify: `src/components/canvas/mapping.ts`
- Modify: `src/components/canvas/CanvasWorkspace.tsx`
- Modify: `src/components/canvas/canvas.css`
- Modify: `src/model/project.ts`
- Modify: `src/model/project.test.ts`
- Modify: `src/store/canvas-store.ts`
- Modify: `src/store/canvas-store.test.ts`

- [ ] **Step 1: Write failing model, store, and component tests**

Cover backward-compatible parsing, rejecting invalid settings, updating one media node, serialization/restore, all image/video option groups, summary updates, duration bounds, and callback payloads.

- [ ] **Step 2: Add typed optional node settings**

```ts
export interface ImageGenerationSettings {
  kind: 'image'
  quality: 'low' | 'standard' | 'high'
  resolution: '1K' | '2K' | '4K'
  aspectRatio: ImageAspectRatio
  count: 1 | 2 | 4
}
```

Add the corresponding video shape with 4-15 second duration, audio, resolution, ratio, and count.

- [ ] **Step 3: Add a surgical store mutation**

```ts
updateGenerationSettings(nodeId, settings) {
  // Validate kind against node type and commit the updated snapshot.
}
```

- [ ] **Step 4: Build the fixed-size popovers**

Implement the measured 342px dark popovers, segmented controls, ratio swatches, video range/number controls, and exact footer summaries. Keep the popover anchored to the detail button and stop canvas pointer propagation.

- [ ] **Step 5: Wire persistence and inheritance**

Pass the store callback through mapped node data. When a populated media node creates a generated downstream result, copy its generation settings to the new node.

- [ ] **Step 6: Run the focused settings tests and verify GREEN**

Run:

```bash
npm test -- src/components/canvas/GenerationSettingsPopover.test.tsx src/model/project.test.ts src/store/canvas-store.test.ts
```

### Task 4: Full Verification And Visual Comparison

**Files:**
- Modify only if verification reveals a scoped defect.

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

- [ ] **Step 2: Run lint and production build**

```bash
npm run lint
npm run build
```

- [ ] **Step 3: Run all Playwright tests**

```bash
npm run test:e2e
```

- [ ] **Step 4: Compare reference and local states in the in-app browser**

Verify idle lines, selected-edge lines, incident-node lines, unrelated idle lines, drag preview, connector centers, image detail popover, video detail popover, and settings retention after reload at desktop and a narrower viewport.

