import { expect, test } from "../../fixtures/e2e-env"

test.describe("04 - Canvas Runtime Health", () => {
  test("starts canvas editor with 0 console errors or failed resources", async ({ page }) => {
    const pageErrors: Error[] = []
    const failedRequests: string[] = []

    page.on("pageerror", (err) => pageErrors.push(err))
    page.on("requestfailed", (req) => {
      // Ignore aborts on navigation
      if (req.failure()?.errorText !== "net::ERR_ABORTED") {
        failedRequests.push(req.url() + ": " + req.failure()?.errorText)
      }
    })

    await page.goto("/canvas?spaceId=local&projectId=reference")
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-hydrated", "true")
    await expect(page.locator(".react-flow__viewport")).toBeVisible()

    // Assert 0 unhandled runtime errors
    expect(pageErrors, "Runtime errors on canvas startup").toHaveLength(0)
    expect(failedRequests, "Failed network requests on canvas startup").toHaveLength(0)
  })
})
