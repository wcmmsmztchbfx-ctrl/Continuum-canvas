/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  AddNodeMenu,
  ApiIntegrationPopover,
  BlankContextMenu,
  ConfirmDialog,
  HelpPopover,
  KeyboardShortcutsDialog,
  LayoutDecisionBar,
  CollaborationPopover,
  NodeContextMenu,
  PublishDialog,
  SelectionToolbar,
  SidePanel,
  ToastRegion,
  WorkspaceDropdown,
} from './index'
import { useToastQueue } from './ToastRegion'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('controlled overlay visibility and actions', () => {
  it('offers the original keep-or-restore decision after automatic layout', () => {
    const onKeep = vi.fn()
    const onRestore = vi.fn()
    const view = render(
      <LayoutDecisionBar
        onKeep={onKeep}
        onRestore={onRestore}
        open={false}
      />,
    )

    expect(screen.queryByRole('status', { name: '自动布局确认' })).toBeNull()
    view.rerender(
      <LayoutDecisionBar onKeep={onKeep} onRestore={onRestore} open />,
    )
    expect(screen.getByText('是否保留此次整理结果？')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '还原' }))
    fireEvent.click(screen.getByRole('button', { name: '保留' }))
    expect(onRestore).toHaveBeenCalledOnce()
    expect(onKeep).toHaveBeenCalledOnce()
  })

  it('only renders WorkspaceDropdown while open', () => {
    const { rerender } = render(
      <WorkspaceDropdown open={false} onAction={vi.fn()} onClose={vi.fn()} />,
    )

    expect(
      screen.queryByRole('menu', { name: '工作区菜单' }),
    ).not.toBeInTheDocument()

    rerender(
      <WorkspaceDropdown open onAction={vi.fn()} onClose={vi.fn()} />,
    )

    expect(screen.getByRole('menu', { name: '工作区菜单' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '新建项目' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '重命名项目' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '复制项目' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '删除项目' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '系统设置' })).toBeVisible()
  })

  it('reports workspace actions and requests close', () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(
      <WorkspaceDropdown
        open
        onAction={onAction}
        onClose={onClose}
        subject="canvas"
      />,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: '重命名画布' }))

    expect(onAction).toHaveBeenCalledWith('rename')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hides local workspace navigation for invited collaborators', () => {
    render(
      <WorkspaceDropdown
        collaborationRestricted
        open
        onAction={vi.fn()}
        onClose={vi.fn()}
        subject="canvas"
      />,
    )

    expect(screen.queryByRole('menuitem', { name: '返回工作区' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '新建项目' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '重命名画布' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: '复制画布' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '移入回收站' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '系统设置' })).toBeNull()
  })

  it('lists node creation types and reports the selected kind', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<AddNodeMenu open onClose={onClose} onSelect={onSelect} />)

    for (const label of [
      '文本',
      '图片',
      '视频',
      '视频合成',
      '导演台',
      '音频',
      '脚本',
      '资产库',
      '上传',
      '从生成历史选择',
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeVisible()
    }
    expect(screen.getByText('Beta')).toBeVisible()
    expect(screen.getAllByText('NEW')).toHaveLength(2)

    fireEvent.click(screen.getByRole('menuitem', { name: '图片' }))

    expect(onSelect).toHaveBeenCalledWith('image')
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('SidePanel', () => {
  it.each([
    ['project-files', '项目文件'],
    ['canvases', '画布列表'],
    ['assets', '资产'],
    ['templates', '工具与工作流模板'],
    ['styles', '风格与镜头'],
    ['characters', '角色'],
    ['history', '历史记录'],
    ['agent', 'Agent'],
  ] as const)('renders %s content with the expected title', (kind, title) => {
    render(<SidePanel kind={kind} open onClose={vi.fn()} />)

    expect(screen.getByRole('complementary', { name: title })).toBeVisible()
    expect(screen.getByRole('heading', { name: title })).toBeVisible()
  })

  it('supports the compact Agent width and caller content', () => {
    render(
      <SidePanel agentWidth={340} kind="agent" open onClose={vi.fn()}>
        <p>从这里开始创作</p>
      </SidePanel>,
    )

    expect(screen.getByText('从这里开始创作')).toBeVisible()
    expect(screen.getByRole('complementary')).toHaveClass(
      'overlay-side-panel--agent-compact',
    )
  })

  it('renders the asset manager controls and locates a canvas node', () => {
    const onLocateNode = vi.fn()
    render(
      <SidePanel
        canvasNodes={[
          { id: 'image-1', name: '图片节点 1', type: 'image' },
          { id: 'video-1', name: '视频节点 1', type: 'video' },
        ]}
        kind="project-files"
        onClose={vi.fn()}
        onLocateNode={onLocateNode}
        open
      />,
    )

    expect(screen.getByRole('tab', { name: '画布' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '资产' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: '搜索节点' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '定位图片节点 1' }))
    expect(onLocateNode).toHaveBeenCalledWith('image-1')
  })

  it.each([
    ['templates', '使用'],
    ['assets', '应用风格'],
    ['characters', '应用至画布'],
    ['history', '图片'],
  ] as const)('renders discoverable %s panel controls', (kind, label) => {
    render(<SidePanel kind={kind} onClose={vi.fn()} open />)
    expect(screen.getAllByRole('button', { name: label })[0]).toBeVisible()
  })
})

describe('dialogs and popovers', () => {
  it('renders a gateway-backed API integration summary shell', () => {
    const onUnavailable = vi.fn()
    render(
      <ApiIntegrationPopover
        onClose={vi.fn()}
        onUnavailable={onUnavailable}
        open
      />,
    )

    expect(screen.getByRole('dialog', { name: 'API 接入' })).toBeVisible()
    expect(screen.getByText('待配置')).toBeVisible()
    expect(screen.getByText('尚未添加供应商')).toBeVisible()
    expect(screen.getByRole('button', { name: '快速测试' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '同步配置' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '管理接入' }))
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('starts collaboration without fake email invitations', () => {
    const onEnable = vi.fn()
    render(
      <CollaborationPopover
        onClose={vi.fn()}
        onEnable={onEnable}
        open
        state={{ status: 'inactive', inviteLinks: {} }}
      />,
    )

    expect(screen.getByRole('dialog', { name: '多人协作' })).toBeVisible()
    expect(screen.queryByPlaceholderText('输入邮箱或成员账号')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '协作昵称' }), { target: { value: '林导' } })
    fireEvent.click(screen.getByRole('button', { name: '开启协作' }))
    expect(onEnable).toHaveBeenCalledWith('林导')
  })

  it('focuses collaboration work immediately and traps tab navigation', () => {
    render(<CollaborationPopover onClose={vi.fn()} open state={{ status: 'inactive', inviteLinks: {} }} />)
    const input = screen.getByRole('textbox', { name: '协作昵称' })
    expect(input).toHaveFocus()
    const enable = screen.getByRole('button', { name: '开启协作' })
    fireEvent.change(input, { target: { value: 'Owner' } })
    enable.focus()
    fireEvent.keyDown(enable, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭多人协作' })).toHaveFocus()
  })

  it('shows owner room controls and keeps them hidden from viewers', () => {
    const base = {
      status: 'synced' as const,
      inviteLinks: { 'invite-editor': 'http://localhost/canvas?collabRoom=room-a#invite=secret' },
      room: {
        roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a', ownerId: 'owner-a',
        createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', enabled: true,
        members: [
          { id: 'owner-a', displayName: '林导', role: 'owner' as const, removed: false },
          { id: 'editor-a', displayName: '剪辑师', role: 'editor' as const, removed: false },
        ],
        invites: [{ id: 'invite-editor', role: 'editor' as const, createdAt: '2026-07-18T00:01:00.000Z', revoked: false }],
      },
    }
    const ownerSession = { roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a', memberId: 'owner-a', displayName: '林导', role: 'owner' as const, status: 'connected' as const }
    const view = render(<CollaborationPopover onClose={vi.fn()} open state={{ ...base, session: ownerSession, recoverySecret: 'one-time-secret' }} />)
    expect(screen.getByRole('button', { name: '创建编辑链接' })).toBeVisible()
    expect(screen.getByRole('button', { name: '创建查看链接' })).toBeVisible()
    expect(screen.getByRole('button', { name: '复制恢复密钥' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: '设置 剪辑师 的角色' })).toBeVisible()

    view.rerender(<CollaborationPopover onClose={vi.fn()} open state={{ ...base, recoverySecret: undefined, session: { ...ownerSession, memberId: 'editor-a', role: 'viewer' } }} />)
    expect(screen.queryByRole('button', { name: '创建编辑链接' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '设置 剪辑师 的角色' })).toBeNull()
    expect(screen.getByRole('button', { name: '离开协作' })).toBeVisible()
  })

  it('shows live member presence and lets every role follow an online member', () => {
    const onFollowMember = vi.fn()
    const base = {
      status: 'synced' as const,
      inviteLinks: {},
      room: {
        roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a', ownerId: 'owner-a',
        createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', enabled: true,
        members: [
          { id: 'owner-a', displayName: '林导', role: 'owner' as const, removed: false },
          { id: 'viewer-a', displayName: '观察者', role: 'viewer' as const, removed: false },
        ],
        invites: [],
      },
      session: {
        roomId: 'room-a', canvasId: 'canvas-a', projectId: 'project-a',
        memberId: 'viewer-a', displayName: '观察者', role: 'viewer' as const, status: 'connected' as const,
      },
    }
    const presence = [{
      clientId: 8,
      member: { memberId: 'owner-a', displayName: '林导', color: '#e59a52', role: 'owner' as const },
      cursor: null,
      selection: { nodeIds: [] },
      viewport: { x: 2, y: 3, zoom: 1 },
    }]
    const view = render(<CollaborationPopover
      onClose={vi.fn()} onFollowMember={onFollowMember} open presence={presence} state={base}
    />)

    expect(screen.getAllByText('在线', { selector: 'small' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '跟随 林导' }))
    expect(onFollowMember).toHaveBeenCalledWith('owner-a')

    view.rerender(<CollaborationPopover
      followingMemberId="owner-a" onClose={vi.fn()} onFollowMember={onFollowMember}
      open presence={presence} state={base}
    />)
    fireEvent.click(screen.getByRole('button', { name: '取消跟随 林导' }))
    expect(onFollowMember).toHaveBeenLastCalledWith(undefined)
  })

  it('gives PublishDialog modal semantics and reports visibility and publish', () => {
    const onPublish = vi.fn()
    const onVisibilityChange = vi.fn()
    render(
      <PublishDialog
        onClose={vi.fn()}
        onPublish={onPublish}
        onVisibilityChange={onVisibilityChange}
        open
        projectTitle="城市回声"
        visibility="public"
      />,
    )

    const dialog = screen.getByRole('dialog', { name: '发布项目' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByDisplayValue('城市回声')).toHaveAttribute('readonly')

    fireEvent.click(screen.getByRole('radio', { name: '私密' }))
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }))

    expect(onVisibilityChange).toHaveBeenCalledWith('private')
    expect(onPublish).toHaveBeenCalledOnce()
  })

  it('requires an explicit confirmation for destructive actions', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ConfirmDialog
        confirmLabel="删除项目"
        message="删除后将打开一个新的空白项目。"
        onClose={onClose}
        onConfirm={onConfirm}
        open
        title="删除当前项目？"
      />,
    )

    expect(screen.getByRole('dialog', { name: '删除当前项目？' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '确认删除项目' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders help actions as a controlled popover', () => {
    const onHelpAction = vi.fn()
    render(
      <HelpPopover onAction={onHelpAction} onClose={vi.fn()} open />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '新手教程' }))
    expect(onHelpAction).toHaveBeenCalledWith('guide')
  })

  it('keeps commercial and contact tutorial actions visible but disabled', () => {
    render(<HelpPopover onClose={vi.fn()} open />)
    expect(screen.getByRole('menuitem', { name: '新手教程' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '联系客服' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '商务合作' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '创作者社群' })).toBeDisabled()

  })

  it('renders an accessible keyboard shortcuts dialog', () => {
    render(<KeyboardShortcutsDialog onClose={vi.fn()} open />)

    const dialog = screen.getByRole('dialog', { name: '键盘快捷键' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('撤销')).toBeVisible()
    expect(screen.getByText('Ctrl Z')).toBeVisible()
    expect(screen.getByText('删除所选')).toBeVisible()
  })
})

describe('contextual controls', () => {
  it('reports blank-canvas context actions at the requested position', () => {
    const onAction = vi.fn()
    render(
      <BlankContextMenu
        onAction={onAction}
        onClose={vi.fn()}
        open
        position={{ x: 12, y: 18 }}
      />,
    )

    const menu = screen.getByRole('menu', { name: '画布快捷菜单' })
    expect(menu).toHaveStyle({ left: '12px', top: '18px' })
    expect(screen.getByRole('menuitem', { name: '上传' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '保存到我的资产' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '添加节点' })).toBeVisible()

    fireEvent.click(screen.getByRole('menuitem', { name: '粘贴' }))
    expect(onAction).toHaveBeenCalledWith('paste')
  })

  it('reports the original node context actions and disabled placeholders', () => {
    const onAction = vi.fn()
    render(
      <NodeContextMenu onAction={onAction} onClose={vi.fn()} open />,
    )

    expect(screen.getByRole('menuitem', { name: '内容合规检测' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '保存到我的资产' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '创建主体' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: '固定' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '复制节点' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '生成副本' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '复制到剪贴板' })).toBeVisible()

    fireEvent.click(screen.getByRole('menuitem', { name: '固定' }))
    expect(onAction).toHaveBeenCalledWith('toggle-lock')
  })

  it('renders unlock action when the node is already locked', () => {
    const onAction = vi.fn()
    render(
      <NodeContextMenu isLocked onAction={onAction} onClose={vi.fn()} open />,
    )

    expect(screen.getByRole('menuitem', { name: '解除固定' })).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: '解除固定' }))
    expect(onAction).toHaveBeenCalledWith('toggle-lock')
  })

  it('renders copy-image action only when hasImage is true', () => {
    const onAction = vi.fn()
    const { rerender } = render(
      <NodeContextMenu hasImage={false} onAction={onAction} onClose={vi.fn()} open />,
    )

    expect(screen.queryByRole('menuitem', { name: '复制图片' })).toBeNull()

    rerender(
      <NodeContextMenu hasImage onAction={onAction} onClose={vi.fn()} open />,
    )

    expect(screen.getByRole('menuitem', { name: '复制图片' })).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: '复制图片' }))
    expect(onAction).toHaveBeenCalledWith('copy-image')
  })

  it('exposes the original-style multi-selection commands', () => {
    const onAction = vi.fn()
    const view = render(
      <SelectionToolbar
        grouped={false}
        onAction={onAction}
        open
      />,
    )

    for (const label of [
      '整理选区',
      '保存到资产',
      '创建副本',
      '复制',
      '打组',
      '添加到 Chat',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeVisible()
    }
    expect(screen.getByRole('button', { name: '添加到 Chat' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '创建副本' }))
    expect(onAction).toHaveBeenCalledWith('duplicate')
    fireEvent.click(screen.getByRole('button', { name: '打组' }))
    expect(onAction).toHaveBeenCalledWith('group')

    view.rerender(<SelectionToolbar grouped onAction={onAction} open />)
    fireEvent.click(screen.getByRole('button', { name: '解组' }))
    expect(onAction).toHaveBeenCalledWith('ungroup')
  })
})

describe('closing behavior', () => {
  const escapeCases: Array<[string, (onClose: () => void) => ReactElement]> = [
    [
      'WorkspaceDropdown',
      (onClose) => (
        <WorkspaceDropdown open onAction={vi.fn()} onClose={onClose} />
      ),
    ],
    [
      'AddNodeMenu',
      (onClose) => <AddNodeMenu open onClose={onClose} onSelect={vi.fn()} />,
    ],
    [
      'SidePanel',
      (onClose) => <SidePanel kind="assets" open onClose={onClose} />,
    ],
    [
      'ApiIntegrationPopover',
      (onClose) => <ApiIntegrationPopover onClose={onClose} open />,
    ],
    [
      'PublishDialog',
      (onClose) => <PublishDialog onClose={onClose} open />,
    ],
    [
      'CollaborationPopover',
      (onClose) => <CollaborationPopover onClose={onClose} open state={{ status: 'inactive', inviteLinks: {} }} />,
    ],
    [
      'HelpPopover',
      (onClose) => <HelpPopover onClose={onClose} open />,
    ],
    [
      'KeyboardShortcutsDialog',
      (onClose) => <KeyboardShortcutsDialog onClose={onClose} open />,
    ],
    [
      'BlankContextMenu',
      (onClose) => <BlankContextMenu onClose={onClose} open />,
    ],
    [
      'NodeContextMenu',
      (onClose) => <NodeContextMenu onClose={onClose} open />,
    ],
  ]

  it.each(escapeCases)('%s requests close on Escape', (_name, createOverlay) => {
    const onClose = vi.fn()
    render(createOverlay(onClose))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('overlay positioning and focus', () => {
  it('clamps pointer-positioned menus inside the viewport', () => {
    vi.stubGlobal('innerWidth', 1366)
    vi.stubGlobal('innerHeight', 768)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 196,
      bottom: 200,
      width: 196,
      height: 200,
      toJSON: () => ({}),
    })

    render(
      <NodeContextMenu
        onClose={vi.fn()}
        open
        position={{ x: 1340, y: 740 }}
      />,
    )

    expect(screen.getByRole('menu', { name: '节点快捷菜单' })).toHaveStyle({
      left: '1162px',
      top: '560px',
    })
  })

  it('moves menu focus with arrow keys', () => {
    render(<BlankContextMenu onClose={vi.fn()} open />)
    const items = screen.getAllByRole('menuitem')

    expect(items[0]).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(items[2]).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    expect(items.at(-1)).toHaveFocus()
  })

  it('restores add-node menu focus to its opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = render(<AddNodeMenu open onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
    view.rerender(<AddNodeMenu open={false} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('traps dialog focus and restores it to the opener', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = render(<PublishDialog onClose={vi.fn()} open />)
    const dialog = screen.getByRole('dialog', { name: '发布项目' })
    const firstField = screen.getByDisplayValue('未命名项目')

    expect(firstField).toHaveFocus()
    opener.focus()
    expect(firstField).toHaveFocus()

    screen.getByRole('button', { name: '确认发布' }).focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })

    view.rerender(<PublishDialog onClose={vi.fn()} open={false} />)
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

describe('ToastRegion', () => {
  it('renders typed notifications and reports dismissals', () => {
    const onDismiss = vi.fn()
    render(
      <ToastRegion
        onDismiss={onDismiss}
        toasts={[
          { id: 'saved', message: '已保存到项目', tone: 'success' },
          { id: 'failed', message: '上传失败，请重试', tone: 'error' },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: '通知' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('已保存到项目')
    expect(screen.getByRole('alert')).toHaveTextContent('上传失败，请重试')

    fireEvent.click(screen.getByRole('button', { name: '关闭：已保存到项目' }))
    expect(onDismiss).toHaveBeenCalledWith('saved')
  })

  it('expires typed notifications, coalesces duplicates, and cleans timers', () => {
    vi.useFakeTimers()
    function Harness() {
      const queue = useToastQueue()
      return (
        <>
          <button onClick={() => queue.notify('信息', 'info')} type="button">信息</button>
          <button onClick={() => queue.notify('警告', 'warning')} type="button">警告</button>
          <button onClick={() => queue.notify('错误', 'error')} type="button">错误</button>
          <ToastRegion onDismiss={queue.dismiss} toasts={queue.toasts} />
        </>
      )
    }

    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '信息' }))
    act(() => vi.advanceTimersByTime(2_000))
    fireEvent.click(screen.getByRole('button', { name: '信息' }))
    expect(screen.getAllByText('信息')).toHaveLength(2)
    act(() => vi.advanceTimersByTime(2_499))
    expect(screen.getByRole('status')).toHaveTextContent('信息')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '警告' }))
    act(() => vi.advanceTimersByTime(3_999))
    expect(screen.getByRole('status')).toHaveTextContent('警告')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByText('警告', { selector: '.overlay-toast span' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '错误' }))
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('错误')
    fireEvent.click(screen.getByRole('button', { name: '关闭：错误' }))
    expect(screen.queryByRole('alert')).toBeNull()

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps only the three newest notifications', () => {
    function Harness() {
      const queue = useToastQueue()
      return (
        <>
          {['一', '二', '三', '四'].map((message) => (
            <button key={message} onClick={() => queue.notify(message)} type="button">
              {message}
            </button>
          ))}
          <ToastRegion onDismiss={queue.dismiss} toasts={queue.toasts} />
        </>
      )
    }
    render(<Harness />)
    for (const message of ['一', '二', '三', '四']) {
      fireEvent.click(screen.getByRole('button', { name: message }))
    }
    expect(screen.queryByText('一', { selector: '.overlay-toast span' })).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(3)
  })

  it('never evicts persistent errors in favor of later transient notifications', () => {
    function Harness() {
      const queue = useToastQueue()
      return (
        <>
          {['错误一', '错误二', '信息一', '信息二'].map((message) => (
            <button
              key={message}
              onClick={() => queue.notify(message, message.startsWith('错误') ? 'error' : 'info')}
              type="button"
            >{message}</button>
          ))}
          <ToastRegion onDismiss={queue.dismiss} toasts={queue.toasts} />
        </>
      )
    }
    render(<Harness />)
    for (const message of ['错误一', '错误二', '信息一', '信息二']) {
      fireEvent.click(screen.getByRole('button', { name: message }))
    }
    expect(screen.getByText('错误一', { selector: '.overlay-toast span' })).toBeVisible()
    expect(screen.getByText('错误二', { selector: '.overlay-toast span' })).toBeVisible()
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.queryByText('信息一', { selector: '.overlay-toast span' })).toBeNull()
    expect(screen.getByText('信息二', { selector: '.overlay-toast span' })).toBeVisible()
  })
})

describe('overlay visual contract', () => {
  it('keeps the reference dark palette and measured overlay widths', () => {
    const cssPath = resolve(process.cwd(), 'src/styles/overlays.css')
    const exists = existsSync(cssPath)

    expect(exists).toBe(true)
    if (!exists) return

    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('--overlay-canvas: #141414;')
    expect(css).toContain('--overlay-surface: #262626;')
    expect(css).toContain('--overlay-border: #363636;')
    expect(css).toMatch(/\.overlay-menu\s*\{[^}]*width:\s*196px/s)
    expect(css).toMatch(/\.overlay-side-panel--agent\s*\{[^}]*width:\s*400px/s)
    expect(css).toMatch(
      /\.overlay-side-panel--agent-compact\s*\{[^}]*width:\s*340px/s,
    )
    expect(css).toMatch(/\.api-integration-popover\s*\{[^}]*width:\s*360px/s)
    expect(css).toMatch(/\.collaboration-popover\s*\{[^}]*width:\s*380px/s)
    expect(css).toMatch(/\.publish-dialog\s*\{[^}]*width:\s*480px/s)
  })
})
