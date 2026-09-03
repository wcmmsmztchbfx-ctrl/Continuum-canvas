import { expect, test } from "../../fixtures/e2e-env"
import { beginTextEdit, createCollaborativePair } from "../../fixtures/collaboration-helpers"

test.describe("Nightly 02 - Soft Lock & Preemption", () => {
  test("owner lease blocks peer and releasing it permits the peer edit", async ({ createTestContext }) => {
    test.setTimeout(60_000)
    const { owner, editor, nodeIds } = await createCollaborativePair(createTestContext)
    const held = await beginTextEdit(owner, nodeIds[0]!)
    await expect(held).toBeVisible()
    const peerNode = editor.locator(`.react-flow__node-text[data-id="${nodeIds[0]}"]`)
    await peerNode.click()
    await peerNode.locator('.canvas-text-node__preview').dblclick()
    await expect(peerNode.getByRole('status')).toContainText('所有者甲 正在编辑')
    await expect(peerNode.getByRole('textbox', { name: '文本节点内容' })).toHaveCount(0)

    await held.press('Escape')
    const peerEditor = await beginTextEdit(editor, nodeIds[0]!)
    await expect(peerEditor).toBeVisible()
    await peerEditor.fill('租约释放后的编辑')
    await peerEditor.press('Escape')
    await expect(owner.locator(`.react-flow__node[data-id="${nodeIds[0]}"]`)).toContainText('租约释放后的编辑')
  })
})
