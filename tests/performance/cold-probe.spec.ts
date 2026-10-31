import { test, expect } from '@playwright/test'
import { installPerformanceCanvas } from './fixtures'
const base = '.canvas-workspace .react-flow__viewport {will-change:auto;backface-visibility:visible} .canvas-media-node__download {backdrop-filter:none!important}'
const probes = [
 ['only cheap download and no promotion', base],
 ['cheap and hidden icons', base + ' .canvas-node-handle__icon {visibility:hidden}'],
 ['cheap and no download', base + ' .canvas-media-node__download {visibility:hidden}'],
 ['cheap and no labels', base + ' .canvas-node-label {visibility:hidden}'],
]
for (const [label, css] of probes) test('cold probe ' + label, async ({page}) => {
 test.skip(process.env.PERF_PROBE !== '1')
 const fixture = await installPerformanceCanvas(page, 500, false)
 await page.goto(fixture.url)
 await expect(page.getByTestId('app-shell')).toHaveAttribute('data-hydrated','true')
 await page.addStyleTag({content:css})
 await page.waitForTimeout(3000)
 await page.evaluate(() => {
  const sample={active:true,frames:[] as number[],last:0}; (window as any).probe=sample
  const tick=(now:number)=>{if(!sample.active)return;if(sample.last)sample.frames.push(now-sample.last);sample.last=now;requestAnimationFrame(tick)}
  requestAnimationFrame(tick)
 })
 await page.mouse.move(900,450);await page.keyboard.down('Control')
 for(let i=0;i<12;i++){await page.mouse.wheel(0,90);await page.waitForTimeout(20)}
 await page.keyboard.up('Control');await page.waitForTimeout(300)
 const frames=await page.evaluate(()=>{(window as any).probe.active=false;return (window as any).probe.frames as number[]})
 frames.sort((a,b)=>a-b);console.log(JSON.stringify({label,p95:frames[Math.floor(frames.length*.95)]}))
})
