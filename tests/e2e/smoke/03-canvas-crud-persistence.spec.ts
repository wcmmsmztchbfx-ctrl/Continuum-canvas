import { expect, test } from "../../fixtures/e2e-env"

test.describe("03 - Canvas CRUD & Persistence", () => {
  test("renames, favorites, trashes, and restores canvas with persistence", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByTestId("workspace-home")).toBeVisible()

    // 1. Rename
    await page.getByRole("button", { name: "重命名 画布 1" }).click()
    const renameInput = page.getByRole("textbox", { name: "名称" })
    await renameInput.fill("已重命名画布")
    await renameInput.press("Enter")
    await expect(page.getByText("已重命名画布")).toBeVisible()

    // 2. Favorite
    const favoriteBtn = page.getByRole("button", { name: "收藏 已重命名画布" })
    await favoriteBtn.click()
    await expect(page.getByRole("button", { name: "取消收藏 已重命名画布" })).toBeVisible()

    // Filter favorites
    await page.getByRole("button", { name: "收藏", exact: true }).click()
    await expect(page.getByText("已重命名画布")).toBeVisible()

    // 3. Trash
    await page.getByRole("button", { name: "全部", exact: true }).click()
    await page.getByRole("button", { name: "移入回收站 已重命名画布" }).click()
    await expect(page.getByText("已重命名画布")).toHaveCount(0)

    // 4. Restore from trash
    await page.getByRole("button", { name: "回收站", exact: true }).click()
    await expect(page.getByText("已重命名画布")).toBeVisible()
    await page.getByRole("button", { name: "恢复 已重命名画布" }).click()
    await expect(page.getByText("回收站为空")).toBeVisible()

    // 5. Verify restored in all after reload
    await page.reload()
    await page.getByRole("button", { name: "全部", exact: true }).click()
    await expect(page.getByText("已重命名画布")).toBeVisible()
  })
})
