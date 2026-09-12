import { useState, useCallback, useRef, useEffect, type ChangeEvent } from 'react'
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
  Plus,
} from 'lucide-react'

import type { CanvasStore, CanvasStoreState } from '../../store/canvas-store'
import type {
  CanvasNode,
  TextNode,
  ImageNodeData,
  VideoNodeData,
  CanvasNodeEffectShadow,
  CanvasFillItem,
  CanvasStrokeItem,
  CanvasStrokePosition,
  CanvasEffectItem,
  CanvasEffectType,
} from '../../model/project'
import {
  getResolvedFills,
  getResolvedStrokes,
  getResolvedEffects,
} from '../canvas/effectStyleUtils'
import { EffectSettingsPopover } from './EffectSettingsPopover'
import { ScrubbableLabel } from './ScrubbableLabel'
import './inspector.css'

export interface FigmaEffectOption {
  type: CanvasEffectType
  title: string
  subtitle: string
  group: 'shadow' | 'blur' | 'styling'
}

export const FIGMA_EFFECT_GROUPS = [
  { id: 'shadow', name: '光影效果' },
  { id: 'blur', name: '模糊滤镜' },
  { id: 'styling', name: '质感与着色器' },
] as const

export const FIGMA_EFFECT_OPTIONS: FigmaEffectOption[] = [
  // 光影效果
  {
    type: 'drop-shadow',
    title: '投影',
    subtitle: 'Drop Shadow',
    group: 'shadow',
  },
  {
    type: 'inner-shadow',
    title: '内阴影',
    subtitle: 'Inner Shadow',
    group: 'shadow',
  },
  // 模糊滤镜
  {
    type: 'layer-blur',
    title: '图层模糊',
    subtitle: 'Layer Blur',
    group: 'blur',
  },
  {
    type: 'background-blur',
    title: '背景模糊',
    subtitle: 'Background Blur',
    group: 'blur',
  },
  // 质感与着色器
  {
    type: 'noise',
    title: '噪点颗粒',
    subtitle: 'Noise',
    group: 'styling',
  },
  {
    type: 'texture',
    title: '材质纹理',
    subtitle: 'Texture',
    group: 'styling',
  },
  {
    type: 'glass',
    title: '拟态玻璃',
    subtitle: 'Glass',
    group: 'styling',
  },
  {
    type: 'shader',
    title: '动态着色器',
    subtitle: 'Shader',
    group: 'styling',
  },
]

function renderEffectIcon(type: CanvasEffectType) {
  switch (type) {
    case 'drop-shadow':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5.5 13.5H12C12.8 13.5 13.5 12.8 13.5 12V5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.4" />
        </svg>
      )
    case 'inner-shadow':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 5H10.5M5 5V10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.5" />
        </svg>
      )
    case 'layer-blur':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
          <circle cx="8" cy="8" r="2.5" fill="currentColor" />
        </svg>
      )
    case 'background-blur':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 3L13 13M1 7L9 15M7 1L15 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.35" />
          <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'noise':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="5.5" cy="5.5" r="0.75" />
          <circle cx="9" cy="5.5" r="0.75" />
          <circle cx="6" cy="9" r="0.75" />
          <circle cx="10.5" cy="8.5" r="0.75" />
          <circle cx="8" cy="11.5" r="0.75" />
        </svg>
      )
    case 'texture':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 6H13M3 10H13M6 3V13M10 3V13" stroke="currentColor" strokeWidth="0.9" strokeOpacity="0.45" />
        </svg>
      )
    case 'glass':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <line x1="4.5" y1="11.5" x2="11.5" y2="4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="7.5" y1="12.5" x2="12.5" y2="7.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeOpacity="0.4" />
        </svg>
      )
    case 'shader':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 5.5C4.5 3.5 6.5 7.5 9 5.5C11.5 3.5 13 6.5 13.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M2.5 10.5C4.5 8.5 6.5 12.5 9 10.5C11.5 8.5 13 11.5 13.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.45" />
        </svg>
      )
  }
}


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
  const [effectsMenuOpen, setEffectsMenuOpen] = useState(false)
  const [activeEffectPopoverId, setActiveEffectPopoverId] = useState<string | null>(null)
  const [popoverAnchorY, setPopoverAnchorY] = useState(120)
  const pendingColorFrame = useRef<number | null>(null)

  useEffect(() => {
    setActiveEffectPopoverId(null)
    setEffectsMenuOpen(false)
  }, [selectedNodeIds])


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

  const syncEffects = useCallback(
    (nextEffects: CanvasEffectItem[], commit = true) => {
      if (!activeNode || readOnly) return
      const enabled = nextEffects.filter((e) => e.enabled)
      const legacyDropShadow = enabled.find((e) => e.type === 'drop-shadow')
      const legacyBlur = enabled.find((e) => e.type === 'layer-blur')
      updateActiveData(
        {
          effects: nextEffects,
          shadow: legacyDropShadow
            ? {
                x: legacyDropShadow.x ?? 0,
                y: legacyDropShadow.y ?? 4,
                blur: legacyDropShadow.blur ?? 12,
                color: legacyDropShadow.color ?? 'rgba(0,0,0,0.45)',
              }
            : undefined,
          blur: legacyBlur ? (legacyBlur.blur ?? 0) : 0,
        },
        commit,
      )
    },
    [activeNode, readOnly, updateActiveData],
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
              onClick={() => store.getState().deleteNodes(selectedNodeIds)}
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
            onClick={() => store.getState().deleteNodes([activeNode.id])}
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
        {'fill' in activeNode.data || (activeNode.data as { fills?: CanvasFillItem[] }).fills ? (() => {
          const currentFills = getResolvedFills(activeNode.data as { fill?: string; fills?: CanvasFillItem[] })
          return (
            <div className="inspector-section">
              <div className="inspector-section__header">
                <span className="inspector-section__title">
                  <span className="inspector-section__icon"><Palette size={13} /></span>
                  <span>填充 (Fill)</span>
                </span>
                <div className="inspector-section__header-actions">
                  <button
                    aria-label="添加填充图层"
                    className="inspector-section__action-btn"
                    disabled={readOnly || isLocked}
                    onClick={() => {
                      const newFill: CanvasFillItem = {
                        id: `fill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        color: '#ffffff',
                        opacity: 1,
                        enabled: true,
                      }
                      const nextFills = [...currentFills, newFill]
                      const firstActive = nextFills.find((f) => f.enabled)
                      updateActiveData({
                        fills: nextFills,
                        fill: firstActive ? firstActive.color : 'transparent',
                      })
                    }}
                    title="添加填充图层"
                    type="button"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>

              {currentFills.map((fillItem, idx) => {
                const isPrimary = idx === 0
                return (
                  <div
                    key={fillItem.id}
                    className={`inspector-layer-row ${!fillItem.enabled ? 'inspector-layer-row--disabled' : ''}`}
                  >
                    <div className="inspector-layer-row__main">
                      <div
                        className="inspector-color-chip"
                        style={{ background: fillItem.enabled ? fillItem.color : '#444' }}
                      >
                        <input
                          aria-label={isPrimary ? '填充颜色选择器' : `填充颜色选择器 ${idx + 1}`}
                          className="inspector-color-input-native"
                          disabled={readOnly || isLocked}
                          onChange={(e) => {
                            const nextFills = currentFills.map((f) =>
                              f.id === fillItem.id ? { ...f, color: e.target.value } : f
                            )
                            const firstActive = nextFills.find((f) => f.enabled)
                            updateActiveDataThrottled({
                              fills: nextFills,
                              fill: firstActive ? firstActive.color : 'transparent',
                            })
                          }}
                          type="color"
                          value={fillItem.color.startsWith('#') ? fillItem.color : '#202020'}
                        />
                      </div>
                      <input
                        aria-label={isPrimary ? '填充颜色十六进制' : `填充颜色十六进制 ${idx + 1}`}
                        className="inspector-color-hex"
                        disabled={readOnly || isLocked}
                        onChange={(e) => {
                          const nextFills = currentFills.map((f) =>
                            f.id === fillItem.id ? { ...f, color: e.target.value } : f
                          )
                          const firstActive = nextFills.find((f) => f.enabled)
                          updateActiveDataThrottled({
                            fills: nextFills,
                            fill: firstActive ? firstActive.color : 'transparent',
                          })
                        }}
                        value={fillItem.color}
                      />
                      <input
                        aria-label={`填充透明度 ${idx + 1}`}
                        className="inspector-field__input"
                        disabled={readOnly || isLocked}
                        max={100}
                        min={0}
                        onChange={(e) => {
                          const op = Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100
                          const nextFills = currentFills.map((f) =>
                            f.id === fillItem.id ? { ...f, opacity: op } : f
                          )
                          updateActiveData({ fills: nextFills }, true)
                        }}
                        style={{ width: '38px', textAlign: 'right' }}
                        type="number"
                        value={Math.round((fillItem.opacity ?? 1) * 100)}
                      />
                      <span style={{ color: '#737373', fontSize: '10px' }}>%</span>
                    </div>
                    <div className="inspector-layer-row__actions">
                      <button
                        aria-label={fillItem.enabled ? '关闭填充' : '开启填充'}
                        className="inspector-layer-action-btn"
                        disabled={readOnly || isLocked}
                        onClick={() => {
                          const nextFills = currentFills.map((f) =>
                            f.id === fillItem.id ? { ...f, enabled: !f.enabled } : f
                          )
                          const firstActive = nextFills.find((f) => f.enabled)
                          updateActiveData({
                            fills: nextFills,
                            fill: firstActive ? firstActive.color : 'transparent',
                          })
                        }}
                        title={fillItem.enabled ? '隐藏填充' : '显示填充'}
                        type="button"
                      >
                        {fillItem.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                      </button>
                      {currentFills.length > 1 && (
                        <button
                          aria-label="删除填充"
                          className="inspector-layer-action-btn"
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextFills = currentFills.filter((f) => f.id !== fillItem.id)
                            const firstActive = nextFills.find((f) => f.enabled)
                            updateActiveData({
                              fills: nextFills,
                              fill: firstActive ? firstActive.color : 'transparent',
                            })
                          }}
                          title="删除填充"
                          type="button"
                        >
                          <Minus size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })() : null}

        {/* Stroke Section (For Frame, Shape, Path, Media, Text) */}
        {'stroke' in activeNode.data || ['frame', 'shape', 'path', 'image', 'video', 'text'].includes(nodeType) || Boolean((activeNode.data as { strokes?: CanvasStrokeItem[] }).strokes) ? (() => {
          const currentStrokes = getResolvedStrokes(activeNode.data as {
            stroke?: string
            strokeWidth?: number
            strokeStyle?: 'solid' | 'dashed'
            strokePosition?: CanvasStrokePosition
            strokes?: CanvasStrokeItem[]
          })
          return (
            <div className="inspector-section">
              <div className="inspector-section__header">
                <span className="inspector-section__title">
                  <span className="inspector-section__icon"><Square size={13} /></span>
                  <span>描边 (Stroke)</span>
                </span>
                <div className="inspector-section__header-actions">
                  <button
                    aria-label="添加描边图层"
                    className="inspector-section__action-btn"
                    disabled={readOnly || isLocked}
                    onClick={() => {
                      const newStroke: CanvasStrokeItem = {
                        id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        color: '#777777',
                        width: 1,
                        style: 'solid',
                        position: 'outside',
                        opacity: 1,
                        enabled: true,
                      }
                      const nextStrokes = [...currentStrokes, newStroke]
                      const firstActive = nextStrokes.find((s) => s.enabled)
                      updateActiveData({
                        strokes: nextStrokes,
                        stroke: firstActive ? firstActive.color : undefined,
                        strokeWidth: firstActive ? firstActive.width : 0,
                        strokeStyle: firstActive?.style ?? 'solid',
                        strokePosition: firstActive?.position ?? 'outside',
                      })
                    }}
                    title="添加描边图层"
                    type="button"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>

              {currentStrokes.map((strokeItem, idx) => {
                const isPrimary = idx === 0
                return (
                  <div key={strokeItem.id} style={{ marginBottom: '8px' }}>
                    <div className={`inspector-layer-row ${!strokeItem.enabled ? 'inspector-layer-row--disabled' : ''}`}>
                      <div className="inspector-layer-row__main">
                        <div
                          className="inspector-color-chip"
                          style={{ background: strokeItem.enabled ? strokeItem.color : '#444' }}
                        >
                          <input
                            aria-label={isPrimary ? '描边颜色选择器' : `描边颜色选择器 ${idx + 1}`}
                            className="inspector-color-input-native"
                            disabled={readOnly || isLocked}
                            onChange={(e) => {
                              const nextStrokes = currentStrokes.map((s) =>
                                s.id === strokeItem.id ? { ...s, color: e.target.value } : s
                              )
                              const firstActive = nextStrokes.find((s) => s.enabled)
                              updateActiveDataThrottled({
                                strokes: nextStrokes,
                                stroke: firstActive ? firstActive.color : undefined,
                              })
                            }}
                            type="color"
                            value={strokeItem.color?.startsWith('#') ? strokeItem.color : '#777777'}
                          />
                        </div>
                        <input
                          aria-label={isPrimary ? '描边颜色十六进制' : `描边颜色十六进制 ${idx + 1}`}
                          className="inspector-color-hex"
                          disabled={readOnly || isLocked}
                          onChange={(e) => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, color: e.target.value } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveDataThrottled({
                              strokes: nextStrokes,
                              stroke: firstActive ? firstActive.color : undefined,
                            })
                          }}
                          value={strokeItem.color ?? '#777777'}
                        />
                      </div>
                      <div className="inspector-layer-row__actions">
                        <button
                          aria-label={strokeItem.enabled ? '关闭描边' : '开启描边'}
                          className="inspector-layer-action-btn"
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, enabled: !s.enabled } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              stroke: firstActive ? firstActive.color : undefined,
                              strokeWidth: firstActive ? firstActive.width : 0,
                              strokeStyle: firstActive?.style ?? 'solid',
                              strokePosition: firstActive?.position ?? 'outside',
                            })
                          }}
                          title={strokeItem.enabled ? '隐藏描边' : '显示描边'}
                          type="button"
                        >
                          {strokeItem.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                        <button
                          aria-label={isPrimary ? '删除描边' : `删除描边 ${idx + 1}`}
                          className="inspector-layer-action-btn"
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.filter((s) => s.id !== strokeItem.id)
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              stroke: firstActive ? firstActive.color : undefined,
                              strokeWidth: firstActive ? firstActive.width : 0,
                              strokeStyle: firstActive?.style ?? 'solid',
                              strokePosition: firstActive?.position ?? 'outside',
                            })
                          }}
                          title="删除描边"
                          type="button"
                        >
                          <Minus size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="inspector-row" style={{ marginTop: '4px' }}>
                      <div className="inspector-field">
                        <ScrubbableLabel
                          label="线宽"
                          max={64}
                          min={0}
                          onChange={(val) => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, width: Math.max(0, val) } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData(
                              {
                                strokes: nextStrokes,
                                strokeWidth: firstActive ? firstActive.width : 0,
                              },
                              false
                            )
                          }}
                          onChangeEnd={(val) => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, width: Math.max(0, val) } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData(
                              {
                                strokes: nextStrokes,
                                strokeWidth: firstActive ? firstActive.width : 0,
                              },
                              true
                            )
                          }}
                          value={strokeItem.width}
                        />
                        <input
                          aria-label={isPrimary ? '描边线宽' : `描边线宽 ${idx + 1}`}
                          className="inspector-field__input"
                          disabled={readOnly || isLocked}
                          min={0}
                          onBlur={(e) => {
                            const val = Math.max(0, Number(e.target.value) || 0)
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, width: val } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData(
                              {
                                strokes: nextStrokes,
                                strokeWidth: firstActive ? firstActive.width : 0,
                              },
                              true
                            )
                          }}
                          onChange={(e) => {
                            const val = Math.max(0, Number(e.target.value) || 0)
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, width: val } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData(
                              {
                                strokes: nextStrokes,
                                strokeWidth: firstActive ? firstActive.width : 0,
                              },
                              false
                            )
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          }}
                          type="number"
                          value={strokeItem.width}
                        />
                      </div>
                      <div className="inspector-seg-group" style={{ flex: 1 }}>
                        <button
                          aria-label={isPrimary ? '实线描边' : `实线描边 ${idx + 1}`}
                          className={`inspector-seg-btn ${strokeItem.style !== 'dashed' ? 'inspector-seg-btn--active' : ''}`}
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, style: 'solid' as const } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              strokeStyle: firstActive?.style ?? 'solid',
                            })
                          }}
                          type="button"
                        >
                          <Minus size={11} style={{ marginRight: '4px' }} /> 实线
                        </button>
                        <button
                          aria-label={isPrimary ? '虚线描边' : `虚线描边 ${idx + 1}`}
                          className={`inspector-seg-btn ${strokeItem.style === 'dashed' ? 'inspector-seg-btn--active' : ''}`}
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, style: 'dashed' as const } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              strokeStyle: firstActive?.style ?? 'dashed',
                            })
                          }}
                          type="button"
                        >
                          <MoreHorizontal size={11} style={{ marginRight: '4px' }} /> 虚线
                        </button>
                      </div>
                    </div>
                    <div className="inspector-row" style={{ marginTop: '6px', alignItems: 'center' }}>
                      <span className="inspector-field__label" style={{ width: '38px', fontSize: '11px', color: '#888' }}>对齐</span>
                      <div className="inspector-seg-group" style={{ flex: 1 }}>
                        <button
                          aria-label={isPrimary ? '外部描边' : `外部描边 ${idx + 1}`}
                          className={`inspector-seg-btn ${(strokeItem.position ?? 'outside') === 'outside' ? 'inspector-seg-btn--active' : ''}`}
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, position: 'outside' as const } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              strokePosition: firstActive?.position ?? 'outside',
                            })
                          }}
                          type="button"
                        >
                          外部
                        </button>
                        <button
                          aria-label={isPrimary ? '居中描边' : `居中描边 ${idx + 1}`}
                          className={`inspector-seg-btn ${strokeItem.position === 'center' ? 'inspector-seg-btn--active' : ''}`}
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, position: 'center' as const } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              strokePosition: firstActive?.position ?? 'center',
                            })
                          }}
                          type="button"
                        >
                          居中
                        </button>
                        <button
                          aria-label={isPrimary ? '内部描边' : `内部描边 ${idx + 1}`}
                          className={`inspector-seg-btn ${strokeItem.position === 'inside' ? 'inspector-seg-btn--active' : ''}`}
                          disabled={readOnly || isLocked}
                          onClick={() => {
                            const nextStrokes = currentStrokes.map((s) =>
                              s.id === strokeItem.id ? { ...s, position: 'inside' as const } : s
                            )
                            const firstActive = nextStrokes.find((s) => s.enabled)
                            updateActiveData({
                              strokes: nextStrokes,
                              strokePosition: firstActive?.position ?? 'inside',
                            })
                          }}
                          type="button"
                        >
                          内部
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })() : null}

        {/* Effects Section (For Frame, Shape, Path, Media, Text) */}
        {(() => {
          const currentEffects = getResolvedEffects(activeNode.data as {
            blur?: number
            shadow?: CanvasNodeEffectShadow
            effects?: CanvasEffectItem[]
          })

          const syncEffects = (nextEffects: CanvasEffectItem[], commit = true) => {
            const enabled = nextEffects.filter((e) => e.enabled)
            const legacyDropShadow = enabled.find((e) => e.type === 'drop-shadow')
            const legacyBlur = enabled.find((e) => e.type === 'layer-blur')
            updateActiveData(
              {
                effects: nextEffects,
                shadow: legacyDropShadow
                  ? {
                      x: legacyDropShadow.x ?? 0,
                      y: legacyDropShadow.y ?? 4,
                      blur: legacyDropShadow.blur ?? 12,
                      color: legacyDropShadow.color ?? 'rgba(0,0,0,0.45)',
                    }
                  : undefined,
                blur: legacyBlur ? (legacyBlur.blur ?? 0) : 0,
              },
              commit
            )
          }

          const handleAddEffect = (type: CanvasEffectType) => {
            const newEffect: CanvasEffectItem = {
              id: `eff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type,
              enabled: true,
              ...(type === 'inner-shadow' ? { x: 0, y: 4, blur: 8, spread: 0, color: '#000000', intensity: 40 } : {}),
              ...(type === 'drop-shadow' ? { x: 0, y: 4, blur: 12, spread: 0, color: '#000000', intensity: 45 } : {}),
              ...(type === 'layer-blur' ? { blur: 8 } : {}),
              ...(type === 'background-blur' ? { blur: 12 } : {}),
              ...(type === 'noise' ? { intensity: 30, preset: 'medium' } : {}),
              ...(type === 'texture' ? { intensity: 30, preset: 'dots', tint: '#ffffff' } : {}),
              ...(type === 'glass' ? { blur: 16, specular: 40, tint: 'rgba(255, 255, 255, 0.12)' } : {}),
              ...(type === 'shader' ? { intensity: 50, preset: 'wave' } : {}),
            }
            const next = [...currentEffects, newEffect]
            syncEffects(next, true)
            setActiveEffectPopoverId(newEffect.id)
          }

          return (
            <div className="inspector-section" style={{ position: 'relative' }}>
              <div className="inspector-section__header">
                <span className="inspector-section__title">
                  <span className="inspector-section__icon"><Sparkles size={13} /></span>
                  <span>效果 (Effects)</span>
                </span>
                <div className="inspector-section__header-actions figma-effects-dropdown-wrap">
                  <button
                    aria-label="添加效果"
                    className={`inspector-section__action-btn ${effectsMenuOpen ? 'inspector-section__action-btn--active' : ''}`}
                    disabled={readOnly || isLocked}
                    onClick={(e) => {
                      e.stopPropagation()
                      setEffectsMenuOpen(!effectsMenuOpen)
                    }}
                    title="添加效果"
                    type="button"
                  >
                    <Plus size={13} />
                  </button>
                  {effectsMenuOpen && (
                    <div className="figma-effects-menu" onClick={(e) => e.stopPropagation()}>
                      {FIGMA_EFFECT_GROUPS.map((group, groupIdx) => {
                        const items = FIGMA_EFFECT_OPTIONS.filter((o) => o.group === group.id)
                        return (
                          <div key={group.id} className="figma-effects-menu__group">
                            {groupIdx > 0 && <div className="figma-effects-menu__divider" />}
                            <div className="figma-effects-menu__group-header">{group.name}</div>
                            {items.map((opt) => (
                              <button
                                key={opt.type}
                                aria-label={`添加效果 ${opt.title}`}
                                className="figma-effects-menu__item"
                                onClick={() => {
                                  handleAddEffect(opt.type)
                                  setEffectsMenuOpen(false)
                                }}
                                type="button"
                              >
                                <span className="figma-effects-menu__item-icon">
                                  {renderEffectIcon(opt.type)}
                                </span>
                                <div className="figma-effects-menu__item-text">
                                  <span className="figma-effects-menu__item-title">{opt.title}</span>
                                  <span className="figma-effects-menu__item-sub">{opt.subtitle}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Figma-like Multi-Effects List */}
              {currentEffects.map((effectItem) => {
                const optDef = FIGMA_EFFECT_OPTIONS.find((o) => o.type === effectItem.type)
                const effectTitle = optDef ? optDef.title : effectItem.type
                const effectSubtitle = optDef ? optDef.subtitle : ''
                return (
                  <div
                    key={effectItem.id}
                    className={`inspector-effect-card ${effectItem.enabled ? 'inspector-effect-card--active' : ''}`}
                  >
                    <div className="inspector-effect-card__header">
                      <span className="inspector-effect-card__title">
                        <span className="inspector-effect-card__icon">
                          {renderEffectIcon(effectItem.type)}
                        </span>
                        <span className="inspector-effect-card__name-wrap">
                          <span className="inspector-effect-card__name">{effectTitle}</span>
                          {effectSubtitle && (
                            <span className="inspector-effect-card__sub">{effectSubtitle}</span>
                          )}
                        </span>
                      </span>
                        <div className="inspector-layer-row__actions">
                          <button
                            aria-label={`设置 ${effectTitle} 参数`}
                            className={`inspector-layer-action-btn ${activeEffectPopoverId === effectItem.id ? 'inspector-layer-action-btn--active' : ''}`}
                            disabled={readOnly || isLocked}
                            onClick={(e) => {
                              e.stopPropagation()
                              const btnRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                              const panelEl = (e.currentTarget as HTMLElement).closest('.inspector-panel')
                              const panelTop = panelEl ? panelEl.getBoundingClientRect().top : 0
                              setPopoverAnchorY(Math.max(10, Math.round(btnRect.top - panelTop - 20)))
                              setActiveEffectPopoverId((prev) =>
                                prev === effectItem.id ? null : effectItem.id,
                              )
                            }}
                            title="调节详细参数"
                            type="button"
                          >
                            <Sliders size={12} />
                          </button>
                          <button
                            aria-label={effectItem.enabled ? `关闭 ${effectTitle}` : `开启 ${effectTitle}`}
                            className="inspector-layer-action-btn"
                            disabled={readOnly || isLocked}
                            onClick={() => {
                              const next = currentEffects.map((eff) =>
                                eff.id === effectItem.id ? { ...eff, enabled: !eff.enabled } : eff
                              )
                              syncEffects(next, true)
                            }}
                            title={effectItem.enabled ? '隐藏效果' : '显示效果'}
                            type="button"
                          >
                            {effectItem.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                          </button>
                          <button
                            aria-label={`删除 ${effectTitle}`}
                            className="inspector-layer-action-btn"
                            disabled={readOnly || isLocked}
                            onClick={() => {
                              const next = currentEffects.filter((eff) => eff.id !== effectItem.id)
                              syncEffects(next, true)
                              if (activeEffectPopoverId === effectItem.id) {
                                setActiveEffectPopoverId(null)
                              }
                            }}
                            title="删除效果"
                            type="button"
                          >
                            <Minus size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>
          )
        })()}

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

      {/* Popover for Detailed Parameters Tuning, rendered directly inside .inspector-panel so it is never clipped by .inspector-body overflow-x:hidden */}
      {activeNode && activeEffectPopoverId && (() => {
        const effects = getResolvedEffects(activeNode.data as {
          blur?: number
          shadow?: CanvasNodeEffectShadow
          effects?: CanvasEffectItem[]
        })
        const activeEffect = effects.find((e) => e.id === activeEffectPopoverId)
        if (!activeEffect) return null
        return (
          <EffectSettingsPopover
            disabled={readOnly || isLocked}
            effect={activeEffect}
            onClose={() => setActiveEffectPopoverId(null)}
            onUpdate={(updated, commit = true) => {
              const next = effects.map((eff) =>
                eff.id === updated.id ? updated : eff
              )
              syncEffects(next, commit)
            }}
            readOnly={readOnly}
            topPosition={popoverAnchorY}
          />
        )
      })()}
    </aside>
  )
}
