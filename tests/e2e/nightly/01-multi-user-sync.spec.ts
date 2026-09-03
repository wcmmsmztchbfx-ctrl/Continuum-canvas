import { expect, test } from "../../fixtures/e2e-env"
import { beginTextEdit, createCollaborativePair } from "../../fixtures/collaboration-helpers"

test.describe("Nightly 01 - Multi-User Realtime Collaboration", () => {
  test("A and B synchronize distinct node mutations in both directions", async ({ createTestContext }) => {
    test.setTimeout(60_000)
    const { owner, editor, nodeIds } = await createCollaborativePair(createTestContext)
    const ownerText = await beginTextEdit(owner, nodeIds[0]!)
    await ownerText.fill("A 创建的实时变更")
    await ownerText.press("Escape")
    await expect(editor.locator(`.react-flow__node[data-id="${nodeIds[0]}"]`)).toContainText("A 创建的实时变更")

    const editorText = await beginTextEdit(editor, nodeIds[1]!)
    await editorText.fill("B 返回的实时变更")
    await editorText.press("Escape")
    await expect(owner.locator(`.react-flow__node[data-id="${nodeIds[1]}"]`)).toContainText("B 返回的实时变更")
  })
})
