import { expect, test } from "../../fixtures/e2e-env"

test.describe("02 - Canvas Lifecycle", () => {
  test("creates canvas, navigates to editor, and returns to workspace", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByTestId("workspace-home")).toBeVisible()

    // Creating a canvas adds a card; naming and opening are explicit actions.
    await page.getByRole("button", { name: "新建画布" }).click()
    await page.getByRole("button", { name: "重命名 未命名画布", exact: true }).click()
    const nameInput = page.getByRole("textbox", { name: "名称" })
    await expect(nameInput).toBeVisible()
    await nameInput.fill("生命周期测试画布")
    await nameInput.press("Enter")
    await page.getByRole("button", { name: "生命周期测试画布，0 个节点", exact: true }).click()

    // Assert in canvas editor
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(page).toHaveURL(/\/canvas\?/)

    // Return to workspace home via top-left menu
    await page.getByRole("button", { name: /打开工作区菜单/ }).click()
    await page.getByRole("menuitem", { name: "返回工作区" }).click()

    // Assert back in workspace home and the new canvas card exists
    await expect(page.getByTestId("workspace-home")).toBeVisible()
    await expect(page.getByText("生命周期测试画布")).toBeVisible()
  })
})
