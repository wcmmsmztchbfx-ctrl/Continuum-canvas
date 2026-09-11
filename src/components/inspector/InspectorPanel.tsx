import { useState, useCallback, useRef, type ChangeEvent } from 'react'
import { useStore } from 'zustand'
import {
  Square,
  Circle,
  Type,
  Image as ImageIcon,
  Film,
  Frame,
  Folder,
  PenTool,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  BringToFront,
  SendToBack,
  Sliders,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sparkles,
  Link2,
  Unlink2,
  ChevronRight,
  Maximize2,
  Settings,
  Cpu,
  UsersRound,
  Move,
  Percent,
  Palette,
  RotateCw,
  CornerUpRight,
  Minus,
  MoreHorizontal,
  Droplets,
  BoxSelect,
  Layers,
} from 'lucide-react'

import type { CanvasStore, CanvasStoreState } from '../../store/canvas-store'
import type { CanvasNode, TextNode, ImageNodeData, VideoNodeData, CanvasNodeEffectShadow } from '../../model/project'
import { ScrubbableLabel } from './ScrubbableLabel'
import './inspector.css'

interface InspectorPanelProps {
  store: CanvasStore
  readOnly?: boolean
  collapsed?: boolean
  onOpenSettings?: () => void
  collaborationStatus?: 'inactive' | 'enabling' | 'connecting' | 'synced' | 'offline' | 'error'
  collaborationMembers?: ReadonlyArray<{
    id: string
    displayName: string
    color?: string
    online?: boolean
  }>
  onOpenCollaboration?: () => void
  onOpenApiManagement?: () => void
  currentNickname?: string
  onStartResize?: (event: React.MouseEvent<HTMLDivElement>) => void
  onStartVectorEdit?: (nodeId: string) => void
  isEditingVector?: boolean
}

import { getCollaboratorColor } from '../../collaboration/colors'

const FRAME_PRESETS = [
  { label: '自定义尺寸', width: 0, height: 0 },
  { label: '16:9 宽屏 (1920×1080)', width: 1920, height: 1080 },
  { label: '9:16 竖屏 (1080×1920)', width: 1080, height: 1920 },
  { label: '1:1 正方形 (1080×1080)', width: 1080, height: 1080 },
  { label: '4:3 标准 (1440×1080)', width: 1440, height: 1080 },
  { label: 'A4 纸张 (595×842)', width: 595, height: 842 },
]

export function InspectorPanel({
  store,
  readOnly = false,
  collapsed = false,
  onOpenSettings,
  collaborationStatus = 'inactive',
  collaborationMembers = [],
  onOpenCollaboration,
  onOpenApiManagement,
  currentNickname,
  onStartResize,
  onStartVectorEdit,
  isEditingVector = false,
}: InspectorPanelProps) {
  const snapshot = useStore(store, (state: CanvasStoreState) => state.snapshot)
  const selectedNodeIds = useStore(store, (state: CanvasStoreState) => state.selectedNodeIds)
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false)
  const [canvasNameDraft, setCanvasNameDraft] = useState<string | null>(null)
  const [nodeNameDraft, setNodeNameDraft] = useState<{ id: string; name: string } | null>(null)
  const pendingColorFrame = useRef<number | null>(null)

  const selectedNodes = snapshot.nodes.filter((node: CanvasNode) =>
    selectedNodeIds.includes(node.id),
  )
  const activeNode = selectedNodes.length === 1 ? selectedNodes[0] : null

  // Helpers for node updates with ephemeral live updates (commit = false) and single-step undo (commit = true)
  const patchActive = useCallback(
    (changes: Parameters<ReturnType<typeof store.getState>['patchNode']>[1], commit = true) => {
      if (!activeNode || readOnly) return
      store.getState().patchNode(activeNode.id, changes, commit)
    },
    [activeNode, readOnly, store],
  )

  const updateActiveData = useCallback(
    (dataChanges: Record<string, unknown>, commit = true) => {
      if (!activeNode || readOnly) return
      store.getState().patchNode(activeNode.id, { data: dataChanges }, commit)
    },
    [activeNode, readOnly, store],
  )

  const updateActiveDataThrottled = useCallback(
    (dataChanges: Record<string, unknown>) => {
      if (!activeNode || readOnly) return
      if (pendingColorFrame.current !== null) {
        cancelAnimationFrame(pendingColorFrame.current)
      }
      pendingColorFrame.current = requestAnimationFrame(() => {
        pendingColorFrame.current = null
        store.getState().patchNode(activeNode.id, { data: dataChanges }, false)
      })
    },
    [activeNode, readOnly, store],
  )

  const handleNameChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!activeNode || readOnly) return
    setNodeNameDraft({ id: activeNode.id, name: e.target.value })
  }

  const handlePosChange = (axis: 'x' | 'y', value: number, commit = true) => {
    if (!activeNode || readOnly || Number.isNaN(value)) return
    patchActive({
      position: {
        ...activeNode.position,
        [axis]: value,
      },
    }, commit)
  }

  const handleSizeChange = (dim: 'width' | 'height', value: number, commit = true) => {
    if (!activeNode || readOnly || Number.isNaN(value) || value <= 0) return
    const currentW = activeNode.size.width
    const currentH = activeNode.size.height
    if (aspectRatioLocked && currentW > 0 && currentH > 0) {
      if (dim === 'width') {
        const nextH = Math.round(value * (currentH / currentW))
        patchActive({ size: { width: value, height: nextH } }, commit)
      } else {
        const nextW = Math.round(value * (currentW / currentH))
        patchActive({ size: { width: nextW, height: value } }, commit)
      }
    } else {
      patchActive({
        size: {
          ...activeNode.size,
          [dim]: value,
        },
      }, commit)
    }
  }

  const hasMembers = collaborationMembers && collaborationMembers.length > 0
  const hasSelfName = Boolean(currentNickname && currentNickname.trim())

  const renderAvatars = () => {
    if (hasMembers) {
      return (
        <div
          className="inspector-top-bar__avatars"
          onClick={onOpenCollaboration}
          title={`协作成员 (${collaborationMembers!.length}人) - 点击查看`}
        >
          {collaborationMembers!.map((member, idx) => {
            const char = (member.displayName || '名').trim().slice(0, 1).toUpperCase()
            const bg = member.color || getCollaboratorColor(member.id || member.displayName || '名')
            const isOnline = member.online !== false
            return (
              <div
                key={member.id || idx}
                className={`inspector-top-bar__avatar-bubble ${!isOnline ? 'inspector-top-bar__avatar-bubble--offline' : ''}`}
                style={{ background: bg, zIndex: 10 - idx }}
                title={`${member.displayName}${isOnline ? ' (在线)' : ' (离线)'}`}
              >
                {char}
              </div>
            )
          })}
        </div>
      )
    }

    if (hasSelfName) {
      return (
        <div
          className="inspector-top-bar__avatars"
          onClick={onOpenCollaboration}
          title={`当前用户：${currentNickname} (点击开启多人协作)`}
        >
          <div
            className="inspector-top-bar__avatar-bubble"
            style={{ background: getCollaboratorColor(currentNickname!) }}
          >
            {currentNickname!.trim().slice(0, 1).toUpperCase()}
          </div>
        </div>
      )
    }

    return (
      <div
        className="inspector-top-bar__avatars"
        onClick={onOpenCollaboration}
        title="暂无协作者 (点击开启协作)"
      >
        <div
          className="inspector-top-bar__avatar-bubble inspector-top-bar__avatar-bubble--none"
          style={{ background: '#475569' }}
        >
          无
        </div>
      </div>
    )
  }

  const renderTopBar = () => (
    <div
      className="inspector-top-bar"
      data-collaboration-status={collaborationStatus}
      data-testid="top-bar"
    >
      {renderAvatars()}

      <div className="inspector-top-bar__actions">
        {onOpenApiManagement && (
          <button
            aria-label="API 接入与模型"
            className="inspector-top-bar__icon-btn"
            onClick={onOpenApiManagement}
            title="API 接入与模型设置"
            type="button"
          >
            <Cpu size={14} />
          </button>
        )}

        {onOpenCollaboration && (
          <button
            aria-label="多人协作"
            className={`inspector-top-bar__share-btn ${collaborationStatus === 'synced' ? 'inspector-top-bar__share-btn--synced' : ''}`}
            onClick={onOpenCollaboration}
            title="多人协作"
            type="button"
          >
            <UsersRound size={12} />
            <span>协作</span>
            {collaborationMembers && collaborationMembers.length > 1 && (
              <span className="inspector-top-bar__share-badge">
                {collaborationMembers.length}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  )

  if (collapsed) {
    return <aside className="inspector-panel inspector-panel--collapsed" />
  }

  // 1. Multi-selection mode
  if (selectedNodes.length > 1) {
    const hasFill = selectedNodes.some((n) => 'fill' in n.data)
    const firstFillNode = selectedNodes.find((n) => 'fill' in n.data)
    const firstFill = firstFillNode ? (firstFillNode.data as { fill?: string }).fill || '#202020' : '#202020'
    const averageOpacity = Math.round(
      (selectedNodes.reduce((acc, n) => {
        const op = (n.data as { opacity?: number }).opacity ?? 1
        return acc + op
      }, 0) / selectedNodes.length) * 100
    )

    const updateSelectedNodesData = (dataChanges: Record<string, unknown>, commit = true) => {
      if (readOnly) return
      for (const node of selectedNodes) {
        store.getState().patchNode(node.id, { data: dataChanges }, commit)
      }
    }

    return (
      <aside className="inspector-panel" data-testid="inspector-panel">
        {onStartResize && (
          <div
            aria-label="调整属性面板宽度"
            aria-orientation="vertical"
            className="inspector-panel__resize-handle"
            onMouseDown={onStartResize}
            role="separator"
          />
        )}
        {renderTopBar()}
        <div className="inspector-header">
          <div className="inspector-header__title-group">
            <span className="inspector-header__icon"><Sliders size={14} /></span>
            <span style={{ fontWeight: 600, fontSize: '12px' }}>已选中 {selectedNodes.length} 个对象</span>
          </div>
          <div className="inspector-header__actions">
            <button
              aria-label="批量删除"
              className="inspector-icon-btn inspector-icon-btn--danger"
              disabled={readOnly}
              onClick={() => store.getState().deleteNodes(selectedNodeIds, { force: true })}
              title="删除选中对象"
              type="button"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
        <div className="inspector-body">
          {/* Batch Opacity */}
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span className="inspector-section__title">
                <span className="inspector-section__icon"><Percent size={13} /></span>
                <span>透明度 (Opacity)</span>
              </span>
            </div>
            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableLabel
                  label="不透明度"
                  max={100}
                  min={0}
                  onChange={(val) => updateSelectedNodesData({ opacity: Math.min(1, Math.max(0, val / 100)) }, false)}
                  onChangeEnd={(val) => updateSelectedNodesData({ opacity: Math.min(1, Math.max(0, val / 100)) }, true)}
                  value={averageOpacity}
                />
                <input
                  aria-label="批量透明度百分比"
                  className="inspector-field__input"
                  disabled={readOnly}
                  max={100}
                  min={0}
                  onBlur={(e) =>
                    updateSelectedNodesData({
                      opacity: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                    }, true)
                  }
                  onChange={(e) =>
                    updateSelectedNodesData({
                      opacity: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                    }, false)
                  }
                  type="number"
                  value={averageOpacity}
                />
                <span style={{ color: '#737373', fontSize: '10px' }}>%</span>
              </div>
            </div>
          </div>

          {/* Batch Fill */}
          {hasFill ? (
            <div className="inspector-section">
              <div className="inspector-section__header">
                <span className="inspector-section__title">
                  <span className="inspector-section__icon"><Palette size={13} /></span>
                  <span>批量填充 (Fill)</span>
                </span>
              </div>
              <div className="inspector-color-row">
                <div className="inspector-color-chip" style={{ background: firstFill }}>
                  <input
                    aria-label="批量填充原生颜色"
                    className="inspector-color-input-native"
                    disabled={readOnly}
                    onChange={(e) => {
                      for (const node of selectedNodes) {
                        if ('fill' in node.data) {
                          store.getState().patchNode(node.id, { data: { fill: e.target.value } }, false)
                        }
                      }
                    }}
                    type="color"
                    value={firstFill.startsWith('#') ? firstFill : '#202020'}
                  />
                </div>
                <input
                  aria-label="批量填充颜色十六进制"
                  className="inspector-color-hex"
                  disabled={readOnly}
                  onChange={(e) => {
                    for (const node of selectedNodes) {
                      if ('fill' in node.data) {
                        store.getState().patchNode(node.id, { data: { fill: e.target.value } }, false)
                      }
                    }
                  }}
                  value={firstFill}
                />
              </div>
            </div>
          ) : null}

          <div className="inspector-section">
            <div className="inspector-section__header">
              <span className="inspector-section__title">
                <span className="inspector-section__icon"><Folder size={13} /></span>
                <span>批量操作</span>
              </span>
            </div>
            <div className="inspector-row">
              <button
                className="inspector-toggle-btn"
                disabled={readOnly}
                onClick={() => {
                  const groupId = `g-${Date.now().toString(36)}`
                  store.getState().groupNodes(selectedNodeIds, groupId, '编组')
                }}
                type="button"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Folder size={13} /> 编组选中图层
                </span>
                <span style={{ fontSize: '10px', color: '#888' }}>Ctrl+G</span>
              </button>
            </div>
          </div>
        </div>
      </aside>
    )
  }

  // 2. No node selected: Canvas Overview mode
  if (!activeNode) {
    return (
      <aside className="inspector-panel" data-testid="inspector-panel">
        {onStartResize && (
          <div
            aria-label="调整属性面板宽度"
            aria-orientation="vertical"
            className="inspector-panel__resize-handle"
            onMouseDown={onStartResize}
            role="separator"
          />
        )}
        {renderTopBar()}
        <div className="inspector-header">
          <div className="inspector-header__title-group">
            <span className="inspector-header__icon"><Sliders size={14} /></span>
            <span style={{ fontWeight: 600, fontSize: '12px' }}>画布属性</span>
          </div>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>画布概览</span>
            </div>
            <div className="inspector-row">
              <div className="inspector-field">
                <span className="inspector-field__label">名称</span>
                <input
                  className="inspector-field__input"
                  disabled={readOnly}
                  onBlur={() => {
                    if (canvasNameDraft !== null) {
                      const trimmed = canvasNameDraft.trim()
                      if (trimmed && trimmed !== snapshot.name) {
                        store.getState().renameCanvas(trimmed)
                      }
                      setCanvasNameDraft(null)
                    }
                  }}
                  onChange={(e) => setCanvasNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  value={canvasNameDraft ?? (snapshot.name || '画布 1')}
                />
              </div>
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field">
                <span className="inspector-field__label">缩放</span>
                <span style={{ color: '#fff', fontSize: '11px' }}>
                  {Math.round(snapshot.viewport.zoom * 100)}%
                </span>
              </div>
              <div className="inspector-field">
                <span className="inspector-field__label">对象数</span>
                <span style={{ color: '#fff', fontSize: '11px' }}>
                  {snapshot.nodes.length} 个节点
                </span>
              </div>
            </div>
          </div>

          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>视图与设置</span>
            </div>
            <div className="inspector-row">
              <button
                className="inspector-toggle-btn"
                onClick={onOpenSettings}
                type="button"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Settings size={13} /> 项目与全局设置
                </span>
                <ChevronRight size={13} />
              </button>
            </div>
          </div>

          <div className="inspector-empty">
            <Sliders className="inspector-empty__icon" size={28} />
            <p style={{ margin: 0, fontSize: '11px', color: '#888' }}>
              选择画布上的任意节点，即可在此处查看并编辑其完整尺寸、样式与排版属性。按住标签可左右拖拽快速微调数值。
            </p>
          </div>
        </div>
      </aside>
    )
  }

  // 3. Single Node Selected: Detailed Inspector
  const nodeType = activeNode.type
  const isLocked = Boolean(activeNode.locked)
  const isHidden = Boolean(activeNode.hidden)

  const nodeIcon =
    nodeType === 'frame' ? <Frame size={13} /> :
    nodeType === 'shape' ? (activeNode.data.kind === 'ellipse' ? <Circle size={13} /> : <Square size={13} />) :
    nodeType === 'text' ? <Type size={13} /> :
    nodeType === 'image' ? <ImageIcon size={13} /> :
    nodeType === 'video' ? <Film size={13} /> :
    nodeType === 'group' ? <Folder size={13} /> :
    <PenTool size={13} />

  const nodeTypeLabel =
    nodeType === 'frame' ? '画框' :
    nodeType === 'shape' ? '图形' :
    nodeType === 'text' ? '文本' :
    nodeType === 'image' ? '图片' :
    nodeType === 'video' ? '视频' :
    nodeType === 'group' ? '编组' :
    '路径'

  return (
    <aside className="inspector-panel" data-testid="inspector-panel">
      {onStartResize && (
        <div
          aria-label="调整属性面板宽度"
          aria-orientation="vertical"
          className="inspector-panel__resize-handle"
          onMouseDown={onStartResize}
          role="separator"
        />
      )}
      {renderTopBar()}
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-header__title-group">
          <span className="inspector-header__icon" title={nodeTypeLabel}>{nodeIcon}</span>
          <input
            aria-label="节点名称"
            className="inspector-header__name-input"
            disabled={readOnly || isLocked}
            onBlur={() => {
              if (nodeNameDraft && nodeNameDraft.id === activeNode.id) {
                const trimmed = nodeNameDraft.name.trim()
                if (trimmed && trimmed !== activeNode.name) {
                  store.getState().renameNode(activeNode.id, trimmed)
                }
                setNodeNameDraft(null)
              }
            }}
            onChange={handleNameChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            value={(nodeNameDraft && nodeNameDraft.id === activeNode.id) ? nodeNameDraft.name : activeNode.name}
          />
        </div>
        <div className="inspector-header__actions">
          <button
            aria-label={isHidden ? '显示节点' : '隐藏节点'}
            className={`inspector-icon-btn ${isHidden ? 'inspector-icon-btn--active' : ''}`}
            disabled={readOnly}
            onClick={() => store.getState().toggleNodeFlag(activeNode.id, 'hidden')}
            title={isHidden ? '显示' : '隐藏'}
            type="button"
          >
            {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            aria-label={isLocked ? '解锁节点' : '锁定节点'}
            className={`inspector-icon-btn ${isLocked ? 'inspector-icon-btn--active' : ''}`}
            disabled={readOnly}
            onClick={() => store.getState().toggleNodeFlag(activeNode.id, 'locked')}
            title={isLocked ? '解锁' : '锁定'}
            type="button"
          >
            {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button
            aria-label="删除节点"
            className="inspector-icon-btn inspector-icon-btn--danger"
            disabled={readOnly || isLocked}
            onClick={() => store.getState().deleteNodes([activeNode.id], { force: true })}
            title="删除"
            type="button"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="inspector-body">
        {/* Transform Section: X, Y, W, H, Rotation */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span className="inspector-section__title">
              <span className="inspector-section__icon"><Move size={13} /></span>
              <span>变换 (Transform)</span>
            </span>
            <button
              aria-label={aspectRatioLocked ? '解锁宽高比' : '锁定宽高比'}
              className={`inspector-icon-btn ${aspectRatioLocked ? 'inspector-icon-btn--active' : ''}`}
              onClick={() => setAspectRatioLocked(!aspectRatioLocked)}
              title={aspectRatioLocked ? '已锁定比例' : '锁定宽高比'}
              type="button"
            >
              {aspectRatioLocked ? <Link2 size={12} /> : <Unlink2 size={12} />}
            </button>
          </div>
          <div className="inspector-row">
            <div className="inspector-field">
              <ScrubbableLabel
                label="X"
                onChange={(val) => handlePosChange('x', val, false)}
                onChangeEnd={(val) => handlePosChange('x', val, true)}
                value={Math.round(activeNode.position.x)}
              />
              <input
                aria-label="X 坐标"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onBlur={(e) => handlePosChange('x', Number(e.target.value), true)}
                onChange={(e) => handlePosChange('x', Number(e.target.value), false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                type="number"
                value={Math.round(activeNode.position.x)}
              />
            </div>
            <div className="inspector-field">
              <ScrubbableLabel
                label="Y"
                onChange={(val) => handlePosChange('y', val, false)}
                onChangeEnd={(val) => handlePosChange('y', val, true)}
                value={Math.round(activeNode.position.y)}
              />
              <input
                aria-label="Y 坐标"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onBlur={(e) => handlePosChange('y', Number(e.target.value), true)}
                onChange={(e) => handlePosChange('y', Number(e.target.value), false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                type="number"
                value={Math.round(activeNode.position.y)}
              />
            </div>
          </div>
          <div className="inspector-row">
            <div className="inspector-field">
              <ScrubbableLabel
                label="W"
                min={1}
                onChange={(val) => handleSizeChange('width', val, false)}
                onChangeEnd={(val) => handleSizeChange('width', val, true)}
                value={Math.round(activeNode.size.width)}
              />
              <input
                aria-label="宽度"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onBlur={(e) => handleSizeChange('width', Number(e.target.value), true)}
                onChange={(e) => handleSizeChange('width', Number(e.target.value), false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                type="number"
                value={Math.round(activeNode.size.width)}
              />
            </div>
            <div className="inspector-field">
              <ScrubbableLabel
                label="H"
                min={1}
                onChange={(val) => handleSizeChange('height', val, false)}
                onChangeEnd={(val) => handleSizeChange('height', val, true)}
                value={Math.round(activeNode.size.height)}
              />
              <input
                aria-label="高度"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onBlur={(e) => handleSizeChange('height', Number(e.target.value), true)}
                onChange={(e) => handleSizeChange('height', Number(e.target.value), false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                type="number"
                value={Math.round(activeNode.size.height)}
              />
            </div>
          </div>

          {/* Rotation & Radius */}
          <div className="inspector-row">
            {'rotation' in activeNode.data ? (
              <div className="inspector-field">
                <span className="inspector-field__prefix-icon"><RotateCw size={11} /></span>
                <ScrubbableLabel
                  label="旋转°"
                  onChange={(val) => updateActiveData({ rotation: val }, false)}
                  onChangeEnd={(val) => updateActiveData({ rotation: val }, true)}
                  value={Math.round((activeNode.data as { rotation?: number }).rotation ?? 0)}
                />
                <input
                  aria-label="旋转角度"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  onBlur={(e) => updateActiveData({ rotation: Number(e.target.value) || 0 }, true)}
                  onChange={(e) => updateActiveData({ rotation: Number(e.target.value) || 0 }, false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  type="number"
                  value={Math.round((activeNode.data as { rotation?: number }).rotation ?? 0)}
                />
              </div>
            ) : null}
            {'radius' in activeNode.data || nodeType === 'image' || nodeType === 'video' ? (
              <div className="inspector-field">
                <span className="inspector-field__prefix-icon"><CornerUpRight size={11} /></span>
                <ScrubbableLabel
                  label="圆角"
                  min={0}
                  onChange={(val) => updateActiveData({ radius: Math.max(0, val) }, false)}
                  onChangeEnd={(val) => updateActiveData({ radius: Math.max(0, val) }, true)}
                  value={Math.round((activeNode.data as { radius?: number }).radius ?? 0)}
                />
                <input
                  aria-label="圆角大小"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  min={0}
                  onBlur={(e) => updateActiveData({ radius: Math.max(0, Number(e.target.value) || 0) }, true)}
                  onChange={(e) => updateActiveData({ radius: Math.max(0, Number(e.target.value) || 0) }, false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  type="number"
                  value={Math.round((activeNode.data as { radius?: number }).radius ?? 0)}
                />
              </div>
            ) : null}
          </div>

          {/* Frame Preset Dropdown */}
          {nodeType === 'frame' ? (
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <select
                aria-label="画框预设尺寸"
                className="inspector-select"
                disabled={readOnly || isLocked}
                onChange={(e) => {
                  const preset = FRAME_PRESETS.find((p) => p.label === e.target.value)
                  if (preset && preset.width > 0) {
                    patchActive({ size: { width: preset.width, height: preset.height } })
                  }
                }}
                value={
                  FRAME_PRESETS.find(
                    (p) => p.width === activeNode.size.width && p.height === activeNode.size.height,
                  )?.label ?? '自定义尺寸'
                }
              >
                {FRAME_PRESETS.map((preset) => (
                  <option key={preset.label} value={preset.label}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        {/* Opacity Section */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span className="inspector-section__title">
              <span className="inspector-section__icon"><Percent size={13} /></span>
              <span>透明度 (Opacity)</span>
            </span>
          </div>
          <div className="inspector-row">
            <div className="inspector-field">
              <ScrubbableLabel
                label="不透明度"
                max={100}
                min={0}
                onChange={(val) => updateActiveData({ opacity: Math.min(1, Math.max(0, val / 100)) }, false)}
                onChangeEnd={(val) => updateActiveData({ opacity: Math.min(1, Math.max(0, val / 100)) }, true)}
                value={Math.round(((activeNode.data as { opacity?: number }).opacity ?? 1) * 100)}
              />
              <input
                aria-label="透明度百分比"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                max={100}
                min={0}
                onBlur={(e) =>
                  updateActiveData({
                    opacity: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                  }, true)
                }
                onChange={(e) =>
                  updateActiveData({
                    opacity: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                  }, false)
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                type="number"
                value={Math.round(((activeNode.data as { opacity?: number }).opacity ?? 1) * 100)}
              />
              <span style={{ color: '#737373', fontSize: '10px' }}>%</span>
            </div>
          </div>
        </div>

        {/* Media Mode Toggle Section (For Image & Video) */}
        {nodeType === 'image' || nodeType === 'video' ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>节点模式 (Display Mode)</span>
            </div>
            <div className="inspector-seg-group">
              <button
                className={`inspector-seg-btn ${(activeNode.data as ImageNodeData | VideoNodeData).displayMode !== 'layer' ? 'inspector-seg-btn--active' : ''}`}
                disabled={readOnly || isLocked}
                onClick={() => updateActiveData({ displayMode: 'generation' })}
                type="button"
              >
                <Sparkles size={11} style={{ marginRight: '4px' }} /> AI 生成卡片
              </button>
              <button
                className={`inspector-seg-btn ${(activeNode.data as ImageNodeData | VideoNodeData).displayMode === 'layer' ? 'inspector-seg-btn--active' : ''}`}
                disabled={readOnly || isLocked}
                onClick={() => updateActiveData({ displayMode: 'layer' })}
                type="button"
              >
                <Maximize2 size={11} style={{ marginRight: '4px' }} /> 自由编辑图层
              </button>
            </div>
          </div>
        ) : null}

        {/* Path Specific Section */}
        {nodeType === 'path' ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span className="inspector-section__title">
                <span className="inspector-section__icon"><PenTool size={13} /></span>
                <span>路径 (Path)</span>
              </span>
            </div>
            <div className="inspector-row">
              <button
                aria-label={isEditingVector ? '完成矢量编辑' : '编辑路径'}
                className={`inspector-toggle-btn ${isEditingVector ? 'inspector-toggle-btn--active' : ''}`}
                disabled={readOnly || isLocked}
                onClick={() => onStartVectorEdit?.(activeNode.id)}
                style={{ flex: 1 }}
                type="button"
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <PenTool size={13} /> {isEditingVector ? '完成矢量编辑 (Done)' : '编辑路径 (Vector Edit)'}
                </span>
              </button>
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '2px 0',
                }}
              >
                <span style={{ fontSize: '11px', color: '#dedede' }}>路径闭合 (Closed)</span>
                <label className="inspector-effect-switch">
                  <input
                    aria-label="路径闭合开关"
                    checked={Boolean((activeNode.data as { closed?: boolean }).closed)}
                    disabled={readOnly || isLocked}
                    onChange={(e) => updateActiveData({ closed: e.target.checked })}
                    type="checkbox"
                  />
                  <span className="inspector-effect-switch__slider" />
                </label>
              </div>
            </div>
          </div>
        ) : null}

        {/* Typography Section (Text Node Only) */}
        {nodeType === 'text' ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>文本排版 (Typography)</span>
            </div>
            {/* Font Size & Weight */}
            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableLabel
                  label="字号"
                  max={256}
                  min={8}
                  onChange={(val) => updateActiveData({ fontSize: val })}
                  value={(activeNode as TextNode).data.fontSize ?? 14}
                />
                <input
                  aria-label="字体大小"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  min={8}
                  onChange={(e) => updateActiveData({ fontSize: Number(e.target.value) || 14 })}
                  type="number"
                  value={(activeNode as TextNode).data.fontSize ?? 14}
                />
              </div>
              <div className="inspector-field">
                <span className="inspector-field__label">字重</span>
                <select
                  aria-label="字重"
                  className="inspector-select"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveData({ fontWeight: Number(e.target.value) })}
                  style={{ border: 'none', background: 'transparent', height: '100%', padding: 0 }}
                  value={(activeNode as TextNode).data.fontWeight ?? 400}
                >
                  <option value={400}>常规 (400)</option>
                  <option value={500}>中等 (500)</option>
                  <option value={600}>半粗 (600)</option>
                  <option value={700}>粗体 (700)</option>
                </select>
              </div>
            </div>

            {/* Line Height & Letter Spacing */}
            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableLabel
                  label="行高"
                  max={4}
                  min={0.8}
                  onChange={(val) => updateActiveData({ lineHeight: val })}
                  step={0.1}
                  value={Number(((activeNode as TextNode).data.lineHeight ?? 1.5).toFixed(1))}
                />
                <input
                  aria-label="行高比例"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  max={4}
                  min={0.8}
                  onChange={(e) => updateActiveData({ lineHeight: Number(e.target.value) || 1.5 })}
                  step={0.1}
                  type="number"
                  value={Number(((activeNode as TextNode).data.lineHeight ?? 1.5).toFixed(1))}
                />
              </div>
              <div className="inspector-field">
                <ScrubbableLabel
                  label="间距"
                  max={50}
                  min={-10}
                  onChange={(val) => updateActiveData({ letterSpacing: val })}
                  value={Math.round((activeNode as TextNode).data.letterSpacing ?? 0)}
                />
                <input
                  aria-label="字间距"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  max={50}
                  min={-10}
                  onChange={(e) => updateActiveData({ letterSpacing: Number(e.target.value) || 0 })}
                  type="number"
                  value={Math.round((activeNode as TextNode).data.letterSpacing ?? 0)}
                />
                <span style={{ color: '#737373', fontSize: '10px' }}>px</span>
              </div>
            </div>

            {/* Text Alignment */}
            <div className="inspector-row">
              <div className="inspector-seg-group">
                <button
                  aria-label="左对齐"
                  className={`inspector-seg-btn ${(activeNode as TextNode).data.textAlign !== 'center' && (activeNode as TextNode).data.textAlign !== 'right' ? 'inspector-seg-btn--active' : ''}`}
                  disabled={readOnly || isLocked}
                  onClick={() => updateActiveData({ textAlign: 'left' })}
                  type="button"
                >
                  <AlignLeft size={13} />
                </button>
                <button
                  aria-label="居中对齐"
                  className={`inspector-seg-btn ${(activeNode as TextNode).data.textAlign === 'center' ? 'inspector-seg-btn--active' : ''}`}
                  disabled={readOnly || isLocked}
                  onClick={() => updateActiveData({ textAlign: 'center' })}
                  type="button"
                >
                  <AlignCenter size={13} />
                </button>
                <button
                  aria-label="右对齐"
                  className={`inspector-seg-btn ${(activeNode as TextNode).data.textAlign === 'right' ? 'inspector-seg-btn--active' : ''}`}
                  disabled={readOnly || isLocked}
                  onClick={() => updateActiveData({ textAlign: 'right' })}
                  type="button"
                >
                  <AlignRight size={13} />
                </button>
              </div>
            </div>

            {/* Text Color */}
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-color-row" style={{ width: '100%' }}>
                <div
                  className="inspector-color-chip"
                  style={{ background: (activeNode as TextNode).data.color || '#e0e0e0' }}
                >
                  <input
                    className="inspector-color-input-native"
                    disabled={readOnly || isLocked}
                    onChange={(e) => updateActiveDataThrottled({ color: e.target.value })}
                    type="color"
                    value={(activeNode as TextNode).data.color || '#e0e0e0'}
                  />
                </div>
                <span className="inspector-field__label">颜色</span>
                <input
                  aria-label="文本颜色十六进制值"
                  className="inspector-color-hex"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveDataThrottled({ color: e.target.value })}
                  value={(activeNode as TextNode).data.color || '#e0e0e0'}
                />
              </div>
            </div>
          </div>
        ) : null}

        {/* Fill Section (For Frame, Shape, Path) */}
        {'fill' in activeNode.data ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span className="inspector-section__title">
                <span className="inspector-section__icon"><Palette size={13} /></span>
                <span>填充 (Fill)</span>
              </span>
            </div>
            <div className="inspector-color-row">
              <div
                className="inspector-color-chip"
                style={{ background: (activeNode.data as { fill: string }).fill }}
              >
                <input
                  aria-label="填充颜色选择器"
                  className="inspector-color-input-native"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveDataThrottled({ fill: e.target.value })}
                  type="color"
                  value={
                    (activeNode.data as { fill: string }).fill.startsWith('#')
                      ? (activeNode.data as { fill: string }).fill
                      : '#202020'
                  }
                />
              </div>
              <input
                aria-label="填充颜色十六进制"
                className="inspector-color-hex"
                disabled={readOnly || isLocked}
                onChange={(e) => updateActiveDataThrottled({ fill: e.target.value })}
                value={(activeNode.data as { fill: string }).fill}
              />
            </div>
          </div>
        ) : null}

        {/* Stroke Section (For Frame, Shape, Path, Media, Text) */}
        {'stroke' in activeNode.data || nodeType === 'image' || nodeType === 'video' || nodeType === 'text' ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span className="inspector-section__title">
                <span className="inspector-section__icon"><Square size={13} /></span>
                <span>描边 (Stroke)</span>
              </span>
            </div>
            <div className="inspector-color-row">
              <div
                className="inspector-color-chip"
                style={{ background: (activeNode.data as { stroke?: string }).stroke || '#777777' }}
              >
                <input
                  aria-label="描边颜色选择器"
                  className="inspector-color-input-native"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveDataThrottled({ stroke: e.target.value })}
                  type="color"
                  value={
                    (activeNode.data as { stroke?: string }).stroke?.startsWith('#')
                      ? (activeNode.data as { stroke?: string }).stroke
                      : '#777777'
                  }
                />
              </div>
              <input
                aria-label="描边颜色十六进制"
                className="inspector-color-hex"
                disabled={readOnly || isLocked}
                onChange={(e) => updateActiveDataThrottled({ stroke: e.target.value })}
                value={(activeNode.data as { stroke?: string }).stroke ?? '#777777'}
              />
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field">
                <ScrubbableLabel
                  label="线宽"
                  max={64}
                  min={0}
                  onChange={(val) => updateActiveData({ strokeWidth: Math.max(0, val) }, false)}
                  onChangeEnd={(val) => updateActiveData({ strokeWidth: Math.max(0, val) }, true)}
                  value={(activeNode.data as { strokeWidth?: number }).strokeWidth ?? 1}
                />
                <input
                  aria-label="描边线宽"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  min={0}
                  onBlur={(e) => updateActiveData({ strokeWidth: Math.max(0, Number(e.target.value) || 0) }, true)}
                  onChange={(e) => updateActiveData({ strokeWidth: Math.max(0, Number(e.target.value) || 0) }, false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  type="number"
                  value={(activeNode.data as { strokeWidth?: number }).strokeWidth ?? 1}
                />
              </div>
              <div className="inspector-seg-group" style={{ flex: 1 }}>
                <button
                  aria-label="实线描边"
                  className={`inspector-seg-btn ${(activeNode.data as { strokeStyle?: string }).strokeStyle !== 'dashed' ? 'inspector-seg-btn--active' : ''}`}
                  disabled={readOnly || isLocked}
                  onClick={() => updateActiveData({ strokeStyle: 'solid' })}
                  type="button"
                >
                  <Minus size={11} style={{ marginRight: '4px' }} /> 实线
                </button>
                <button
                  aria-label="虚线描边"
                  className={`inspector-seg-btn ${(activeNode.data as { strokeStyle?: string }).strokeStyle === 'dashed' ? 'inspector-seg-btn--active' : ''}`}
                  disabled={readOnly || isLocked}
                  onClick={() => updateActiveData({ strokeStyle: 'dashed' })}
                  type="button"
                >
                  <MoreHorizontal size={11} style={{ marginRight: '4px' }} /> 虚线
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Effects Section (For Frame, Shape, Path, Media, Text) */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span className="inspector-section__title">
              <span className="inspector-section__icon"><Sparkles size={13} /></span>
              <span>效果 (Effects)</span>
            </span>
          </div>

          {/* Layer Blur Card */}
          {(() => {
            const blurVal = (activeNode.data as { blur?: number }).blur ?? 0
            const blurActive = blurVal > 0
            return (
              <div className={`inspector-effect-card ${blurActive ? 'inspector-effect-card--active' : ''}`}>
                <div className="inspector-effect-card__header">
                  <span className="inspector-effect-card__title">
                    <Droplets size={12} />
                    <span>高斯模糊 (Blur)</span>
                  </span>
                  <label className="inspector-effect-switch">
                    <input
                      aria-label="高斯模糊开关"
                      checked={blurActive}
                      disabled={readOnly || isLocked}
                      onChange={(e) => updateActiveData({ blur: e.target.checked ? 8 : 0 })}
                      type="checkbox"
                    />
                    <span className="inspector-effect-switch__slider" />
                  </label>
                </div>
                {blurActive && (
                  <div className="inspector-effect-card__body">
                    <div className="inspector-row" style={{ margin: 0 }}>
                      <div className="inspector-field">
                        <ScrubbableLabel
                          label="模糊半径"
                          max={100}
                          min={0}
                          onChange={(val) => updateActiveData({ blur: Math.max(0, val) }, false)}
                          onChangeEnd={(val) => updateActiveData({ blur: Math.max(0, val) }, true)}
                          value={blurVal}
                        />
                        <input
                          aria-label="模糊半径数值"
                          className="inspector-field__input"
                          disabled={readOnly || isLocked}
                          max={100}
                          min={0}
                          onBlur={(e) => updateActiveData({ blur: Math.max(0, Number(e.target.value) || 0) }, true)}
                          onChange={(e) => updateActiveData({ blur: Math.max(0, Number(e.target.value) || 0) }, false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          }}
                          type="number"
                          value={blurVal}
                        />
                        <span style={{ color: '#737373', fontSize: '10px' }}>px</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Drop Shadow Card */}
          {(() => {
            const shadowObj = (activeNode.data as { shadow?: CanvasNodeEffectShadow }).shadow
            const shadowActive = Boolean(shadowObj)
            const shadowColor = shadowObj?.color ?? 'rgba(0,0,0,0.45)'
            return (
              <div className={`inspector-effect-card ${shadowActive ? 'inspector-effect-card--active' : ''}`}>
                <div className="inspector-effect-card__header">
                  <span className="inspector-effect-card__title">
                    <BoxSelect size={12} />
                    <span>外投影 (Drop Shadow)</span>
                  </span>
                  <label className="inspector-effect-switch">
                    <input
                      aria-label="外投影开关"
                      checked={shadowActive}
                      disabled={readOnly || isLocked}
                      onChange={(e) =>
                        updateActiveData({
                          shadow: e.target.checked
                            ? { x: 0, y: 4, blur: 12, color: 'rgba(0,0,0,0.45)' }
                            : undefined,
                        })
                      }
                      type="checkbox"
                    />
                    <span className="inspector-effect-switch__slider" />
                  </label>
                </div>
                {shadowActive && (
                  <div className="inspector-effect-card__body">
                    <div className="inspector-row">
                      <div className="inspector-field">
                        <ScrubbableLabel
                          label="X 偏移"
                          max={100}
                          min={-100}
                          onChange={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, x: val },
                            }, false)
                          }
                          onChangeEnd={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, x: val },
                            }, true)
                          }
                          value={shadowObj?.x ?? 0}
                        />
                        <input
                          aria-label="阴影 X 偏移"
                          className="inspector-field__input"
                          disabled={readOnly || isLocked}
                          max={100}
                          min={-100}
                          onBlur={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, x: Number(e.target.value) || 0 },
                            }, true)
                          }
                          onChange={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, x: Number(e.target.value) || 0 },
                            }, false)
                          }
                          type="number"
                          value={shadowObj?.x ?? 0}
                        />
                      </div>
                      <div className="inspector-field">
                        <ScrubbableLabel
                          label="Y 偏移"
                          max={100}
                          min={-100}
                          onChange={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, y: val },
                            }, false)
                          }
                          onChangeEnd={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, y: val },
                            }, true)
                          }
                          value={shadowObj?.y ?? 4}
                        />
                        <input
                          aria-label="阴影 Y 偏移"
                          className="inspector-field__input"
                          disabled={readOnly || isLocked}
                          max={100}
                          min={-100}
                          onBlur={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, y: Number(e.target.value) || 0 },
                            }, true)
                          }
                          onChange={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, y: Number(e.target.value) || 0 },
                            }, false)
                          }
                          type="number"
                          value={shadowObj?.y ?? 4}
                        />
                      </div>
                    </div>
                    <div className="inspector-row" style={{ margin: 0 }}>
                      <div className="inspector-field">
                        <ScrubbableLabel
                          label="模糊度"
                          max={100}
                          min={0}
                          onChange={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, blur: Math.max(0, val) },
                            }, false)
                          }
                          onChangeEnd={(val) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, blur: Math.max(0, val) },
                            }, true)
                          }
                          value={shadowObj?.blur ?? 12}
                        />
                        <input
                          aria-label="阴影模糊半径"
                          className="inspector-field__input"
                          disabled={readOnly || isLocked}
                          max={100}
                          min={0}
                          onBlur={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, blur: Math.max(0, Number(e.target.value) || 0) },
                            }, true)
                          }
                          onChange={(e) =>
                            updateActiveData({
                              shadow: { ...shadowObj!, blur: Math.max(0, Number(e.target.value) || 0) },
                            }, false)
                          }
                          type="number"
                          value={shadowObj?.blur ?? 12}
                        />
                        <span style={{ color: '#737373', fontSize: '10px' }}>px</span>
                      </div>
                    </div>
                    <div className="inspector-color-row" style={{ marginTop: '4px' }}>
                      <div
                        className="inspector-color-chip"
                        style={{ background: shadowColor }}
                      >
                        <input
                          aria-label="阴影颜色选择器"
                          className="inspector-color-input-native"
                          disabled={readOnly || isLocked}
                          onChange={(e) =>
                            updateActiveDataThrottled({
                              shadow: { ...shadowObj!, color: e.target.value },
                            })
                          }
                          type="color"
                          value={shadowColor.startsWith('#') ? shadowColor : '#000000'}
                        />
                      </div>
                      <input
                        aria-label="阴影颜色值"
                        className="inspector-color-hex"
                        disabled={readOnly || isLocked}
                        onChange={(e) =>
                          updateActiveDataThrottled({
                            shadow: { ...shadowObj!, color: e.target.value },
                          })
                        }
                        value={shadowColor}
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>

        {/* Layer Order Section */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span className="inspector-section__title">
              <span className="inspector-section__icon"><Layers size={13} /></span>
              <span>图层层级 (Layer Order)</span>
            </span>
          </div>
          <div className="inspector-row">
            <button
              aria-label="置于顶层"
              className="inspector-toggle-btn"
              disabled={readOnly || isLocked}
              onClick={() => store.getState().moveNodeLayer(activeNode.id, 'front')}
              style={{ flex: 1 }}
              type="button"
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <BringToFront size={13} /> 上移置顶
              </span>
            </button>
            <button
              aria-label="置于底层"
              className="inspector-toggle-btn"
              disabled={readOnly || isLocked}
              onClick={() => store.getState().moveNodeLayer(activeNode.id, 'back')}
              style={{ flex: 1 }}
              type="button"
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <SendToBack size={13} /> 下移置底
              </span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
