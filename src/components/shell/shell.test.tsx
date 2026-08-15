/// <reference types="node" />

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  BottomStatusBar,
  ModeSwitch,
  StoryboardView,
  ToolDock,
  TopBar,
  WorkspaceMenu,
} from './index'

function shellCss() {
  return readFileSync(
    fileURLToPath(new URL('../../styles/shell.css', import.meta.url)),
    'utf8',
  )
}

function cssRule(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [
    ...shellCss().matchAll(
      new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g'),
    ),
  ]

  expect(matches, `Missing CSS rule for ${selector}`).not.toHaveLength(0)
  return matches.map((match) => match[1]).join('\n')
}

function markup(node: ReactNode) {
  return renderToStaticMarkup(node)
}

describe('shell controls', () => {
  it('renders the current workspace and canvas in an accessible menu button', () => {
    const html = markup(
      <WorkspaceMenu workspaceName="未命名工作区" canvasName="画布 1" />,
    )

    expect(html).toContain('aria-label="打开工作区菜单：未命名工作区 / 画布 1"')
    expect(html).toContain('未命名工作区')
    expect(html).toContain('画布 1')
    expect(html).toContain('data-tooltip="工作区与画布"')
  })

  it('exposes a controlled workflow/storyboard mode switch', () => {
    const onChange = vi.fn()

    const html = markup(<ModeSwitch value="workflow" onChange={onChange} />)

    expect(html).toMatch(/aria-label="工作流"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/aria-label="故事板"[^>]*aria-pressed="false"/)
  })

  it('renders API, collaboration, and Agent commands without membership state', () => {
    const html = markup(
      <TopBar />,
    )

    expect(html).toContain('aria-label="打开 API 接入"')
    expect(html).toContain('aria-label="打开多人协作"')
    expect(html).toContain('aria-label="打开 Agent"')
    expect(html).not.toContain('会员中心')
    expect(html).not.toContain('1,555')
    expect(html).not.toContain('限时')
  })

  it('keeps API and collaboration reachable as icon buttons below 900px', () => {
    const css = shellCss()
    const narrowRule = css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/g)?.join('\n') ?? ''

    expect(narrowRule).toContain('.topbar-feature-button > span')
    expect(narrowRule).toMatch(/\.api-integration-button,[\s\S]*?width:\s*42px/)
    expect(narrowRule).not.toContain('.collaboration-button {\n    display: none')
  })

  it('composes all primary commands in the top bar', () => {
    const onAssets = vi.fn()
    const onApiIntegration = vi.fn()
    const onCollaboration = vi.fn()
    const onModeChange = vi.fn()

    const html = markup(
      <TopBar
        mode="workflow"
        onApiIntegration={onApiIntegration}
        onAssets={onAssets}
        onCollaboration={onCollaboration}
        onModeChange={onModeChange}
      />,
    )

    expect(html).toContain('aria-label="画布顶部工具栏"')
    expect(html).toContain('aria-label="资产库"')
    expect(html).toContain('aria-label="打开 API 接入"')
    expect(html).toContain('aria-label="打开多人协作"')
    expect(html).toContain('aria-label="打开 Agent"')
    expect(html).not.toContain('aria-label="分享"')
  })

  it('hides API management while collaboration capability is unavailable', () => {
    const html = markup(<TopBar apiIntegrationDisabled collaborationStatus="connecting" />)

    expect(html).not.toContain('aria-label="打开 API 接入"')
    expect(html).not.toContain('api-integration-button')
    expect(html).toContain('data-collaboration-status="connecting"')
  })

  it('shows collaboration connection state and caps the avatar stack at four members', () => {
    const html = markup(<TopBar
      collaborationMembers={[
        { id: '1', displayName: '甲', color: '#aa1111' },
        { id: '2', displayName: '乙', color: '#bb2222' },
        { id: '3', displayName: '丙', color: '#cc3333' },
        { id: '4', displayName: '丁', color: '#dd4444' },
        { id: '5', displayName: '戊', color: '#ee5555' },
      ]}
      collaborationStatus="offline"
    />)

    expect(html).toContain('离线编辑')
    expect((html.match(/data-collaboration-avatar=/g) ?? [])).toHaveLength(4)
    expect(html).not.toContain('data-collaboration-avatar="5"')
  })

  it('reports bottom-dock tools without owning application state', () => {
    const onToolSelect = vi.fn()

    const html = markup(
      <ToolDock activeTool="select" onToolSelect={onToolSelect} />,
    )

    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="创作工具"')
    expect(html).toMatch(/aria-label="选择 V"[^>]*aria-pressed="true"/)
    expect(html).toContain('aria-label="画框 F"')
    expect(html).toContain('aria-label="钢笔 P"')
    expect(html).not.toContain('打开工具箱')
    expect(html).not.toContain('角色库')
  })

  it('renders storyboard text, image, video, and reference sections', () => {
    const html = markup(
      <StoryboardView
        nodes={[
          { id: 'text-1', name: '旁白', type: 'text' },
          { id: 'image-1', name: '画面', type: 'image' },
          { id: 'video-1', name: '镜头', type: 'video' },
        ]}
        open
      />,
    )
    expect(html).toContain('aria-label="故事板视图"')
    expect(html).toContain('>文本<')
    expect(html).toContain('>图片<')
    expect(html).toContain('>视频<')
    expect(html).toContain('>添加参考<')
  })

  it('renders canvas status and accessible status actions', () => {
    const onAssetManager = vi.fn()

    const html = markup(
      <BottomStatusBar zoom={20} onAssetManager={onAssetManager} />,
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="画布状态"')
    expect(html).toContain('20%')
    expect(html).toContain('aria-label="资产管理"')
    expect(html).toContain('aria-label="整理画布，Alt+Shift+F"')
    expect(html).toContain('aria-label="切换小地图"')
    expect(html).toContain('aria-label="隐藏节点连线"')
    expect(html).toContain('aria-label="智能吸附"')
    expect(html).toContain('aria-label="缩放选项"')
  })
})

describe('reference geometry and styling', () => {
  it('uses the sampled canvas color and the supplied global font stack', () => {
    expect(shellCss()).toContain('--shell-canvas: #141414;')
    expect(shellCss()).toContain(
      `--shell-font: -apple-system, BlinkMacSystemFont, "PingFang SC", Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";`,
    )
  })

  it('matches the 2552 by 1308 workspace and mode anchors', () => {
    expect(cssRule('.workspace-menu')).toMatch(/left:\s*16px/)
    expect(cssRule('.workspace-menu')).toMatch(/top:\s*20px/)
    expect(cssRule('.workspace-menu')).toMatch(/width:\s*234px/)
    expect(cssRule('.workspace-menu')).toMatch(/height:\s*40px/)

    expect(cssRule('.mode-switch')).toMatch(/left:\s*50%/)
    expect(cssRule('.mode-switch')).toMatch(/top:\s*19px/)
    expect(cssRule('.mode-switch')).toMatch(/width:\s*180px/)
    expect(cssRule('.mode-switch')).toMatch(/height:\s*42px/)
    expect(cssRule('.mode-switch__option')).toMatch(/width:\s*83px/)
    expect(cssRule('.mode-switch__option')).toMatch(/height:\s*32px/)
  })

  it('matches the supplied top-right cluster dimensions', () => {
    expect(cssRule('.topbar-actions')).toMatch(/right:\s*16px/)
    expect(cssRule('.topbar-actions')).toMatch(/top:\s*10px/)
    expect(cssRule('.asset-button')).toMatch(/width:\s*42px/)
    expect(cssRule('.api-integration-button')).toMatch(/width:\s*94px/)
    expect(cssRule('.api-integration-button')).toMatch(/height:\s*40px/)
    expect(cssRule('.collaboration-button')).toMatch(/width:\s*108px/)
    expect(cssRule('.collaboration-button')).toMatch(/height:\s*40px/)
    expect(cssRule('.agent-button')).toMatch(/width:\s*89px/)
    expect(cssRule('.agent-button')).toMatch(/height:\s*40px/)
  })

  it('centers the 300 by 50 tool dock twelve pixels above the viewport edge', () => {
    expect(cssRule('.tool-dock')).toMatch(/left:\s*50%/)
    expect(cssRule('.tool-dock')).toMatch(/bottom:\s*12px/)
    expect(cssRule('.tool-dock')).toMatch(/width:\s*auto/)
    expect(cssRule('.tool-dock')).toMatch(/height:\s*50px/)
    expect(cssRule('.tool-dock')).toContain('box-sizing: border-box')
  })

  it('matches the measured typography and dark control treatments', () => {
    expect(cssRule('.workspace-menu')).toMatch(/padding:\s*0 8px/)
    expect(cssRule('.workspace-menu')).toMatch(/gap:\s*4px/)
    expect(cssRule('.workspace-menu')).toMatch(/border-radius:\s*8px/)
    expect(cssRule('.workspace-menu__title')).toMatch(/font-size:\s*16px/)
    expect(cssRule('.workspace-menu__title')).toMatch(/line-height:\s*24\.8px/)
    expect(cssRule('.mode-switch__option')).toMatch(/font-size:\s*13px/)
    expect(cssRule('.mode-switch__option')).toMatch(/line-height:\s*20\.15px/)
    expect(cssRule('.mode-switch__option[aria-pressed="true"]')).toContain(
      'background: rgb(54, 54, 54)',
    )
    expect(cssRule('.shell-icon-button')).toContain(
      'background: rgba(38, 38, 38, 0.8)',
    )
    expect(cssRule('.shell-icon-button')).toContain('border: 1px solid #363636')
    expect(cssRule('.shell-icon-button')).toContain('border-radius: 12px')
  })
})
