import { describe, expect, it } from "vitest"
import { createCanvasStore } from "./canvas-store"
import { referenceProjectSnapshot } from "../fixtures/reference"

describe("stage layout and single-step undo verification", () => {
  it("updateTextNode with commit=false provides real-time preview without polluting undo stack", () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    store.getState().addNode({
      id: "text-test-1",
      type: "text",
      name: "文字节点",
      position: { x: 0, y: 0 },
      size: { width: 200, height: 50 },
      data: { text: "初始文字" },
    })
    expect(store.getState().canUndo).toBe(true)

    // 1. Simulate 20 typing keystrokes with commit=false
    for (let i = 1; i <= 20; i++) {
      store.getState().updateTextNode("text-test-1", `Keystroke ${i}`, false)
    }

    // Live state updated
    expect(store.getState().snapshot.nodes.find((n) => n.id === "text-test-1")?.data.text).toBe("Keystroke 20")

    // 2. Finish editing (blur/enter) commits once
    store.getState().updateTextNode("text-test-1", "Final Paragraph", true)

    // 3. Single undo rolls back entire text change in one step
    store.getState().undo()
    expect(store.getState().snapshot.nodes.find((n) => n.id === "text-test-1")?.data.text).toBe("初始文字")
  })

  it("patchNode with commit=false provides real-time transform feedback and commits once on release", () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const node = store.getState().snapshot.nodes[0]!
    const initialWidth = node.size.width

    // 1. Scrub/drag slider 50 times
    for (let step = 1; step <= 50; step++) {
      store.getState().patchNode(node.id, { size: { ...node.size, width: initialWidth + step } }, false)
    }

    // Real-time visual feedback
    expect(store.getState().snapshot.nodes[0]?.size.width).toBe(initialWidth + 50)
    // No undo history added during drag
    expect(store.getState().canUndo).toBe(false)

    // 2. Release slider (pointerup)
    store.getState().patchNode(node.id, { size: { ...node.size, width: initialWidth + 50 } }, true)
    expect(store.getState().canUndo).toBe(true)

    // 3. Single undo rolls back width
    store.getState().undo()
    expect(store.getState().snapshot.nodes[0]?.size.width).toBe(initialWidth)
    expect(store.getState().canUndo).toBe(false)
  })

  it("renameCanvas updates canvas name safely without clearing selection or wiping undo history", () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const firstNodeId = store.getState().snapshot.nodes[0]!.id

    // Select node and make a modification to create undo history
    store.getState().selectNode(firstNodeId)
    expect(store.getState().selectedNodeIds).toEqual([firstNodeId])

    store.getState().patchNode(firstNodeId, { name: "重命名节点测试" }, true)
    expect(store.getState().canUndo).toBe(true)

    // Now rename canvas from property panel
    store.getState().renameCanvas("全新生产画布名称")

    // Verifications:
    // 1. Canvas name updated
    expect(store.getState().snapshot.name).toBe("全新生产画布名称")
    // 2. Selection retained (not cleared)
    expect(store.getState().selectedNodeIds).toEqual([firstNodeId])
    // 3. Undo stack intact (not cleared by restore())
    expect(store.getState().canUndo).toBe(true)

    // 4. Undoing rolls back canvas rename
    store.getState().undo()
    expect(store.getState().snapshot.name).toBe(referenceProjectSnapshot.name)
    // 5. Undoing again rolls back node rename
    expect(store.getState().canUndo).toBe(true)
    store.getState().undo()
    expect(store.getState().snapshot.nodes[0]?.name).toBe(referenceProjectSnapshot.nodes[0]?.name)
  })
})
