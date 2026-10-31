import { test } from '@playwright/test'
import { installPerformanceCanvas } from './fixtures'
test('diagnostic trace for zoom', async ({ page }, info) => {
  test.skip(process.env.PERF_PROFILE !== '1')
  const allVisible = process.env.PERF_PROFILE_VIEW === 'overview'
  const fixture = await installPerformanceCanvas(page, Number(process.env.PERF_PROFILE_SIZE ?? 500), allVisible)
  await page.goto(fixture.url)
  await page.waitForTimeout(4000)
  const session = await page.context().newCDPSession(page)
  const events: any[] = []
  session.on('Tracing.dataCollected', data => events.push(...data.value))
  await session.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline', options: 'record-as-much-as-possible' })
  await session.send('Debugger.enable')
  await session.send('Profiler.enable')
  await session.send('Profiler.start')
  await page.mouse.move(900, 450)
  await page.keyboard.down('Control')
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, allVisible ? -90 : 90); await page.waitForTimeout(20) }
  await page.keyboard.up('Control')
  await page.waitForTimeout(400)
  const profile = await session.send('Profiler.stop')
  const ended = new Promise<void>(resolve => session.once('Tracing.tracingComplete', () => resolve()))
  await session.send('Tracing.end')
  await ended
  const totals = new Map<string, { time: number; max: number; count: number }>()
  for (const event of events) if (event.ph === 'X' && event.dur) {
    const entry = totals.get(event.name) ?? { time: 0, max: 0, count: 0 }
    entry.time += event.dur / 1000; entry.max = Math.max(entry.max, event.dur / 1000); entry.count++
    totals.set(event.name, entry)
  }
  console.log(JSON.stringify([...totals].sort((a,b) => b[1].time-a[1].time).slice(0,30)))
  for (const scriptId of new Set(profile.profile.nodes.filter((node: any) => node.callFrame.functionName === 'visitNode').map((node: any) => node.callFrame.scriptId))) {
    const source = await session.send('Debugger.getScriptSource', { scriptId: scriptId as string })
    console.log('INJECTED_SOURCE ' + source.scriptSource.slice(0, 250) + source.scriptSource.split('\n').slice(260, 285).join('\n'))
  }
  const byId = new Map(profile.profile.nodes.map((n: any) => [n.id, n]))
  const hits = new Map<number,number>()
  profile.profile.samples?.forEach((id: number,i: number) => hits.set(id, (hits.get(id) ?? 0) + (profile.profile.timeDeltas?.[i] ?? 0)))
  console.log(JSON.stringify([...hits].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([id,ms])=>({ms:ms/1000, frame:(byId.get(id) as any)?.callFrame}))))
  await info.attach('timeline', { body: JSON.stringify({ traceEvents: events }), contentType: 'application/json' })
  await info.attach('cpu-profile', { body: JSON.stringify(profile.profile), contentType: 'application/json' })
})
