import { expect, type Page } from '@playwright/test'

export async function hoverEdge(page: Page, id: string) {
  const path = page.locator(`.react-flow__edge[data-id="${id}"] .canvas-edge__interaction`)
  await expect(path).toBeAttached()
  // A horizontal SVG path has a zero-height bounding box. Click the actual
  // rendered stroke instead of relying on locator bounding-box actionability.
  const point = await path.evaluate((element: SVGPathElement) => {
    const middle = element.getPointAtLength(element.getTotalLength() / 2)
    const screen = new DOMPoint(middle.x, middle.y).matrixTransform(element.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.move(point.x, point.y)
  await expect.poll(() => page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('.react-flow__edge')?.getAttribute('data-id'), point)).toBe(id)
  return point
}

export async function clickEdge(page: Page, id: string, additive = false) {
  const point = await hoverEdge(page, id)
  if (additive) await page.keyboard.down('Shift')
  try {
    await page.mouse.click(point.x, point.y)
  } finally {
    if (additive) await page.keyboard.up('Shift')
  }
}
