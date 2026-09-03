import { expect, test } from "../../fixtures/e2e-env"

test.describe("01 - Workspace Browse & Search", () => {
  test("displays flat canvas list, searches and sorts correctly", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByTestId("workspace-home")).toBeVisible()

    // Verify topbar search box
    const searchBox = page.getByRole("searchbox", { name: "搜索工作区" })
    await expect(searchBox).toBeVisible()

    // Verify cards are rendered
    const cardButtons = page.locator(".workspace-canvas-card__open")
    await expect(cardButtons.first()).toBeVisible()

    // Test search filter
    await searchBox.fill("画布 1")
    await expect(page.getByRole("option", { name: /画布 1/ })).toBeVisible()
    await searchBox.clear()

    // Verify sort selector
    const sortSelect = page.getByRole("combobox", { name: "画布排序" })
    await expect(sortSelect).toBeVisible()
    await sortSelect.selectOption("name")
    await expect(sortSelect).toHaveValue("name")
  })
})
