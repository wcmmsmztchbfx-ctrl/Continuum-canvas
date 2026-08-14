import { useState, useCallback, type ChangeEvent } from 'react'
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
  PanelRightClose,
} from 'lucide-react'

import type { CanvasStore, CanvasStoreState } from '../../store/canvas-store'
import type { CanvasNode, TextNode, ImageNodeData, VideoNodeData } from '../../model/project'
import { ScrubbableLabel } from './ScrubbableLabel'
import './inspector.css'

interface InspectorPanelProps {
  store: CanvasStore
  readOnly?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
  onOpenSettings?: () => void
}

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
  onToggleCollapse,
  onOpenSettings,
}: InspectorPanelProps) {
  const snapshot = useStore(store, (state: CanvasStoreState) => state.snapshot)
  const selectedNodeIds = useStore(store, (state: CanvasStoreState) => state.selectedNodeIds)
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false)

  const selectedNodes = snapshot.nodes.filter((node: CanvasNode) =>
    selectedNodeIds.includes(node.id),
  )
  const activeNode = selectedNodes.length === 1 ? selectedNodes[0] : null

  // Helpers for node updates
  const patchActive = useCallback(
    (changes: Parameters<ReturnType<typeof store.getState>['patchNode']>[1]) => {
      if (!activeNode || readOnly) return
      store.getState().patchNode(activeNode.id, changes)
    },
    [activeNode, readOnly, store],
  )

  const updateActiveData = useCallback(
    (dataChanges: Record<string, unknown>) => {
      if (!activeNode || readOnly) return
      store.getState().patchNode(activeNode.id, { data: dataChanges })
    },
    [activeNode, readOnly, store],
  )

  const handleNameChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!activeNode || readOnly) return
    store.getState().renameNode(activeNode.id, e.target.value)
  }

  const handlePosChange = (axis: 'x' | 'y', value: number) => {
    if (!activeNode || readOnly || Number.isNaN(value)) return
    patchActive({
      position: {
        ...activeNode.position,
        [axis]: value,
      },
    })
  }

  const handleSizeChange = (dim: 'width' | 'height', value: number) => {
    if (!activeNode || readOnly || Number.isNaN(value) || value <= 0) return
    const currentW = activeNode.size.width
    const currentH = activeNode.size.height
    if (aspectRatioLocked && currentW > 0 && currentH > 0) {
      if (dim === 'width') {
        const nextH = Math.round(value * (currentH / currentW))
        patchActive({ size: { width: value, height: nextH } })
      } else {
        const nextW = Math.round(value * (currentW / currentH))
        patchActive({ size: { width: nextW, height: value } })
      }
    } else {
      patchActive({
        size: {
          ...activeNode.size,
          [dim]: value,
        },
      })
    }
  }

  if (collapsed) {
    return <aside className="inspector-panel inspector-panel--collapsed" />
  }

  // 1. Multi-selection mode
  if (selectedNodes.length > 1) {
    return (
      <aside className="inspector-panel" data-testid="inspector-panel">
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
            {onToggleCollapse ? (
              <button
                aria-label="收起属性面板"
                className="inspector-icon-btn"
                onClick={onToggleCollapse}
                title="收起属性面板"
                type="button"
              >
                <PanelRightClose size={13} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="inspector-body">
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>批量操作</span>
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
        <div className="inspector-header">
          <div className="inspector-header__title-group">
            <span className="inspector-header__icon"><Sliders size={14} /></span>
            <span style={{ fontWeight: 600, fontSize: '12px' }}>画布属性</span>
          </div>
          {onToggleCollapse ? (
            <div className="inspector-header__actions">
              <button
                aria-label="收起属性面板"
                className="inspector-icon-btn"
                onClick={onToggleCollapse}
                title="收起属性面板"
                type="button"
              >
                <PanelRightClose size={13} />
              </button>
            </div>
          ) : null}
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
                  onChange={(e) => {
                    const current = store.getState().snapshot
                    store.getState().restore(JSON.stringify({ ...current, name: e.target.value }))
                  }}
                  value={snapshot.name || '画布 1'}
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
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-header__title-group">
          <span className="inspector-header__icon" title={nodeTypeLabel}>{nodeIcon}</span>
          <input
            aria-label="节点名称"
            className="inspector-header__name-input"
            disabled={readOnly || isLocked}
            onChange={handleNameChange}
            value={activeNode.name}
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
          {onToggleCollapse ? (
            <button
              aria-label="收起属性面板"
              className="inspector-icon-btn"
              onClick={onToggleCollapse}
              title="收起属性面板"
              type="button"
            >
              <PanelRightClose size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="inspector-body">
        {/* Transform Section: X, Y, W, H, Rotation */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span>变换 (Transform)</span>
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
                onChange={(val) => handlePosChange('x', val)}
                value={Math.round(activeNode.position.x)}
              />
              <input
                aria-label="X 坐标"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onChange={(e) => handlePosChange('x', Number(e.target.value))}
                type="number"
                value={Math.round(activeNode.position.y ? activeNode.position.x : activeNode.position.x)}
              />
            </div>
            <div className="inspector-field">
              <ScrubbableLabel
                label="Y"
                onChange={(val) => handlePosChange('y', val)}
                value={Math.round(activeNode.position.y)}
              />
              <input
                aria-label="Y 坐标"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onChange={(e) => handlePosChange('y', Number(e.target.value))}
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
                onChange={(val) => handleSizeChange('width', val)}
                value={Math.round(activeNode.size.width)}
              />
              <input
                aria-label="宽度"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onChange={(e) => handleSizeChange('width', Number(e.target.value))}
                type="number"
                value={Math.round(activeNode.size.width)}
              />
            </div>
            <div className="inspector-field">
              <ScrubbableLabel
                label="H"
                min={1}
                onChange={(val) => handleSizeChange('height', val)}
                value={Math.round(activeNode.size.height)}
              />
              <input
                aria-label="高度"
                className="inspector-field__input"
                disabled={readOnly || isLocked}
                onChange={(e) => handleSizeChange('height', Number(e.target.value))}
                type="number"
                value={Math.round(activeNode.size.height)}
              />
            </div>
          </div>

          {/* Rotation & Radius */}
          <div className="inspector-row">
            {'rotation' in activeNode.data ? (
              <div className="inspector-field">
                <ScrubbableLabel
                  label="旋转°"
                  onChange={(val) => updateActiveData({ rotation: val })}
                  value={Math.round((activeNode.data as { rotation?: number }).rotation ?? 0)}
                />
                <input
                  aria-label="旋转角度"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveData({ rotation: Number(e.target.value) || 0 })}
                  type="number"
                  value={Math.round((activeNode.data as { rotation?: number }).rotation ?? 0)}
                />
              </div>
            ) : null}
            {'radius' in activeNode.data || nodeType === 'image' || nodeType === 'video' ? (
              <div className="inspector-field">
                <ScrubbableLabel
                  label="圆角"
                  min={0}
                  onChange={(val) => updateActiveData({ radius: Math.max(0, val) })}
                  value={Math.round((activeNode.data as { radius?: number }).radius ?? 0)}
                />
                <input
                  aria-label="圆角大小"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  min={0}
                  onChange={(e) => updateActiveData({ radius: Math.max(0, Number(e.target.value) || 0) })}
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
                    onChange={(e) => updateActiveData({ color: e.target.value })}
                    type="color"
                    value={(activeNode as TextNode).data.color || '#e0e0e0'}
                  />
                </div>
                <span className="inspector-field__label">颜色</span>
                <input
                  aria-label="文本颜色十六进制值"
                  className="inspector-color-hex"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveData({ color: e.target.value })}
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
              <span>填充 (Fill)</span>
            </div>
            <div className="inspector-color-row">
              <div
                className="inspector-color-chip"
                style={{ background: (activeNode.data as { fill: string }).fill }}
              >
                <input
                  className="inspector-color-input-native"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveData({ fill: e.target.value })}
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
                onChange={(e) => updateActiveData({ fill: e.target.value })}
                value={(activeNode.data as { fill: string }).fill}
              />
            </div>
          </div>
        ) : null}

        {/* Stroke Section (For Frame, Shape, Path, Media) */}
        {'stroke' in activeNode.data ? (
          <div className="inspector-section">
            <div className="inspector-section__header">
              <span>描边 (Stroke)</span>
            </div>
            <div className="inspector-color-row">
              <div
                className="inspector-color-chip"
                style={{ background: (activeNode.data as { stroke: string }).stroke }}
              >
                <input
                  className="inspector-color-input-native"
                  disabled={readOnly || isLocked}
                  onChange={(e) => updateActiveData({ stroke: e.target.value })}
                  type="color"
                  value={
                    (activeNode.data as { stroke: string }).stroke?.startsWith('#')
                      ? (activeNode.data as { stroke: string }).stroke
                      : '#777777'
                  }
                />
              </div>
              <input
                aria-label="描边颜色十六进制"
                className="inspector-color-hex"
                disabled={readOnly || isLocked}
                onChange={(e) => updateActiveData({ stroke: e.target.value })}
                value={(activeNode.data as { stroke: string }).stroke ?? '#777777'}
              />
            </div>
            <div className="inspector-row" style={{ marginTop: '8px' }}>
              <div className="inspector-field">
                <ScrubbableLabel
                  label="线宽"
                  max={64}
                  min={0}
                  onChange={(val) => updateActiveData({ strokeWidth: Math.max(0, val) })}
                  value={(activeNode.data as { strokeWidth?: number }).strokeWidth ?? 1}
                />
                <input
                  aria-label="描边线宽"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  min={0}
                  onChange={(e) => updateActiveData({ strokeWidth: Math.max(0, Number(e.target.value) || 0) })}
                  type="number"
                  value={(activeNode.data as { strokeWidth?: number }).strokeWidth ?? 1}
                />
              </div>
            </div>
          </div>
        ) : null}

        {/* Layer & Opacity Section */}
        <div className="inspector-section">
          <div className="inspector-section__header">
            <span>图层与外观 (Layer & Opacity)</span>
          </div>
          {'opacity' in activeNode.data ? (
            <div className="inspector-row">
              <div className="inspector-field">
                <ScrubbableLabel
                  label="透明度"
                  max={100}
                  min={0}
                  onChange={(val) => updateActiveData({ opacity: Math.min(1, Math.max(0, val / 100)) })}
                  value={Math.round(((activeNode.data as { opacity?: number }).opacity ?? 1) * 100)}
                />
                <input
                  aria-label="透明度百分比"
                  className="inspector-field__input"
                  disabled={readOnly || isLocked}
                  max={100}
                  min={0}
                  onChange={(e) =>
                    updateActiveData({
                      opacity: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)),
                    })
                  }
                  type="number"
                  value={Math.round(((activeNode.data as { opacity?: number }).opacity ?? 1) * 100)}
                />
                <span style={{ color: '#737373', fontSize: '10px' }}>%</span>
              </div>
            </div>
          ) : null}
          <div className="inspector-row" style={{ marginTop: '8px' }}>
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
