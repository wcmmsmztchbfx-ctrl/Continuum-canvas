# Canvas Interaction Performance Design

## Goal

Make direct manipulation feel continuous and stable while matching the reference canvas behavior for blank-canvas double click and right click.

## Measured Problems

- Dragging 80 pointer steps with 27 edges currently triggers 2,160 `document.elementFromPoint` calls.
- The same drag produces long main-thread tasks up to 139 ms.
- The default 12 px snap grid repeats node positions across pointer steps and then jumps, which feels like resistance.
- Media elements stay mounted and do not reload during dragging; the visible flashing is dropped-frame/compositing instability rather than image lifecycle churn.
- The blank pane has no double-click path into the existing add-node menu.

## Interaction Design

### Dragging

- Keep React Flow as the interaction engine.
- Disable grid snapping by default so one pointer movement produces one continuous node movement.
- Keep transient positions in React Flow local state and persist only from `onNodeDragStop`.
- Promote only the actively dragged node to a compositor layer and suppress decorative transitions during the drag.

### Edge Hover And Animation

- Remove all per-edge document listeners and document-wide hit testing.
- Use the transparent SVG hit path's own pointer enter and leave events.
- Keep flow effects inactive unless an edge is hovered, selected, or incident to a selected node.
- Parse and sample each Bezier path once per geometry change; animation frames only advance points through cached path metrics.

### Blank Canvas Creation

- Disable React Flow's double-click zoom.
- A double click on the blank pane opens the existing add-node menu at the pointer's screen position.
- The next node selected from that menu is centered on the corresponding flow-space point.
- Toolbar-based node creation keeps its existing centered placement.

### Right Click

- A right click while the add-node menu is open closes that menu first.
- The same right click then opens the existing blank-canvas context menu at the pointer position, matching the reference behavior.

## Boundaries

- No new dependency or canvas engine.
- No backend or project-schema changes.
- No broad visual redesign.
- Existing connection, selection, generation, resize, undo, and persistence behavior must remain intact.

## Verification

- Unit tests prove edge hover no longer performs document-wide hit testing.
- Workspace tests prove double-click zoom is disabled and pane double clicks report pointer coordinates.
- App tests prove double click opens the add-node menu and right click replaces it with the blank context menu.
- Browser tests prove continuous unsnapped movement, no media remount/reload, low document hit-test counts, and correct double-click/right-click behavior.
- Full unit, lint, build, browser interaction, and visual suites must pass.
