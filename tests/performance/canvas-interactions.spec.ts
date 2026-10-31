import { test, expect } from '@playwright/test'
import { installPerformanceCanvas } from './fixtures'

const sizes = (process.env.PERF_SIZES ?? '100,500,1000').split(',').map(Number)
const rounds = Number(process.env.PERF_ROUNDS ?? '5')
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0
for (const count of sizes) for (const allVisible of [false, true]) for (let round = 0; round < rounds; round++) {
  test(count + ' nodes ' + (allVisible ? 'overview' : 'local') + ' round ' + round, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const fixture = await installPerformanceCanvas(page, count, allVisible)
    await page.goto(fixture.url)
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated', 'true')
    await expect(page.locator('.react-flow__node')).toHaveCount(count)
    await page.waitForTimeout(2500)
    const results = []
    for (const cache of (process.env.PERF_CACHE_MODES ?? 'cold,resident').split(',')) {
    if (cache === 'resident') {
      await page.evaluate(({viewport, position}) => {
        const store = (window as any).__canvasStore.getState()
        store.moveNodes([{id: 'perf-0', position}])
        store.setViewport(viewport)
      }, { viewport: fixture.document.viewport, position: fixture.document.nodes[0].position })
      await page.waitForTimeout(3000)
    }
    for (const phase of ['drag', 'pan', 'zoom']) {
      const before = await page.evaluate(() => {
        const snapshot = (window as any).__canvasStore.getState().snapshot
        return { position: { ...snapshot.nodes.find((node: any) => node.id === 'perf-0').position }, viewport: { ...snapshot.viewport } }
      })
      await page.evaluate(() => {
        const state = { frames: [] as number[], tasks: [] as number[], active: true, previous: 0 }
        ;(window as unknown as { perfSample: typeof state }).perfSample = state
        const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if (state.active) state.tasks.push(entry.duration) })
        observer.observe({ type: 'longtask' })
        const tick = (now: number) => {
          if (!state.active) { observer.disconnect(); return }
          if (state.previous) state.frames.push(now - state.previous)
          state.previous = now
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      if (phase === 'drag') {
        const box = await page.locator('.react-flow__node[data-id="perf-0"]').boundingBox()
        expect(box).not.toBeNull()
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await page.mouse.down()
        await page.mouse.move(box!.x + box!.width / 2 + 90, box!.y + box!.height / 2 + 45, { steps: 45 })
        await page.mouse.up()
      } else if (phase === 'pan') {
        await page.mouse.move(900, 700)
        await page.mouse.down({ button: 'middle' })
        await page.mouse.move(990, 745, { steps: 45 })
        await page.mouse.up({ button: 'middle' })
      } else {
        await page.mouse.move(900, 450)
        await page.keyboard.down('Control')
        for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, allVisible ? -90 : 90); await page.waitForTimeout(20) }
        await page.keyboard.up('Control')
      }
      await page.waitForTimeout(300)
      const sample = await page.evaluate(() => {
        const state = (window as unknown as { perfSample: { active: boolean; frames: number[]; tasks: number[] } }).perfSample
        state.active = false
        return { frames: state.frames, tasks: state.tasks }
      })
      const readOutcome = () => page.evaluate(phase => {
        const snapshot = (window as any).__canvasStore.getState().snapshot
        return phase === 'drag' ? snapshot.nodes.find((node: any) => node.id === 'perf-0').position : phase === 'pan' ? snapshot.viewport : snapshot.viewport.zoom
      }, phase)
      await expect.poll(readOutcome, { timeout: 6000, message: count + ' ' + cache + ' ' + phase + ' must change the document/camera' }).not.toEqual(phase === 'drag' ? before.position : phase === 'pan' ? before.viewport : before.viewport.zoom)
      results.push({ cache, phase, p95: percentile(sample.frames, 0.95), maxTask: Math.max(0, ...sample.tasks), frames: sample.frames.length })
    }
    }
    expect(errors).toEqual([])
    await expect(page.getByTestId('tool-dock')).toBeVisible()
    await info.attach('metrics', { body: JSON.stringify({ count, allVisible, round, results, requestedAssets: new Set(fixture.requests).size, saves: fixture.saves.length }), contentType: 'application/json' })
    console.log(JSON.stringify({ count, allVisible, round, results }))
    if (process.env.PERF_ENFORCE === '1') {
      const limit = count <= 134 ? 20 : count <= 500 ? 25 : 33.3
      for (const result of results) expect(result.p95, result.phase).toBeLessThanOrEqual(limit)
    }
  })
}
