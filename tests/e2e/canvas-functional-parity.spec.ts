import { expect, test, type Page } from '@playwright/test'

import { referenceProjectSnapshot } from '../../src/fixtures/reference'

const e2eProvider = {
  id: 'aistartlab',
  name: 'AIStartLab',
  adapterType: 'aistartlab-openapi',
  baseUrl: 'https://api.video.aistarslab.com/openapi',
  enabled: true,
  preferred: true,
  secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
  secretConfigured: true,
  maskedSecret: 'sk-********1234',
  available: true,
  lastSyncedAt: new Date().toISOString(),
}

const e2eCatalog = {
  providerId: e2eProvider.id,
  version: 'e2e-catalog-v1',
  fetchedAt: e2eProvider.lastSyncedAt,
  stale: false,
  models: [
    {
      mediaType: 'image',
      channel: 46,
      channelTitle: '图片生成',
      model: 'gpt-image-2',
      title: 'GPT Image 2 Low',
      qualityOptions: [
        { value: '1K', label: '1K', pricing: { type: 'fixed_total', credits: 5 } },
      ],
      aspectRatios: ['16:9', '1:1'],
      countOptions: [1, 2],
      durationOptions: [],
      modes: ['text2image', 'image2image'],
      inputLimits: { images: 3, videos: 0, audios: 0 },
      raw: {},
    },
    {
      mediaType: 'video',
      channel: 27,
      channelTitle: '视频生成',
      model: 'grok-video-1',
      title: 'Grok 1.0',
      qualityOptions: [
        { value: '720P', label: '720P', pricing: { type: 'fixed_total', credits: 120 } },
        { value: '1080P', label: '1080P', pricing: { type: 'fixed_total', credits: 180 } },
      ],
      aspectRatios: ['16:9', '21:9'],
      countOptions: [1, 2],
      durationOptions: [6, 12],
      modes: ['text2video', 'image2video', 'first_last_frame'],
      inputLimits: { images: 3, videos: 0, audios: 0 },
      raw: { supportsAudio: true },
    },
  ],
}

async function mockCatalogGateway(page: Page) {
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: [e2eProvider] }),
    })
  })
  await page.route('**/api/catalog?providerId=*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog: e2eCatalog }),
    })
  })
  await page.route('**/api/providers/*/sync', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalog: e2eCatalog }),
    })
  })
}

test.beforeEach(async ({ page }) => {
  await mockCatalogGateway(page)
  await page.goto('/canvas?spaceId=local&projectId=reference')
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
})

test('pans with the middle mouse button without switching tools', async ({
  page,
}) => {
  const pane = page.locator('.react-flow__pane')
  const viewport = page.locator('.react-flow__viewport')
  const bounds = await pane.boundingBox()
  const before = await viewport.evaluate((element) =>
    getComputedStyle(element).transform,
  )

  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + 720, bounds!.y + 360)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(bounds!.x + 805, bounds!.y + 415, { steps: 6 })
  await page.mouse.up({ button: 'middle' })

  await expect
    .poll(() =>
      viewport.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(before)
  await expect(page.getByTestId('canvas-workspace')).toHaveAttribute(
    'data-canvas-mode',
    'select',
  )
})

test('keeps media mounted through sustained pan and zoom gestures', async ({
  page,
}) => {
  const pane = page.locator('.react-flow__pane')
  const viewport = page.locator('.react-flow__viewport')
  const workspace = page.getByTestId('canvas-workspace')
  const media = page.locator('.canvas-media-node__content').first()
  const bounds = await pane.boundingBox()
  const srcBefore = await media.getAttribute('src')

  expect(bounds).not.toBeNull()
  expect(srcBefore).toBeTruthy()
  await media.evaluate((element) => {
    element.setAttribute('data-viewport-identity', 'stable-media')
  })

  await page.mouse.move(bounds!.x + 640, bounds!.y + 360)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(bounds!.x + 790, bounds!.y + 450, { steps: 80 })
  await expect(workspace).toHaveAttribute('data-viewport-moving', 'true')
  await page.mouse.up({ button: 'middle' })
  await expect(workspace).not.toHaveAttribute('data-viewport-moving')

  for (let index = 0; index < 30; index += 1) {
    await page.mouse.wheel(0, index % 2 === 0 ? -24 : 18)
  }

  await expect(media).toHaveAttribute('data-viewport-identity', 'stable-media')
  await expect(media).toHaveAttribute('src', srcBefore!)
  await expect
    .poll(() =>
      viewport.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe('none')
})

test('matches reference status toggles, zoom menu, and reversible layout', async ({
  page,
}) => {
  const edges = page.locator('.react-flow__edge')
  const edgeCount = await edges.count()
  await expect(page.getByRole('button', { name: '切换小地图' })).toBeVisible()
  await expect(page.getByRole('button', { name: '隐藏节点连线' })).toBeVisible()
  await expect(page.getByRole('button', { name: '智能吸附' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.canvas-minimap')).toHaveCount(0)

  await page.getByRole('button', { name: '切换小地图' }).click()
  await expect(page.locator('.canvas-minimap')).toBeVisible()
  await page.getByRole('button', { name: '隐藏节点连线' }).click()
  await expect(edges).toHaveCount(0)
  await page.getByRole('button', { name: '显示节点连线' }).click()
  await expect(edges).toHaveCount(edgeCount)

  await page.getByRole('button', { name: '缩放选项' }).click()
  const zoomMenu = page.getByRole('menu', { name: '缩放选项' })
  await expect(zoomMenu).toBeVisible()
  await expect(zoomMenu.getByRole('menuitem', { name: /网格吸附/ })).toHaveAttribute('aria-pressed', 'false')
  await zoomMenu.getByRole('menuitem', { name: '50%' }).click()
  await expect(page.getByRole('button', { name: '缩放选项' })).toContainText(
    '50%',
  )

  const node = page.locator('.react-flow__node').first()
  const before = await node.evaluate((element) => element.getAttribute('style'))
  await page.getByRole('button', { name: '整理画布，Alt+Shift+F' }).click()
  const decision = page.getByRole('status', { name: '自动布局确认' })
  await expect(decision).toBeVisible()
  await decision.getByRole('button', { name: '还原' }).click()
  await expect(decision).toBeHidden()
  await expect
    .poll(() => node.evaluate((element) => element.getAttribute('style')))
    .toBe(before)
})

test('closes a pointer add menu with Escape', async ({ page }) => {
  const pane = page.locator('.react-flow__pane')
  await pane.dblclick({ position: { x: 440, y: 300 } })
  await expect(page.getByRole('menu', { name: '添加节点' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: '添加节点' })).toBeHidden()
})

test('creates every dedicated canvas node from the original add menu', async ({
  page,
}) => {
  const cases = [
    ['视频合成', '.react-flow__node-video-clip.selected', 'text', '空空如也，请连接视频节点后操作'],
    ['导演台', '.react-flow__node-director.selected', 'text', '打开导演台'],
    ['音频', '.react-flow__node-audio.selected', 'placeholder', '描述需要生成的音乐或声音'],
    ['脚本', '.react-flow__node-script.selected', 'placeholder', '新建脚本内容'],
  ] as const

  for (const [label, selector, assertion, expectedText] of cases) {
    await page.getByRole('button', { name: '上传媒体 U' }).click()
    await page
      .getByRole('menu', { name: '添加节点' })
      .getByRole('menuitem', { name: label, exact: true })
      .click()
    const node = page.locator(selector)
    if (assertion === 'placeholder') {
      await expect(node.getByPlaceholder(expectedText)).toBeVisible()
    } else {
      await expect(node).toContainText(expectedText)
    }
  }
})

test('duplicates, groups, ungroups, and deletes selected nodes with shortcuts', async ({
  page,
}) => {
  const nodes = page.locator('.react-flow__node')
  const initialCount = await nodes.count()
  const visibleIds = await nodes.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return (
          rect.left >= 0 &&
          rect.top >= 80 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight - 100
        )
      })
      .map((element) => element.getAttribute('data-id'))
      .filter((id): id is string => Boolean(id))
      .slice(0, 1),
  )
  expect(visibleIds).toHaveLength(1)
  const first = page.locator(`.react-flow__node[data-id="${visibleIds[0]}"]`)

  await first.click()
  await page.keyboard.press('Control+d')
  await expect(nodes).toHaveCount(initialCount + 1)
  await page.keyboard.press('Delete')
  await expect(nodes).toHaveCount(initialCount)

  await page.keyboard.press('Control+a')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(initialCount)

  await page.keyboard.press('Control+g')
  const group = page.locator('.react-flow__node-group.selected')
  await expect(group).toHaveCount(1)
  await page.keyboard.press('Control+Shift+g')
  await expect(group).toHaveCount(0)
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(initialCount)
})

test('matches original blank and node context menu commands', async ({ page }) => {
  const pane = page.locator('.react-flow__pane')
  await pane.click({ button: 'right', position: { x: 360, y: 280 } })
  const blankMenu = page.getByRole('menu', { name: '画布快捷菜单' })
  await expect(blankMenu.getByRole('menuitem', { name: '上传' })).toBeVisible()
  await expect(
    blankMenu.getByRole('menuitem', { name: '保存到我的资产' }),
  ).toBeDisabled()
  await blankMenu.getByRole('menuitem', { name: '添加节点' }).click()
  await expect(page.getByRole('menu', { name: '添加节点' })).toBeVisible()
  await page.keyboard.press('Escape')

  const nodeId = await page.locator('.react-flow__node').evaluateAll((nodes) =>
    nodes.find((node) => {
      const rect = node.getBoundingClientRect()
      return (
        rect.left >= 0 &&
        rect.top >= 80 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight - 100
      )
    })?.getAttribute('data-id'),
  )
  expect(nodeId).toBeTruthy()
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await node.click({ button: 'right' })
  const nodeMenu = page.getByRole('menu', { name: '节点快捷菜单' })
  await expect(nodeMenu.getByRole('menuitem', { name: '内容合规检测' })).toBeDisabled()
  await expect(nodeMenu.getByRole('menuitem', { name: '复制节点' })).toBeVisible()
  await expect(nodeMenu.getByRole('menuitem', { name: '生成副本' })).toBeVisible()
  await expect(nodeMenu.getByRole('menuitem', { name: '复制到剪贴板' })).toBeVisible()
})

test('keeps dynamic video model, mode, ratio, clarity, duration, audio, and count in the local editor', async ({
  page,
}) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page
    .getByRole('menu', { name: '添加节点' })
    .getByRole('menuitem', { name: '视频', exact: true })
    .click()
  const video = page.locator('.react-flow__node-video.selected')
  const editor = video.locator('[data-node-editor="video"]')
  await expect(editor.locator('.canvas-node-generator')).toBeVisible()

  await editor.getByRole('button', { name: '选择视频模型' }).click()
  await page
    .getByRole('menu', { name: '视频模型' })
    .getByRole('menuitem', { name: /Grok 1.0/ })
    .click()
  await expect(editor.getByRole('button', { name: '选择视频模型' })).toContainText(
    'Grok 1.0',
  )

  await editor.getByRole('button', { name: '视频生成模式：全能参考' }).click()
  await page
    .getByRole('menu', { name: '视频生成模式' })
    .getByRole('menuitem', { name: '首尾帧' })
    .click()
  await expect(editor.getByRole('button', { name: '视频生成模式：首尾帧' })).toBeVisible()

  await editor
    .getByRole('button', {
      name: '生成详情：16:9 · 720P · 6s · 1个，音频开启',
    })
    .click()
  const settings = page.getByRole('dialog', { name: '视频生成设置' })
  await settings.getByRole('button', { name: '21:9' }).click()
  await settings.getByRole('button', { name: '1080P' }).click()
  await settings.getByRole('button', { name: '12秒' }).click()
  await settings.getByRole('button', { name: '关闭' }).click()
  await settings.getByRole('button', { name: '2个' }).click()
  await expect(
    editor.getByRole('button', {
      name: '生成详情：21:9 · 1080P · 12s · 2个，音频关闭',
    }),
  ).toBeVisible()
})

test('opens a fixed-screen-size inline editor for a selected media node', async ({
  page,
}) => {
  const node = page.locator('.react-flow__node[data-id="i-TFj65r3PHQ"]')

  await expect(node).toBeVisible()
  await node.click()

  const editor = node.locator('[data-node-editor="image"]')
  const panel = editor.locator('.canvas-node-generator')
  await expect(panel).toBeVisible()
  await expect(node.locator('.canvas-media-actions')).toHaveCount(0)
  await expect(
    editor.getByRole('button', { name: '参考拾取模式' }),
  ).toBeVisible()
  await expect(editor.getByRole('button', { name: '标记' })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '风格' })).toHaveCount(0)
  await expect(editor.getByRole('combobox', { name: '图片生成描述' })).toBeVisible()

  const panelBounds = await panel.boundingBox()
  expect(panelBounds).not.toBeNull()
  expect(panelBounds!.width).toBeGreaterThan(650)
  expect(panelBounds!.width).toBeLessThan(670)
})

test('keeps idle edges static and animates only edges incident to the selected node', async ({
  page,
}) => {
  const flowEdges = page.locator('.canvas-edge')
  await expect.poll(() => page.locator('.canvas-edge__flow-group').evaluateAll(
    (groups) => groups.every((group) => Number(getComputedStyle(group).opacity) === 0),
  )).toBe(true)

  const hoverTarget = await page
    .locator('.canvas-edge__interaction')
    .evaluateAll((paths) => {
      for (const path of paths) {
        const svgPath = path as SVGPathElement
        const matrix = svgPath.getScreenCTM()
        if (!matrix) continue
        const midpoint = svgPath.getPointAtLength(svgPath.getTotalLength() / 2)
        const screenPoint = new DOMPoint(midpoint.x, midpoint.y).matrixTransform(
          matrix,
        )
        if (
          screenPoint.x > 80 &&
          screenPoint.x < window.innerWidth - 80 &&
          screenPoint.y > 100 &&
          screenPoint.y < window.innerHeight - 100
        ) {
          const hitTarget = document.elementFromPoint(screenPoint.x, screenPoint.y)
          const edgeElement = path.closest('.react-flow__edge')
          if (hitTarget?.closest('.react-flow__edge') !== edgeElement) continue

          return {
            edgeTestId: edgeElement?.getAttribute('data-testid'),
            x: screenPoint.x,
            y: screenPoint.y,
          }
        }
      }
      return null
    })

  expect(hoverTarget?.edgeTestId).toBeTruthy()
  await page.mouse.move(20, 120)
  await page.mouse.move(hoverTarget!.x, hoverTarget!.y, { steps: 12 })
  const hoveredElementClass = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('class'),
    hoverTarget!,
  )
  expect(hoveredElementClass).toContain('canvas-edge__interaction')
  const hoveredEdge = page.locator(
    `[data-testid="${hoverTarget!.edgeTestId}"]`,
  )
  await expect(hoveredEdge.locator('.canvas-edge__flow')).toHaveCount(3)
  await expect.poll(() => hoveredEdge.locator('.canvas-edge__flow-group').evaluate(
    (group) => Number(getComputedStyle(group).opacity),
  )).toBe(1)
  await page.mouse.move(20, 120)
  await expect.poll(() => hoveredEdge.locator('.canvas-edge__flow-group').evaluate(
    (group) => Number(getComputedStyle(group).opacity),
  ), { timeout: 3_000 }).toBe(0)

  const connectedIds = new Set(
    referenceProjectSnapshot.edges.flatMap((edge) => [edge.source, edge.target]),
  )
  const visibleNodeIds = await page.locator('.react-flow__node').evaluateAll(
    (nodes) =>
      nodes
        .filter((node) => {
          const rect = node.getBoundingClientRect()
          return (
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight
          )
        })
        .map((node) => node.getAttribute('data-id'))
        .filter((id): id is string => Boolean(id)),
  )
  const nodeId = visibleNodeIds.find((id) => connectedIds.has(id))

  expect(nodeId).toBeTruthy()
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click()

  const incidentCount = referenceProjectSnapshot.edges.filter(
    (edge) => edge.source === nodeId || edge.target === nodeId,
  ).length
  const activeEdges = page.locator('.canvas-edge[data-flow-active="true"]')
  await expect(activeEdges).toHaveCount(incidentCount)
  await expect.poll(() => activeEdges.locator('.canvas-edge__flow-group').evaluateAll(
    (groups) => groups.every((group) => Number(getComputedStyle(group).opacity) === 1),
  )).toBe(true)
  expect(await flowEdges.count()).toBeGreaterThan(incidentCount)

  const animatedFlow = page.locator('.canvas-edge__flow--animated').first()
  await expect(animatedFlow).toBeVisible()
  await expect.poll(() => animatedFlow.evaluate((element) =>
    getComputedStyle(element).animationName,
  )).toBe('canvas-edge-flow')
  const before = await animatedFlow.evaluate((element) =>
    getComputedStyle(element).strokeDashoffset,
  )
  await expect
    .poll(() => animatedFlow.evaluate((element) =>
      getComputedStyle(element).strokeDashoffset,
    ))
    .not.toEqual(before)
})

test('matches the reference connector hit area and side-center anchors', async ({
  page,
}) => {
  const node = page.locator('.react-flow__node-image').filter({ visible: true })
  const nodeCount = await node.count()
  expect(nodeCount).toBeGreaterThan(0)
  const targetNode = node.nth(0)
  const geometry = await targetNode.evaluate((element) => {
    const nodeRect = element.getBoundingClientRect()
    const viewport = element.closest('.react-flow__viewport')
    const transform = viewport ? getComputedStyle(viewport).transform : 'none'
    const matrix = new DOMMatrixReadOnly(transform)
    const zoom = matrix.a
    const read = (side: 'left' | 'right') => {
      const hit = element.querySelector(
        `.canvas-node-handle--${side} .canvas-node-handle__hit`,
      )
      const icon = element.querySelector(
        `.canvas-node-handle--${side} .canvas-node-handle__icon`,
      )
      if (!hit || !icon) return null
      const hitRect = hit.getBoundingClientRect()
      const iconRect = icon.getBoundingClientRect()
      return {
        anchorX: side === 'left' ? nodeRect.left : nodeRect.right,
        hitCenterX: hitRect.left + hitRect.width / 2,
        hitCenterY: hitRect.top + hitRect.height / 2,
        hitSize: hitRect.width / zoom,
        iconSize: iconRect.width / zoom,
      }
    }
    return {
      nodeCenterY: nodeRect.top + nodeRect.height / 2,
      left: read('left'),
      right: read('right'),
    }
  })

  expect(geometry.left).not.toBeNull()
  expect(geometry.right).not.toBeNull()
  expect(geometry.left!.hitSize).toBeCloseTo(112, 0)
  expect(geometry.right!.hitSize).toBeCloseTo(80, 0)
  expect(geometry.left!.iconSize).toBeCloseTo(20, 0)
  expect(geometry.right!.iconSize).toBeCloseTo(20, 0)
  expect(geometry.left!.hitCenterY).toBeCloseTo(geometry.nodeCenterY, 0)
  expect(geometry.right!.hitCenterY).toBeCloseTo(geometry.nodeCenterY, 0)
  expect(geometry.left!.hitCenterX).toBeLessThan(geometry.left!.anchorX)
  expect(geometry.right!.hitCenterX).toBeGreaterThan(geometry.right!.anchorX)
})

test('creates a connection by dragging directly between node handles', async ({
  page,
}) => {
  await expect(page.getByTestId('canvas-workspace')).toHaveAttribute(
    'data-canvas-mode',
    'select',
  )
  const candidates = await page.locator('.react-flow__node').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          id: node.getAttribute('data-id'),
          kind: node.querySelector('[data-node-kind]')?.getAttribute('data-node-kind'),
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
        }
      })
      .filter(
        (node) =>
          node.id &&
          (node.kind === 'image' || node.kind === 'video') &&
          node.right > 80 &&
          node.x < window.innerWidth - 80 &&
          node.bottom > 100 &&
          node.y < window.innerHeight - 120,
      ),
  )

  expect(candidates.length).toBeGreaterThanOrEqual(2)
  const source = page.locator(`[data-id="${candidates[0]!.id}"]`)
  const target = page.locator(`[data-id="${candidates[1]!.id}"]`)
  const sourceHit = source.locator('.source .canvas-node-handle__hit')
  const targetHit = target.locator('.target .canvas-node-handle__hit')
  const sourceBounds = await sourceHit.boundingBox()
  const targetBounds = await targetHit.boundingBox()
  const edgeCount = await page.locator('.react-flow__edge').count()

  expect(sourceBounds).not.toBeNull()
  expect(targetBounds).not.toBeNull()
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + sourceBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBounds!.x + targetBounds!.width / 2,
    targetBounds!.y + targetBounds!.height / 2,
    { steps: 10 },
  )
  await page.mouse.up()

  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount + 1)
})

test('drags a media node from the visible image surface', async ({ page }) => {
  const nodeId = await page.locator('.react-flow__node-image').evaluateAll(
    (nodes) =>
      nodes
        .map((node) => ({
          id: node.getAttribute('data-id'),
          rect: node.getBoundingClientRect(),
          hasImage: Boolean(node.querySelector('img.canvas-media-node__content')),
        }))
        .find(
          ({ rect, hasImage }) =>
            hasImage &&
            rect.left > 120 &&
            rect.right < window.innerWidth - 160 &&
            rect.top > 120 &&
            rect.bottom < window.innerHeight - 180,
        )?.id,
  )

  expect(nodeId).toBeTruthy()
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  const image = node.locator('img.canvas-media-node__content')
  const imageBounds = await image.boundingBox()
  const before = await node.evaluate((element) =>
    getComputedStyle(element).transform,
  )

  expect(imageBounds).not.toBeNull()
  await page.mouse.move(
    imageBounds!.x + imageBounds!.width / 2,
    imageBounds!.y + imageBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    imageBounds!.x + imageBounds!.width / 2 + 96,
    imageBounds!.y + imageBounds!.height / 2 + 64,
    { steps: 8 },
  )
  await page.mouse.up()

  await expect
    .poll(() => node.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(before)
})

test('drags a newly created video from its empty placeholder surface', async ({
  page,
}) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  await page
    .getByRole('menu', { name: '添加节点' })
    .getByRole('menuitem', { name: '视频', exact: true })
    .click()

  const node = page.locator('.react-flow__node-video.selected')
  const placeholder = node.getByRole('img', { name: '暂无视频' })
  const bounds = await placeholder.boundingBox()
  const before = await node.evaluate((element) =>
    getComputedStyle(element).transform,
  )

  expect(bounds).not.toBeNull()
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    bounds!.x + bounds!.width / 2 + 90,
    bounds!.y + bounds!.height / 2 + 55,
    { steps: 10 },
  )
  await page.mouse.up()

  await expect
    .poll(() => node.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(before)
})

test('pastes image and video files from the system clipboard onto the canvas', async ({
  page,
}) => {
  const uploadedBodies: number[][] = []
  const assetIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]
  await page.route('**/api/assets', async (route) => {
    const request = route.request()
    const body = request.postDataBuffer()
    const index = uploadedBodies.length
    uploadedBodies.push(body ? [...body] : [])
    const id = assetIds[index]!
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        asset: {
          id,
          filename: request.headers()['x-filename'],
          contentType: request.headers()['content-type'],
          size: body?.byteLength ?? 0,
          url: `/api/assets/${id}`,
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      }),
    })
  })
  const nodes = page.locator('.react-flow__node')
  const initialCount = await nodes.count()
  const pasteFile = async (name: string, type: string) => {
    await page.evaluate(
      ({ fileName, fileType }) => {
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([new Uint8Array([0, 1, 2, 3])], fileName, {
            type: fileType,
          }),
        )
        document.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        )
      },
      { fileName: name, fileType: type },
    )
  }

  await pasteFile('clipboard-image.png', 'image/png')
  await expect(nodes).toHaveCount(initialCount + 1)
  await expect(
    page.locator('.react-flow__node-image.selected'),
  ).toHaveAttribute('aria-label', 'clipboard-image.png')

  await pasteFile('clipboard-video.mp4', 'video/mp4')
  await expect(nodes).toHaveCount(initialCount + 2)
  await expect(
    page.locator('.react-flow__node-video.selected'),
  ).toHaveAttribute('aria-label', 'clipboard-video.mp4')
  expect(uploadedBodies).toEqual([
    [0, 1, 2, 3],
    [0, 1, 2, 3],
  ])
})

test('accepts a target connection before the pointer reaches the visible handle', async ({
  page,
}) => {
  const candidates = await page.locator('.react-flow__node').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          id: node.getAttribute('data-id'),
          kind: node.querySelector('[data-node-kind]')?.getAttribute('data-node-kind'),
          rect,
        }
      })
      .filter(
        ({ id, kind, rect }) =>
          id &&
          (kind === 'image' || kind === 'video') &&
          rect.left > 100 &&
          rect.right < window.innerWidth - 100 &&
          rect.top > 100 &&
          rect.bottom < window.innerHeight - 140,
      )
      .slice(0, 2),
  )

  expect(candidates).toHaveLength(2)
  const source = page.locator(`[data-id="${candidates[0]!.id}"]`)
  const target = page.locator(`[data-id="${candidates[1]!.id}"]`)
  const sourceBounds = await source
    .locator('.source .canvas-node-handle__hit')
    .boundingBox()
  const targetBounds = await target
    .locator('.target .canvas-node-handle__hit')
    .boundingBox()
  const edgeCount = await page.locator('.react-flow__edge').count()
  const intendedEdge = page.getByLabel(
    `Edge from ${candidates[0]!.id} to ${candidates[1]!.id}`,
  )
  const intendedEdgeCount = await intendedEdge.count()

  expect(sourceBounds).not.toBeNull()
  expect(targetBounds).not.toBeNull()
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + sourceBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBounds!.x - 32,
    targetBounds!.y + targetBounds!.height / 2,
    { steps: 12 },
  )
  await page.mouse.up()

  await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount + 1)
  await expect(intendedEdge).toHaveCount(intendedEdgeCount + 1)
})

test('keeps the drag hot path continuous without reloading media', async ({
  page,
}) => {
  const initializationWarnings: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('drag a node that is not initialized')) {
      initializationWarnings.push(text)
    }
  })

  const nodeId = await page.locator('.react-flow__node-image').evaluateAll(
    (nodes) =>
      nodes
        .map((node) => ({
          id: node.getAttribute('data-id'),
          rect: node.getBoundingClientRect(),
          hasImage: Boolean(node.querySelector('img.canvas-media-node__content')),
        }))
        .find(
          ({ rect, hasImage }) =>
            hasImage &&
            rect.left > 120 &&
            rect.right < window.innerWidth - 160 &&
            rect.top > 120 &&
            rect.bottom < window.innerHeight - 180,
        )?.id,
  )

  expect(nodeId).toBeTruthy()
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  const image = node.locator('img.canvas-media-node__content')
  const imageBounds = await image.boundingBox()
  expect(imageBounds).not.toBeNull()

  await page.evaluate((id) => {
    const state = window as typeof window & {
      __dragHitTests?: number
      __dragImage?: HTMLImageElement | null
      __dragImageSource?: string
    }
    const originalElementFromPoint = document.elementFromPoint.bind(document)
    state.__dragHitTests = 0
    state.__dragImage = document.querySelector(
      `.react-flow__node[data-id="${id}"] img.canvas-media-node__content`,
    )
    state.__dragImageSource = state.__dragImage?.currentSrc || state.__dragImage?.src
    document.elementFromPoint = (...args) => {
      state.__dragHitTests = (state.__dragHitTests ?? 0) + 1
      return originalElementFromPoint(...args)
    }
  }, nodeId)

  const start = {
    x: imageBounds!.x + imageBounds!.width / 2,
    y: imageBounds!.y + imageBounds!.height / 2,
  }
  const positions: number[] = []
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let step = 1; step <= 30; step += 1) {
    await page.mouse.move(start.x + step, start.y + step * 0.25)
    const bounds = await node.boundingBox()
    expect(bounds).not.toBeNull()
    positions.push(bounds!.x)
  }
  const mediaStyleDuringDrag = await image.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backfaceVisibility: style.backfaceVisibility,
      transform: style.transform,
    }
  })
  await page.mouse.up()

  const probe = await page.evaluate((id) => {
    const state = window as typeof window & {
      __dragHitTests?: number
      __dragImage?: HTMLImageElement | null
      __dragImageSource?: string
    }
    const imageElement = document.querySelector<HTMLImageElement>(
      `.react-flow__node[data-id="${id}"] img.canvas-media-node__content`,
    )
    return {
      hitTests: state.__dragHitTests ?? 0,
      sameImage: imageElement === state.__dragImage,
      sourceStable:
        (imageElement?.currentSrc || imageElement?.src) === state.__dragImageSource,
      stillConnected: state.__dragImage?.isConnected ?? false,
    }
  }, nodeId)
  const settledPositions = positions.slice(2)
  const repeatedPositions = settledPositions.filter(
    (position, index) =>
      index > 0 && position === settledPositions[index - 1],
  ).length

  expect(probe).toMatchObject({
    sameImage: true,
    sourceStable: true,
    stillConnected: true,
  })
  expect(probe.hitTests).toBeLessThan(5)
  expect(new Set(settledPositions).size).toBeGreaterThan(10)
  expect(repeatedPositions).toBeLessThan(20)
  expect(mediaStyleDuringDrag).toEqual({
    backfaceVisibility: 'visible',
    transform: 'none',
  })
  expect(initializationWarnings).toEqual([])
})

test('creates a connected downstream node when a handle is released on blank canvas', async ({
  page,
}) => {
  const sourceId = await page.locator('.react-flow__node-image').evaluateAll(
    (nodes) =>
      nodes
        .map((node) => ({
          id: node.getAttribute('data-id'),
          rect: node.getBoundingClientRect(),
        }))
        .find(
          ({ rect }) =>
            rect.left > 120 &&
            rect.right < window.innerWidth - 180 &&
            rect.top > 120 &&
            rect.bottom < window.innerHeight - 180,
        )?.id,
  )

  expect(sourceId).toBeTruthy()
  const sourceNode = page.locator(
    `.react-flow__node[data-id="${sourceId}"]`,
  )
  const sourceHit = sourceNode.locator('.source .canvas-node-handle__hit')
  const sourceBounds = await sourceHit.boundingBox()
  const nodesBefore = await page.locator('.react-flow__node').count()
  const edgesBefore = await page.locator('.react-flow__edge').count()
  expect(sourceBounds).not.toBeNull()
  const blankPoint = await page.locator('.react-flow__pane').evaluate(
    (pane, sourceCenter) => {
      const paneRect = pane.getBoundingClientRect()
      const occupied = Array.from(
        document.querySelectorAll('.react-flow__node'),
      ).map((node) => node.getBoundingClientRect())
      const candidates = [] as Array<{ x: number; y: number }>
      for (let y = paneRect.top + 150; y < paneRect.bottom - 180; y += 70) {
        for (let x = paneRect.left + 220; x < paneRect.right - 220; x += 90) {
          candidates.push({ x, y })
        }
      }
      return candidates.find(
        (point) =>
          Math.hypot(point.x - sourceCenter.x, point.y - sourceCenter.y) > 180 &&
          occupied.every(
            (rect) =>
              point.x < rect.left - 80 ||
              point.x > rect.right + 80 ||
              point.y < rect.top - 80 ||
              point.y > rect.bottom + 80,
          ),
      )
    },
    {
      x: sourceBounds!.x + sourceBounds!.width / 2,
      y: sourceBounds!.y + sourceBounds!.height / 2,
    },
  )

  expect(blankPoint).toBeTruthy()
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + sourceBounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(blankPoint!.x, blankPoint!.y, { steps: 12 })
  await page.mouse.up()

  const menu = page.getByRole('menu', { name: '引用该节点生成' })
  await expect(menu).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(nodesBefore + 1)
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgesBefore + 1)

  await menu.getByRole('menuitem', { name: '视频', exact: true }).click()
  const selectedVideo = page.locator('.react-flow__node-video.selected')
  await expect(selectedVideo).toHaveCount(1)
  await expect(
    selectedVideo.locator('[data-node-editor="video"] .canvas-node-generator'),
  ).toBeVisible()
  await expect(selectedVideo.getByLabel('参考素材 1/3')).toBeVisible()
})

test('replaces an existing image in place without creating a self-linked result', async ({
  page,
}) => {
  const referenceAssetId = '11111111-1111-4111-8111-111111111111'
  const outputAssetId = '22222222-2222-4222-8222-222222222222'
  const jobId = '33333333-3333-4333-8333-333333333333'
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  let generationPosts = 0
  let importPosts = 0
  let jobReads = 0
  let submittedRequest: Record<string, unknown> | undefined

  await page.route('**/api/assets/import', async (route) => {
    importPosts += 1
    await route.fulfill({
      contentType: 'application/json',
      status: 201,
      body: JSON.stringify({
        asset: {
          id: referenceAssetId,
          filename: 'reference.png',
          contentType: 'image/png',
          size: png.byteLength,
          url: `/api/assets/${referenceAssetId}`,
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      }),
    })
  })
  await page.route('**/api/generation-jobs', async (route) => {
    generationPosts += 1
    submittedRequest = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      contentType: 'application/json',
      status: 202,
      body: JSON.stringify({
        job: {
          id: jobId,
          clientRequestId: submittedRequest.clientRequestId,
          requestDigest: 'test-digest',
          request: submittedRequest,
          status: 'queued',
          progress: 0,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
          outputs: [],
        },
      }),
    })
  })
  await page.route(`**/api/generation-jobs/${jobId}`, async (route) => {
    jobReads += 1
    const complete = jobReads >= 2
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        job: {
          id: jobId,
          clientRequestId: submittedRequest?.clientRequestId,
          requestDigest: 'test-digest',
          request: submittedRequest,
          status: complete ? 'complete' : 'running',
          progress: complete ? 100 : 35,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:01.000Z',
          outputs: complete
            ? [
                {
                  assetId: outputAssetId,
                  url: `/api/assets/${outputAssetId}`,
                  contentType: 'image/png',
                  size: png.byteLength,
                },
              ]
            : [],
        },
      }),
    })
  })
  await page.route('**/api/assets/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    await route.fulfill({ contentType: 'image/png', body: png })
  })

  const sourceId = await page
    .locator('.react-flow__node-image:has(img.canvas-media-node__content)')
    .evaluateAll((nodes) =>
      nodes.find((node) => {
        const rect = node.getBoundingClientRect()
        return (
          rect.left > 120 &&
          rect.right < window.innerWidth - 300 &&
          rect.top > 120 &&
          rect.bottom < window.innerHeight - 300
        )
      })?.getAttribute('data-id'),
    )

  expect(sourceId).toBeTruthy()
  const canvasId = new URL(page.url()).searchParams.get('canvasId')
  expect(canvasId).toBeTruthy()
  await page.evaluate(
    async ({ canvasId, sourceId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('libtv-canvas')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = database.transaction('canvas-documents', 'readwrite')
      const store = transaction.objectStore('canvas-documents')
      const record = await new Promise<{ canvasId: string; serialized: string }>(
        (resolve, reject) => {
          const request = store.get(canvasId)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        },
      )
      const project = JSON.parse(record.serialized) as {
        nodes: Array<{ id: string; data: Record<string, unknown> }>
      }
      const source = project.nodes.find((node) => node.id === sourceId)
      if (!source) throw new Error('Source node missing from persisted project')
      source.data.generationSettings = {
        kind: 'image',
        providerId: 'aistartlab',
        catalogVersion: 'e2e-catalog-v1',
        channel: 46,
        model: 'gpt-image-2',
        mode: 'image2image',
        quality: '1K',
        resolution: '1K',
        aspectRatio: '16:9',
        count: 1,
      }
      record.serialized = JSON.stringify(project)
      store.put(record)
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      database.close()
    },
    { canvasId: canvasId!, sourceId: sourceId! },
  )
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  await expect
    .poll(() =>
      page.evaluate(
        async ({ canvasId, sourceId }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('libtv-canvas')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          const transaction = database.transaction('canvas-documents', 'readonly')
          const record = await new Promise<{ serialized: string }>((resolve, reject) => {
            const request = transaction.objectStore('canvas-documents').get(canvasId)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          database.close()
          const project = JSON.parse(record.serialized) as {
            nodes: Array<{ id: string; data: { generationSettings?: { model?: string } } }>
          }
          return project.nodes.find((node) => node.id === sourceId)?.data
            .generationSettings?.model
        },
        { canvasId: canvasId!, sourceId: sourceId! },
      ),
    )
    .toBe('gpt-image-2')
  const sourceNode = page.locator(
    `.react-flow__node[data-id="${sourceId}"]`,
  )
  await sourceNode.click()
  const editor = sourceNode.locator('[data-node-editor="image"]')
  await editor
    .getByRole('combobox', { name: '图片生成描述' })
    .fill('夜雨中的霓虹街道，镜头缓慢推进')

  await expect(page.locator('.react-flow__edge').first()).toBeVisible()
  const nodesBefore = await page.locator('.react-flow__node').count()
  const edgesBefore = await page.locator('.react-flow__edge').count()
  await editor.getByRole('button', { name: '开始生成' }).click()
  await expect(page.getByRole('dialog', { name: '确认生成任务' })).toHaveCount(0)

  await expect(page.locator('.react-flow__node')).toHaveCount(nodesBefore)
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgesBefore)
  const generated = sourceNode.locator('[data-generation-status]')
  await expect(generated).toHaveAttribute('data-generation-status', 'generating')
  const generatedNodeId = await generated.evaluate((element) =>
    element.closest('.react-flow__node')?.getAttribute('data-id'),
  )

  expect(generatedNodeId).toBe(sourceId)
  await page.waitForTimeout(250)
  const generationAfterSubmit = await page.evaluate(
    async ({ canvasId, generatedNodeId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('libtv-canvas')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = database.transaction('canvas-documents', 'readonly')
      const record = await new Promise<{ serialized: string }>((resolve, reject) => {
        const request = transaction.objectStore('canvas-documents').get(canvasId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      database.close()
      const project = JSON.parse(record.serialized) as {
        nodes: Array<{ id: string; data: { generation?: unknown } }>
      }
      return project.nodes.find((node) => node.id === generatedNodeId)?.data
        .generation
    },
    {
      canvasId: canvasId!,
      generatedNodeId: generatedNodeId!,
    },
  )
  expect(generationAfterSubmit).toMatchObject({
    jobId,
    phase: 'running',
    status: 'generating',
  })
  expect(importPosts).toBe(0)
  await expect.poll(() => generationPosts).toBe(1)
  expect(submittedRequest).toMatchObject({ references: [] })
  await expect
    .poll(() =>
      page.evaluate(
        async ({ canvasId, generatedNodeId }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('libtv-canvas')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          const transaction = database.transaction('canvas-documents', 'readonly')
          const record = await new Promise<{ serialized: string }>(
            (resolve, reject) => {
              const request = transaction.objectStore('canvas-documents').get(canvasId)
              request.onsuccess = () => resolve(request.result)
              request.onerror = () => reject(request.error)
            },
          )
          database.close()
          const project = JSON.parse(record.serialized) as {
            nodes: Array<{
              id: string
              data: { generation?: { jobId?: string } }
            }>
          }
          return project.nodes.find((node) => node.id === generatedNodeId)?.data
            .generation?.jobId
        },
        {
          canvasId: canvasId!,
          generatedNodeId: generatedNodeId!,
        },
      ),
    )
    .toBe(jobId)
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  const restored = page.locator(
    `.react-flow__node[data-id="${generatedNodeId}"] [data-generation-status]`,
  )
  await expect(restored).toHaveAttribute('data-generation-status', 'complete', {
    timeout: 5_000,
  })
  await expect(restored.locator('img')).toHaveAttribute(
    'src',
    `/api/assets/${outputAssetId}`,
  )
  expect(generationPosts).toBe(1)
})

test('creates a connected video from the text-node quick action', async ({
  page,
}) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  const addMenu = page.getByRole('menu', { name: '添加节点' })
  await addMenu.getByRole('menuitem', { name: '文本' }).click()

  const textNode = page.locator('.react-flow__node-text.selected')
  await expect(textNode).toHaveCount(1)
  const nodesBefore = await page.locator('.react-flow__node').count()
  const edgesBefore = await page.locator('.react-flow__edge').count()
  await textNode.getByRole('button', { name: '文生视频' }).click()

  await expect(page.locator('.react-flow__node')).toHaveCount(nodesBefore + 1)
  await expect(page.locator('.react-flow__edge')).toHaveCount(edgesBefore + 1)
  await expect(page.locator('.react-flow__node-video.selected')).toHaveCount(1)
})

test('persists text entered through the inline text-node editor', async ({
  page,
}) => {
  await page.getByRole('button', { name: '上传媒体 U' }).click()
  const addMenu = page.getByRole('menu', { name: '添加节点' })
  await addMenu.getByRole('menuitem', { name: '文本' }).click()

  const textNode = page.locator('.react-flow__node-text')
  await expect(textNode).toHaveCount(1)
  await textNode.click()
  await textNode.locator('.canvas-text-node__preview').dblclick()
  const editor = textNode.getByRole('textbox', { name: '文本节点内容' })
  await editor.fill('雨夜巷口，镜头缓慢向前推进。')

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute(
    'data-hydrated',
    'true',
  )
  await textNode.click()
  await textNode.locator('.canvas-text-node__preview').dblclick()
  await expect(
    textNode.getByRole('textbox', { name: '文本节点内容' }),
  ).toHaveValue('雨夜巷口，镜头缓慢向前推进。')
})
