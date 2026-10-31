import { expect, test } from '../../fixtures/e2e-env'
import { installPerformanceCanvas } from '../../performance/fixtures'
import { clickEdge } from '../../fixtures/edge-interaction'

for (const zoom of [1, 0.1]) {
  test(`edges can be independently selected, deselected and deleted at ${zoom * 100}% zoom`, async ({ page }) => {
    const fixture = await installPerformanceCanvas(page, 3, false)
    fixture.document.viewport = { x: 180, y: 180, zoom }
    fixture.document.edges = [
      { id: 'first', source: 'perf-0', target: 'perf-1', relation: 'flow' },
      { id: 'second', source: 'perf-1', target: 'perf-2', relation: 'flow' },
    ]
    await page.goto(fixture.url)
    const first = page.locator('.react-flow__edge[data-id="first"]')
    const second = page.locator('.react-flow__edge[data-id="second"]')
    await clickEdge(page, 'first')
    await expect(first).toHaveClass(/selected/)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
    await clickEdge(page, 'second', true)
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(2)
    await clickEdge(page, 'first', true)
    await expect(first).not.toHaveClass(/selected/)
    await expect(second).toHaveClass(/selected/)
    await page.keyboard.press('Delete')
    await expect(second).toHaveCount(0)
    await expect(first).toHaveCount(1)
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await page.keyboard.press('Control+z')
    await expect(second).toHaveCount(1)
    await expect(page.locator('.react-flow__node')).toHaveCount(3)

    await clickEdge(page, 'first')
    await page.locator('.react-flow__node[data-id="perf-2"] .canvas-media-node__frame').click()
    await expect(first).not.toHaveClass(/selected/)
    await page.mouse.click(1200, 700)
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(first).toHaveClass(/selected/)
    await page.keyboard.press('Escape')
    await expect(first).not.toHaveClass(/selected/)
    await clickEdge(page, 'first')
    await page.mouse.click(1200, 700)
    await expect(first).not.toHaveClass(/selected/)
  })
}

test('compact title aligns centrally and canvas toggles show their actual state', async ({ page }, testInfo) => {
  const fixture = await installPerformanceCanvas(page, 1, false)
  await page.goto(fixture.url)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
  const pill = page.locator('.canvas-top-left-pill')
  const dimensions = await pill.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const centers = ['.workspace-menu__mark', '.workspace-menu__title', '.workspace-menu__chevron', '.canvas-floating-expand-btn']
      .map(selector => { const box = el.querySelector(selector)!.getBoundingClientRect(); return box.y + box.height / 2 })
    const mark = el.querySelector('.workspace-menu__mark')!.getBoundingClientRect()
    const title = el.querySelector('.workspace-menu__title')!.getBoundingClientRect()
    return { width: rect.width, height: rect.height, centers, gap: title.x - mark.right }
  })
  expect(dimensions.height).toBe(36)
  expect(Math.max(...dimensions.centers) - Math.min(...dimensions.centers)).toBeLessThanOrEqual(1)
  expect(dimensions.gap).toBe(10)
  const bar = page.getByTestId('bottom-status-bar')
  const map = bar.getByRole('button', { name: '切换小地图' })
  const snap = bar.getByRole('button', { name: '智能吸附' })
  const connections = bar.getByRole('button', { name: '隐藏节点连线' })
  await expect(map).toHaveAttribute('aria-pressed', 'false')
  await expect(snap).toHaveAttribute('aria-pressed', 'true')
  await expect(connections).toHaveAttribute('aria-pressed', 'true')
  const before = await map.locator('svg').evaluate(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).strokeWidth }))
  await map.click()
  await expect(map).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.react-flow__minimap')).toBeVisible()
  const after = await map.locator('svg').evaluate(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).strokeWidth }))
  expect(after.fill).not.toBe(before.fill)
  expect(after.stroke).not.toBe(before.stroke)
  await connections.click()
  await expect(bar.getByRole('button', { name: '显示节点连线' })).toHaveAttribute('aria-pressed', 'false')
  await snap.click()
  await expect(snap).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.move(900, 500)
  await page.screenshot({ path: testInfo.outputPath('canvas-controls.png') })
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('libtv.ui-preferences.v1')!))
  expect(saved).toMatchObject({ showMiniMap: true, smartSnap: false, hideConnections: true })
})
