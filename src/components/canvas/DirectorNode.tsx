import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUp,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Layers,
  ListChecks,
  ServerCog,
  Sparkles,
  X,
} from 'lucide-react'
import { NodeResizer, Position, useStore as useReactFlowStore, type NodeProps } from '@xyflow/react'

import { EditableNodeLabel } from './EditableNodeLabel'
import { NodeHandle } from './NodeHandle'
import type { CanvasFlowNode } from './mapping'
import type { CanvasNode, DirectorExecutionStep, DirectorMessage, QuestionnaireOption, QuestionnairePayload } from '../../model/project'
import { DEFAULT_VIDEO_GENERATION_SETTINGS } from '../../model/project'
import { DIRECTOR_ADAPTER_TYPES } from '../../contracts/catalog'
import { useOptionalProviderCatalog } from '../providers/ProviderCatalogContext'
import { canvasStore } from '../../store/canvas-store'
import { ratioStringFromDimensions, sizeForAspectRatio } from './mediaGeometry'
import './canvas.css'

const AVAILABLE_RATIOS = ['adaptive', '16:9', '21:9', '9:16', '4:3', '3:4', '1:1'] as const
const AVAILABLE_DURATIONS = [4, 5, 10, 15] as const
const AVAILABLE_RESOLUTIONS = ['480P', '720P', '1080P'] as const

const RATIO_CONFIGS = [
  { id: 'adaptive', label: '智能' },
  { id: '16:9', label: '16:9' },
  { id: '21:9', label: '21:9' },
  { id: '9:16', label: '9:16' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
  { id: '1:1', label: '1:1' },
] as const

interface PrefModelOption {
  id: string
  name: string
  badge?: string
  desc: string
}

const VIDEO_PREF_MODELS: PrefModelOption[] = [
  {
    id: 'seedance2.0_fast_vision',
    name: 'Seedance 2.0 Fast VIP',
    badge: '极速推理',
    desc: '小云雀官方极速推理通道，响应迅捷，支持 480P/720P/1080P，单次消耗 15~45 积分',
  },
  {
    id: 'seedance2.0_vision',
    name: 'Seedance 2.0 VIP',
    badge: '效果无损',
    desc: '小云雀官方效果无损通道，细节极致还原，单次消耗 60~90 积分',
  },
  {
    id: 'Seedance_2.5',
    name: 'Seedance 2.5',
    badge: '官方旗舰',
    desc: '新一代高动态多机位视频生成，具备极强光影质感与镜头表现力',
  },
  {
    id: 'Seedance_2.0_mini',
    name: 'Seedance 2.0 Mini',
    badge: '轻量极速',
    desc: '小云雀低能耗极速渲染通道，秒级响应',
  },
]

const IMAGE_PREF_MODELS: PrefModelOption[] = [
  {
    id: 'seedream_5.0_pro',
    name: 'Seedream 5.0 Pro',
    badge: '超清设计',
    desc: '小云雀官方旗舰图像设计模型，支持 2K/4K 超清画质，单次消耗 8 积分',
  },
  {
    id: 'seedream_5.0',
    name: 'Seedream 5.0',
    badge: '标准绘图',
    desc: '小云雀官方标准绘图大模型，单次消耗 5~6 积分',
  },
  {
    id: 'nova_pro',
    name: 'Nova Pro',
    badge: '拟真设计',
    desc: '小云雀拟真视觉设计大模型',
  },
]


function renderRatioWireframe(kind: string) {
  switch (kind) {
    case 'adaptive':
      return (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case '16:9':
      return <div className="director-pref__ratio-wireframe" style={{ width: 17, height: 10 }} />
    case '21:9':
      return <div className="director-pref__ratio-wireframe" style={{ width: 19, height: 8 }} />
    case '9:16':
      return <div className="director-pref__ratio-wireframe" style={{ width: 10, height: 17 }} />
    case '4:3':
      return <div className="director-pref__ratio-wireframe" style={{ width: 15, height: 11 }} />
    case '3:4':
      return <div className="director-pref__ratio-wireframe" style={{ width: 11, height: 15 }} />
    case '1:1':
    default:
      return <div className="director-pref__ratio-wireframe" style={{ width: 13, height: 13 }} />
  }
}

export function parseQuestionnaireFromText(text: string): {
  introText: string
  questionnaire?: QuestionnairePayload
} {
  if (!text) return { introText: '' }

  const qMarker = '"questionnaire_id"'
  const markerIdx = text.indexOf(qMarker)
  if (markerIdx === -1) {
    return { introText: text }
  }

  const jsonStart = text.lastIndexOf('{', markerIdx)
  if (jsonStart === -1) {
    return { introText: text }
  }

  const intro = text.slice(0, jsonStart).trim()
  const rawSub = text.slice(jsonStart)

  try {
    const parsed = JSON.parse(rawSub) as QuestionnairePayload
    if (parsed && parsed.questionnaire_id && Array.isArray(parsed.questions)) {
      return { introText: intro, questionnaire: parsed }
    }
  } catch {}

  let depth = 0
  let endIdx = -1
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        endIdx = i + 1
        break
      }
    }
  }

  if (endIdx !== -1) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, endIdx)) as QuestionnairePayload
      if (parsed && parsed.questionnaire_id && Array.isArray(parsed.questions)) {
        const trailing = text.slice(endIdx).trim()
        const combinedIntro = [intro, trailing].filter(Boolean).join('\n')
        return { introText: combinedIntro, questionnaire: parsed }
      }
    } catch {}
  }

  return { introText: text }
}

interface DirectorQuestionnaireCardProps {
  messageId: string
  questionnaire: QuestionnairePayload
  selectedOptionId?: string
  confirmedLabel?: string
  onConfirm: (option: QuestionnaireOption) => void
  isBusy: boolean
}

export function DirectorQuestionnaireCard({
  questionnaire,
  selectedOptionId,
  confirmedLabel,
  onConfirm,
  isBusy,
}: DirectorQuestionnaireCardProps) {
  const firstQuestion = questionnaire.questions?.[0]
  const options = firstQuestion?.options ?? []

  const [activeOptionId, setActiveOptionId] = useState<string>(() => {
    if (selectedOptionId) return selectedOptionId
    const defaultSel = options.find((o) => o.selected)
    return defaultSel?.id ?? options[0]?.id ?? ''
  })

  const selectedOpt = options.find((o) => o.id === activeOptionId) || options[0]
  const isConfirmed = Boolean(confirmedLabel)

  return (
    <div className="director-questionnaire-card">
      <div className="director-questionnaire-header">
        <div className="director-questionnaire-header-left">
          <span className="director-questionnaire-header-icon">
            <ListChecks size={14} />
          </span>
          <span>{questionnaire.title || '确认创作方向'}</span>
        </div>
        <span className={`director-questionnaire-badge ${isConfirmed ? 'is-confirmed' : ''}`}>
          {isConfirmed ? '已确认' : '待确认选项'}
        </span>
      </div>

      {firstQuestion?.title ? (
        <p className="director-questionnaire-question-title">{firstQuestion.title}</p>
      ) : null}

      <div className="director-questionnaire-options">
        {options.map((opt) => {
          const isSelected = opt.id === (isConfirmed ? selectedOptionId || activeOptionId : activeOptionId)
          const isThisConfirmed = isConfirmed && (opt.label === confirmedLabel || opt.id === selectedOptionId)

          return (
            <div
              key={opt.id}
              className={`director-questionnaire-option ${isSelected ? 'is-selected' : ''} ${
                isThisConfirmed ? 'is-confirmed' : ''
              } ${isConfirmed || isBusy ? 'is-disabled' : ''}`}
              onClick={() => {
                if (!isConfirmed && !isBusy) {
                  setActiveOptionId(opt.id)
                }
              }}
            >
              <div className="director-questionnaire-radio-indicator">
                {isSelected || isThisConfirmed ? <div className="director-questionnaire-radio-dot" /> : null}
              </div>
              <div className="director-questionnaire-option-body">
                <div className="director-questionnaire-option-label-row">
                  {opt.emoji ? <span className="director-questionnaire-option-emoji">{opt.emoji}</span> : null}
                  <span className="director-questionnaire-option-label">{opt.label}</span>
                </div>
                {opt.description ? (
                  <span className="director-questionnaire-option-desc">{opt.description}</span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className="director-questionnaire-footer">
        {isConfirmed ? (
          <div className="director-questionnaire-confirmed-tag">
            <CheckCircle2 size={13} />
            <span>已确认选择：{confirmedLabel}</span>
          </div>
        ) : (
          <button
            type="button"
            className="director-questionnaire-confirm-btn"
            disabled={!selectedOpt || isBusy}
            onClick={() => {
              if (selectedOpt && !isBusy) {
                onConfirm(selectedOpt)
              }
            }}
          >
            <span>确认选择并继续</span>
          </button>
        )}
      </div>
    </div>
  )
}

function DirectorNodeContent({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<CanvasFlowNode>) {
  const zoom = useReactFlowStore((s) => s.transform[2])
  const resizeGranted = useRef(true)

  const providerState = useOptionalProviderCatalog()
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [paramsMenuOpen, setParamsMenuOpen] = useState(false)
  const [preferenceTab, setPreferenceTab] = useState<'video' | 'image'>('video')

  const pillBtnRef = useRef<HTMLButtonElement | null>(null)
  const prefModalRef = useRef<HTMLDivElement | null>(null)
  const [prefModalStyle, setPrefModalStyle] = useState<React.CSSProperties>({})

  const updateModalPosition = useCallback(() => {
    if (!pillBtnRef.current) return
    const rect = pillBtnRef.current.getBoundingClientRect()
    const modalWidth = 520

    let left = rect.left
    if (left + modalWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - 16 - modalWidth)
    }
    if (left < 16) {
      left = 16
    }

    if (rect.top < 380) {
      setPrefModalStyle({
        top: Math.max(16, rect.bottom + 8),
        left,
      })
    } else {
      setPrefModalStyle({
        bottom: Math.max(16, window.innerHeight - rect.top + 8),
        left,
      })
    }
  }, [])

  useEffect(() => {
    if (!paramsMenuOpen) return
    updateModalPosition()

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        pillBtnRef.current &&
        !pillBtnRef.current.contains(target) &&
        prefModalRef.current &&
        !prefModalRef.current.contains(target)
      ) {
        setParamsMenuOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setParamsMenuOpen(false)
      }
    }

    const handleScrollOrResize = () => {
      updateModalPosition()
    }

    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [paramsMenuOpen, updateModalPosition, zoom])

  const [inputPrompt, setInputPrompt] = useState(data.promptDraft ?? '')
  const [localMessages, setLocalMessages] = useState<DirectorMessage[] | null>(null)
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [isChatting, setIsChatting] = useState(false)

  const [selectedImageModel, setSelectedImageModel] = useState<string>('seedream_5.0_pro')
  const [imageRatio, setImageRatio] = useState<string>('adaptive')
  const [imageResolution, setImageResolution] = useState<string>('2K')

  const threadIdRef = useRef<string | undefined>(data.threadId)
  const [threadUrl, setThreadUrl] = useState<string | undefined>(data.threadUrl)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  // Parameters state
  const initialRatio =
    data.generationSettings?.aspectRatio && AVAILABLE_RATIOS.includes(data.generationSettings.aspectRatio as never)
      ? data.generationSettings.aspectRatio
      : '16:9'
  const initialDuration =
    data.generationSettings?.kind === 'video' && AVAILABLE_DURATIONS.includes(data.generationSettings.durationSec as never)
      ? data.generationSettings.durationSec
      : 5
  const initialResolution =
    data.generationSettings?.kind === 'video' && data.generationSettings.resolution.toUpperCase().includes('1080')
      ? '1080P'
      : data.generationSettings?.kind === 'video' && data.generationSettings.resolution.toUpperCase().includes('480')
        ? '480P'
        : '720P'

  const [aspectRatio, setAspectRatio] = useState<string>(initialRatio)
  const [durationSec, setDurationSec] = useState<number>(initialDuration)
  const [resolution, setResolution] = useState<string>(initialResolution)

  // Multi-vendor resolution
  const availableProviders = useMemo(() => {
    if (!providerState?.providers) return []
    return providerState.providers.filter((p) => DIRECTOR_ADAPTER_TYPES.has(p.adapterType))
  }, [providerState?.providers])

  const selectedProvider = useMemo(() => {
    if (data.generationSettings?.providerId) {
      const matched = availableProviders.find((p) => p.id === data.generationSettings?.providerId)
      if (matched) return matched
    }
    return availableProviders.find((p) => p.available) ?? availableProviders[0]
  }, [availableProviders, data.generationSettings?.providerId])

  const catalog = useMemo(() => {
    if (selectedProvider) {
      return (
        providerState?.catalogs[selectedProvider.id] ??
        (providerState?.selectedProviderId === selectedProvider.id ? providerState?.catalog : undefined)
      )
    }
    return providerState?.catalog
  }, [selectedProvider, providerState?.catalogs, providerState?.catalog, providerState?.selectedProviderId])

  useEffect(() => {
    if (selectedProvider && !catalog && providerState?.refreshCatalog) {
      void providerState.refreshCatalog(selectedProvider.id)
    }
  }, [selectedProvider, catalog, providerState])

  const availableModels = useMemo(() => {
    if (!catalog?.models) return []
    return catalog.models.filter((m) => m.mediaType === 'video')
  }, [catalog?.models])

  const selectedModel = useMemo(() => {
    if (data.generationSettings?.model) {
      const matched = availableModels.find((m) => m.model === data.generationSettings?.model)
      if (matched) return matched
    }
    return availableModels[0]
  }, [availableModels, data.generationSettings?.model])

  // Sync external messages
  useEffect(() => {
    if (data.messages && data.messages.length > 0) {
      setLocalMessages(null)
    }
  }, [data.messages])

  // Messages list resolution
  const messages: DirectorMessage[] = useMemo(() => {
    if (localMessages !== null) return localMessages
    if (data.messages && data.messages.length > 0) return data.messages
    return [
      {
        id: 'welcome-msg',
        role: 'assistant',
        content:
          '我是您的 AI 导演智能体。您可以直接与我探讨创意构思，或下达视频制作指令。纯对话交流将保留在控制台中；当生成成片时，我将为您向画布交付视频节点并自动成组。',
        timestamp: Date.now() - 3600000,
      },
    ]
  }, [data.messages, localMessages])

  // Auto scroll chat
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages.length, data.generation?.status, isChatting])

  // Handle locate deliverable node on canvas
  const handleLocateDeliverable = (deliverableId: string) => {
    canvasStore.getState().selectNode(deliverableId)
  }

  // Deliver a VideoNode to canvas
  const deliverVideoToCanvas = (
    promptText: string,
    videoUrl?: string,
    initialProgress = 15,
  ): string => {
    const store = canvasStore.getState()
    const currentSnapshot = store.snapshot
    const thisNode = currentSnapshot.nodes.find((n) => n.id === id)
    if (!thisNode) return ''

    const deliverableId = `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    // Layout calculation for new deliverable node:
    const downstreamEdges = currentSnapshot.edges.filter(
      (e) => e.source === id && e.relation === 'flow',
    )
    const deliverIndex = downstreamEdges.length
    const col = Math.floor(deliverIndex / 2)
    const row = deliverIndex % 2

    const nodeWidth = 480
    const nodeHeight = 270
    const gapX = 40
    const gapY = 30

    const qualityOpt = selectedModel?.qualityOptions.find((q) => q.value.toLowerCase() === resolution.toLowerCase())
    const activeQuality = qualityOpt ? qualityOpt.value : resolution.toLowerCase()
    const activeMode = (data.references?.length ?? 0) === 0 ? 'text2video' : 'image2video'

    const activeSettings = {
      kind: 'video' as const,
      aspectRatio,
      durationSec,
      resolution: activeQuality,
      mode: activeMode,
      generateAudio: true,
      count: 1,
      providerId: catalog?.providerId ?? '',
      catalogVersion: catalog?.version ?? '',
      channel: selectedModel?.channel ?? '',
      model: selectedModel?.model ?? '',
    }

    const currentParentId = thisNode.parentId
    const currentParent = currentParentId ? currentSnapshot.nodes.find((n) => n.id === currentParentId) : undefined

    if (currentParent) {
      // 1. Director is already inside a group:
      const newPos = {
        x: thisNode.position.x + thisNode.size.width + gapX + col * (nodeWidth + gapX),
        y: thisNode.position.y + 10 + row * (nodeHeight + gapY),
      }

      const newNode: CanvasNode = {
        id: deliverableId,
        type: 'video',
        name: `交付成片：${promptText.slice(0, 10)}`,
        parentId: currentParent.id,
        position: newPos,
        size: { width: nodeWidth, height: nodeHeight },
        data: {
          url: videoUrl || '',
          generation: {
            status: videoUrl ? 'complete' : 'generating',
            prompt: promptText,
            progress: videoUrl ? 100 : initialProgress,
          },
          generationSettings: activeSettings,
        },
      }

      const newEdge = {
        id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: id,
        target: deliverableId,
        sourceHandle: 'source',
        targetHandle: 'target',
        relation: 'flow' as const,
      }

      const neededWidth = newPos.x + nodeWidth + 40
      const neededHeight = Math.max(currentParent.size.height, newPos.y + nodeHeight + 40)
      const nextGroupSize = {
        width: Math.max(currentParent.size.width, neededWidth),
        height: Math.max(currentParent.size.height, neededHeight),
      }

      store.addConnectedNode(newNode, newEdge)
      const existingChildIds =
        'childIds' in currentParent.data && Array.isArray(currentParent.data.childIds)
          ? currentParent.data.childIds
          : []
      store.patchNode(currentParent.id, {
        size: nextGroupSize,
        data: {
          childIds: [...existingChildIds, deliverableId],
        },
      })
      store.patchNode(id, {
        data: {
          generationSettings: activeSettings,
        },
      })
    } else {
      // 2. First deliverable: create deliverable node, edge, and wrap in GroupFrame
      const deliverablePos = {
        x: thisNode.position.x + thisNode.size.width + gapX,
        y: thisNode.position.y + 10,
      }

      const newNode: CanvasNode = {
        id: deliverableId,
        type: 'video',
        name: `交付成片：${promptText.slice(0, 10)}`,
        position: deliverablePos,
        size: { width: nodeWidth, height: nodeHeight },
        data: {
          url: videoUrl || '',
          generation: {
            status: videoUrl ? 'complete' : 'generating',
            prompt: promptText,
            progress: videoUrl ? 100 : initialProgress,
          },
          generationSettings: activeSettings,
        },
      }

      const newEdge = {
        id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: id,
        target: deliverableId,
        sourceHandle: 'source',
        targetHandle: 'target',
        relation: 'flow' as const,
      }

      store.addConnectedNode(newNode, newEdge)
      const groupId = `group-director-${Date.now().toString(36)}`
      store.groupNodes([id, deliverableId], groupId, `${data.name || '导演台'}交付组`)

      store.patchNode(id, {
        data: {
          generationSettings: activeSettings,
        },
      })
    }

    return deliverableId
  }

  // Deliver an ImageNode to canvas
  const deliverImageToCanvas = (
    imageUrl: string,
    promptText: string,
    imageMeta?: {
      aspectRatio?: string
      width?: number
      height?: number
    },
  ): string => {
    const store = canvasStore.getState()
    const currentSnapshot = store.snapshot
    const thisNode = currentSnapshot.nodes.find((n) => n.id === id)
    if (!thisNode) return ''

    const deliverableId = `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    // Layout calculation for new deliverable node:
    const downstreamEdges = currentSnapshot.edges.filter(
      (e) => e.source === id && e.relation === 'flow',
    )
    const deliverIndex = downstreamEdges.length
    const col = Math.floor(deliverIndex / 2)
    const row = deliverIndex % 2

    const targetRatio =
      imageMeta?.aspectRatio ||
      (imageMeta?.width && imageMeta?.height
        ? ratioStringFromDimensions(imageMeta.width, imageMeta.height)
        : imageRatio !== 'adaptive'
          ? imageRatio
          : '3:4')

    const nodeSize = sizeForAspectRatio(targetRatio)
    const nodeWidth = nodeSize.width
    const nodeHeight = nodeSize.height

    const gapX = 40
    const gapY = 30

    const activeSettings = {
      kind: 'image' as const,
      aspectRatio: targetRatio,
      resolution: imageResolution.toLowerCase(),
      mode: (data.references?.length ?? 0) === 0 ? 'text2image' : 'image2image',
      count: 1,
      quality: 'standard',
      providerId: catalog?.providerId ?? '',
      catalogVersion: catalog?.version ?? '',
      channel: '',
      model: selectedImageModel,
    }

    const versionId = `v-${Date.now().toString(36)}`
    const currentParentId = thisNode.parentId
    const currentParent = currentParentId ? currentSnapshot.nodes.find((n) => n.id === currentParentId) : undefined

    if (currentParent) {
      // 1. Director is already inside a group:
      const newPos = {
        x: thisNode.position.x + thisNode.size.width + gapX + col * (nodeWidth + gapX),
        y: thisNode.position.y + 10 + row * (nodeHeight + gapY),
      }

      const newNode: CanvasNode = {
        id: deliverableId,
        type: 'image',
        name: `交付图片：${promptText.slice(0, 10)}`,
        parentId: currentParent.id,
        position: newPos,
        size: { width: nodeWidth, height: nodeHeight },
        data: {
          url: imageUrl,
          displayMode: 'generation',
          objectFit: 'contain',
          generation: {
            status: 'complete',
            prompt: promptText,
            progress: 100,
            outputAspectRatio: targetRatio,
          },
          generationSettings: activeSettings,
          versions: [
            {
              id: versionId,
              url: imageUrl,
              createdAt: new Date().toISOString(),
              label: '小云雀生成',
            },
          ],
          activeVersionId: versionId,
        },
      }

      const newEdge = {
        id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: id,
        target: deliverableId,
        sourceHandle: 'source',
        targetHandle: 'target',
        relation: 'flow' as const,
      }

      const neededWidth = newPos.x + nodeWidth + 40
      const neededHeight = Math.max(currentParent.size.height, newPos.y + nodeHeight + 40)
      const nextGroupSize = {
        width: Math.max(currentParent.size.width, neededWidth),
        height: Math.max(currentParent.size.height, neededHeight),
      }

      store.addConnectedNode(newNode, newEdge)
      const existingChildIds =
        'childIds' in currentParent.data && Array.isArray(currentParent.data.childIds)
          ? currentParent.data.childIds
          : []
      store.patchNode(currentParent.id, {
        size: nextGroupSize,
        data: {
          childIds: [...existingChildIds, deliverableId],
        },
      })
    } else {
      // 2. First deliverable: create deliverable node, edge, and wrap in GroupFrame
      const deliverablePos = {
        x: thisNode.position.x + thisNode.size.width + gapX,
        y: thisNode.position.y + 10,
      }

      const newNode: CanvasNode = {
        id: deliverableId,
        type: 'image',
        name: `交付图片：${promptText.slice(0, 10)}`,
        position: deliverablePos,
        size: { width: nodeWidth, height: nodeHeight },
        data: {
          url: imageUrl,
          displayMode: 'generation',
          objectFit: 'contain',
          generation: {
            status: 'complete',
            prompt: promptText,
            progress: 100,
            outputAspectRatio: targetRatio,
          },
          generationSettings: activeSettings,
          versions: [
            {
              id: versionId,
              url: imageUrl,
              createdAt: new Date().toISOString(),
              label: '小云雀生成',
            },
          ],
          activeVersionId: versionId,
        },
      }

      const newEdge = {
        id: `edge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source: id,
        target: deliverableId,
        sourceHandle: 'source',
        targetHandle: 'target',
        relation: 'flow' as const,
      }

      store.addConnectedNode(newNode, newEdge)
      const groupId = `group-director-${Date.now().toString(36)}`
      store.groupNodes([id, deliverableId], groupId, `${data.name || '导演台'}交付组`)
    }

    return deliverableId
  }

  // Handle submit and agent interaction
  const isGenerating = data.generation?.status === 'generating' || Boolean(data.generationPending)
  const isBusy = isGenerating || isChatting

  const handleSendMessage = async (explicitPrompt?: string, baseMessages?: DirectorMessage[]) => {
    const promptText = (explicitPrompt !== undefined ? explicitPrompt : inputPrompt).trim()
    if (!promptText) return
    if (explicitPrompt === undefined && isBusy) return

    const userMsg: DirectorMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: Date.now(),
    }

    const currentBase = (baseMessages ?? messages).filter((m) => m.id !== 'welcome-msg')
    const updatedMessages = [...currentBase, userMsg]
    setLocalMessages(updatedMessages)
    // 立即持久化发送的消息，确保无论网络中断或状态延迟，画布数据始终保持同步
    canvasStore.getState().patchNode(id, {
      data: {
        messages: updatedMessages,
      },
    })

    if (explicitPrompt === undefined) {
      setInputPrompt('')
      data.onPromptChange?.(id, '')
    }
    setIsChatting(true)
    const progressMessageId = `progress-${Date.now()}`
    setLocalMessages([
      ...updatedMessages,
      {
        id: progressMessageId,
        role: 'assistant',
        content: '正在分析创作要求并调度小云雀任务…',
        executionSteps: [
          { id: 'step-1', title: '分析创作要求与参考素材', status: 'running' },
        ],
        timestamp: Date.now(),
      },
    ])

    // Also close any popovers
    setProviderMenuOpen(false)
    setParamsMenuOpen(false)

    try {
      // Prepare skill rules if skills are injected
      const skillRules = (data.skills ?? []).map((s) => `### 技能规范【${s.name}】：\n${s.text}`).join('\n\n')
      const messageWithSkills = skillRules
        ? `${promptText}\n\n【已注入导演技能规范与流程要求】:\n${skillRules}`
        : promptText

      const response = await fetch('/api/director/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProvider?.id ?? 'xiaoyunque',
          model: selectedModel?.model ?? 'seedance2.0_fast_vision',
          imageModel: selectedImageModel,
          preferenceMode: preferenceTab,
          message: messageWithSkills,
          threadId: threadIdRef.current,
          aspectRatio: preferenceTab === 'image' ? imageRatio : aspectRatio,
          duration: durationSec,
          resolution: (preferenceTab === 'image' ? imageResolution : resolution).toLowerCase(),
          references: data.references,
          skills: data.skills,
          messages: updatedMessages.slice(-8),
        }),
      })

      if (!response.ok) {
        let errMsg = `服务响应异常: HTTP ${response.status}`
        try {
          const errData = (await response.json()) as { error?: { message?: string } }
          if (errData?.error?.message) {
            errMsg = errData.error.message
          }
        } catch {}
        throw new Error(errMsg)
      }

      let resData = (await response.json()) as {
        reply?: string
        thinking?: string
        videoUrl?: string
        videoUrls?: string[]
        imageUrl?: string
        imageUrls?: string[]
        executionSteps?: DirectorExecutionStep[]
        aspectRatio?: string
        width?: number
        height?: number
        assetId?: string
        threadId?: string
        runId?: string
        threadUrl?: string
        pending?: boolean
      }

      if (resData.threadId) {
        threadIdRef.current = resData.threadId
      }
      if (resData.threadUrl) {
        setThreadUrl(resData.threadUrl)
      }

      const deliveredImageUrls = new Set<string>()
      const deliveredVideoUrls = new Set<string>()
      const finalDeliverIds: string[] = []
      let lastProgressSignature = ''

      const deliverAvailableOutputs = (payload: typeof resData) => {
        const nextImageUrls = Array.from(new Set([
          ...(payload.imageUrls ?? []),
          ...(payload.imageUrl ? [payload.imageUrl] : []),
        ]))
        const nextVideoUrls = Array.from(new Set([
          ...(payload.videoUrls ?? []),
          ...(payload.videoUrl ? [payload.videoUrl] : []),
        ]))

        for (const imageUrl of nextImageUrls) {
          if (deliveredImageUrls.has(imageUrl)) continue
          deliveredImageUrls.add(imageUrl)
          const deliverId = deliverImageToCanvas(imageUrl, promptText, {
            aspectRatio: payload.aspectRatio,
            width: payload.width,
            height: payload.height,
          })
          if (deliverId) finalDeliverIds.push(deliverId)
        }
        for (const videoUrl of nextVideoUrls) {
          if (deliveredVideoUrls.has(videoUrl)) continue
          deliveredVideoUrls.add(videoUrl)
          const deliverId = deliverVideoToCanvas(promptText, videoUrl, 100)
          if (deliverId) finalDeliverIds.push(deliverId)
        }
      }

      const publishProgress = (payload: typeof resData) => {
        const signature = JSON.stringify({
          reply: payload.reply,
          thinking: payload.thinking,
          executionSteps: payload.executionSteps,
          assetIds: finalDeliverIds,
        })
        if (signature === lastProgressSignature) return
        lastProgressSignature = signature
        const progressMessages: DirectorMessage[] = [
          ...updatedMessages,
          {
            id: progressMessageId,
            role: 'assistant',
            content: payload.reply || '小云雀任务正在执行…',
            thinking: payload.thinking,
            executionSteps: payload.executionSteps,
            timestamp: Date.now(),
            assetIds: finalDeliverIds.length > 0 ? [...finalDeliverIds] : undefined,
            threadUrl: payload.threadUrl ?? threadUrl,
          },
        ]
        setLocalMessages(progressMessages)
        canvasStore.getState().patchNode(id, {
          data: {
            messages: progressMessages,
            threadId: threadIdRef.current,
            threadUrl: payload.threadUrl ?? threadUrl,
          },
        })
      }

      deliverAvailableOutputs(resData)
      if (resData.pending) publishProgress(resData)

      // 若小云雀仍处于云端渲染中（明确回传 pending: true 时），启动客户端接力轮询
      if (
        Boolean(resData.pending) &&
        resData.runId &&
        threadIdRef.current
      ) {
        const pollThreadId = threadIdRef.current
        const pollRunId = resData.runId
        const pollStartTime = Date.now()
        // 小云雀的复杂视频/多产物任务以及等待确认的 Agent 任务常超过 3 分钟。
        // 保持接力同步足够久，避免云端稍后完成时画布已经停止监听。
        const maxPollDuration = 30 * 60_000

        while (Date.now() - pollStartTime < maxPollDuration) {
          await new Promise((resolve) => setTimeout(resolve, 2500))

          try {
            const pollRes = await fetch(
              `/api/director/poll?threadId=${encodeURIComponent(pollThreadId)}&runId=${encodeURIComponent(pollRunId)}&preferenceMode=${preferenceTab}&providerId=${encodeURIComponent(selectedProvider?.id ?? 'xiaoyunque')}`,
            )
            if (pollRes.ok) {
              const pollJson = (await pollRes.json()) as typeof resData
              deliverAvailableOutputs(pollJson)
              publishProgress(pollJson)
              // A run may publish partial artifacts before the Agent has finished.
              // Continue polling until the upstream run explicitly leaves pending state,
              // otherwise the first image/video wins and later messages are lost.
              if (!pollJson.pending) {
                resData = pollJson
                if (resData.threadUrl) {
                  setThreadUrl(resData.threadUrl)
                }
                break
              }
            }
          } catch (pollErr) {
            console.warn('[DirectorNode] Poll error:', pollErr)
          }
        }

        if (resData.pending) {
          throw new Error('小云雀任务仍在运行，画布同步等待已超过 30 分钟，请从官网确认任务状态后重试同步')
        }
      }

      // Deliver final outputs that were not already published during polling.
      deliverAvailableOutputs(resData)

      const assistantMsg: DirectorMessage = {
        id: `reply-${Date.now()}`,
        role: 'assistant',
        content:
          resData.reply ||
          (finalDeliverIds.length > 0
            ? (deliveredImageUrls.size > 0
                ? `已确认视觉设计需求，正在渲染超清构图，并已向画布交付图片「${promptText.slice(0, 10)}...」。`
                : `已确认导演创作需求，正在统筹机位光影与分镜推演，并已向画布交付成片「${promptText.slice(0, 10)}...」。`)
            : '已收到您的创作需求。'),
        thinking: resData.thinking,
        executionSteps: resData.executionSteps,
        timestamp: Date.now(),
        assetIds: finalDeliverIds.length > 0 ? finalDeliverIds : undefined,
        threadUrl: resData.threadUrl ?? threadUrl,
      }

      const finalMessages = [...updatedMessages, assistantMsg]
      setLocalMessages(finalMessages)
      canvasStore.getState().patchNode(id, {
        data: {
          messages: finalMessages,
          promptDraft: '',
          threadId: threadIdRef.current,
          threadUrl: resData.threadUrl ?? threadUrl,
        },
      })
    } catch (err: unknown) {
      console.error('[DirectorNode] Chat error:', err)
      const errorMsg = err instanceof Error ? err.message : '与小云雀通信失败'

      const assistantMsg: DirectorMessage = {
        id: `reply-${Date.now()}`,
        role: 'assistant',
        content: `小云雀服务通信异常: ${errorMsg}。请检查服务配置或网络连接。`,
        error: true,
        timestamp: Date.now(),
      }

      const finalMessages = [...updatedMessages, assistantMsg]
      setLocalMessages(finalMessages)
      canvasStore.getState().patchNode(id, {
        data: {
          messages: finalMessages,
          promptDraft: '',
        },
      })
    } finally {
      setIsChatting(false)
    }
  }

  const handleConfirmQuestionnaire = (messageId: string, option: QuestionnaireOption) => {
    const updated = messages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            selectedOptionId: option.id,
            confirmedLabel: option.label,
          }
        : m,
    )
    setLocalMessages(updated)
    canvasStore.getState().patchNode(id, {
      data: {
        messages: updated,
      },
    })

    void handleSendMessage(`我确认选择：${option.label}`, updated)
  }

  const referencesCount = data.references?.length ?? 0
  const skillsCount = data.skills?.length ?? 0
  const activeRatio = preferenceTab === 'image' ? imageRatio : aspectRatio
  const displayRatio = activeRatio === 'adaptive' ? '智能' : activeRatio
  const pillSummary =
    preferenceTab === 'image'
      ? `${skillsCount > 0 ? `技能(${skillsCount}) · ` : ''}${referencesCount > 0 ? `参考(${referencesCount}) · ` : ''}图片偏好 · ${displayRatio} · ${imageResolution}`
      : `${skillsCount > 0 ? `技能(${skillsCount}) · ` : ''}${referencesCount > 0 ? `参考(${referencesCount}) · ` : ''}${displayRatio} · ${resolution.toLowerCase()} · ${durationSec}s`
  const selectedModelTitle =
    preferenceTab === 'image'
      ? (IMAGE_PREF_MODELS.find((m) => m.id === selectedImageModel)?.name || 'Seedream 5.0 Pro')
      : (VIDEO_PREF_MODELS.find((m) => m.id === selectedModel?.model)?.name ||
         selectedModel?.title ||
         selectedModel?.model ||
         'Seedance 2.0 Fast VIP')

  return (
    <article
      className="canvas-media-node canvas-media-node--director director-workbench"
      data-node-kind="director"
      data-generation-status={data.generation?.status}
      data-selected={selected || undefined}
      aria-label={data.name || '导演台'}
      style={{
        '--resizer-scale': Math.min(1.35, Math.max(1, 1 / (zoom || 1))),
      } as React.CSSProperties}
    >
      <NodeResizer
        isVisible={selected}
        keepAspectRatio={false}
        minWidth={380}
        minHeight={300}
        lineClassName="canvas-node-resizer__line"
        handleClassName="canvas-node-resizer__handle"
        handleStyle={{ zIndex: 100 }}
        lineStyle={{ zIndex: 90 }}
        onResizeStart={() => {
          resizeGranted.current = data.onResizeStart?.(id) ?? true
        }}
        shouldResize={() => resizeGranted.current}
        onResize={(_event, { width, height, x, y }) => {
          if (resizeGranted.current) data.onResizePreview?.(id, { width, height }, { x, y })
        }}
        onResizeEnd={(_event, { width, height, x, y }) => {
          if (resizeGranted.current) data.onResize?.(id, { width, height }, { x, y })
        }}
      />

      <NodeHandle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        onPointerDown={data.onConnectionPointerDown}
      />

      {/* TOP HEADER: 极简通栏拖拽条 (无臃肿按钮，仅保留标题与微光状态指示) */}
      <div className="director-workbench__header">
        <div className="director-workbench__header-left">
          <span className="director-workbench__header-icon">
            <Clapperboard size={14} />
          </span>
          <EditableNodeLabel
            name={data.name || '导演台'}
            nodeId={id}
            onRename={data.onRename}
          />
        </div>

        <div className="director-workbench__header-right">
          {threadUrl ? (
            <a
              href={threadUrl}
              target="_blank"
              rel="noreferrer"
              className="director-workbench__header-link"
              title="在小云雀官网查看完整会话"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={11} />
              <span>小云雀官网</span>
            </a>
          ) : null}
          <div
            className={`director-workbench__status-badge ${isBusy ? 'director-workbench__status-badge--busy' : ''}`}
          >
            <span className="director-workbench__status-dot" />
            <span>{isBusy ? 'AI 导演思考中...' : 'AI 导演就绪'}</span>
          </div>
        </div>
      </div>

      {/* MAIN BODY: 弹性伸缩的对话推演面板 */}
      <div className="director-workbench__body">
        <div className="director-workbench__chat-pane nodrag nopan nowheel">
          {messages.map((msg, idx) => {
            const parsed = parseQuestionnaireFromText(msg.content)
            const questionnaire = msg.questionnaire || parsed.questionnaire
            const displayContent = parsed.introText

            let autoConfirmedLabel = msg.confirmedLabel
            if (!autoConfirmedLabel && questionnaire && idx < messages.length - 1) {
              const nextMsgs = messages.slice(idx + 1)
              const answerMsg = nextMsgs.find(
                (m) => m.role === 'user' && (m.content.includes('选择') || m.content.includes('确认')),
              )
              if (answerMsg) {
                for (const q of questionnaire.questions) {
                  for (const opt of q.options) {
                    if (answerMsg.content.includes(opt.label) || answerMsg.content.includes(opt.value)) {
                      autoConfirmedLabel = opt.label
                      break
                    }
                  }
                  if (autoConfirmedLabel) break
                }
                if (!autoConfirmedLabel) {
                  autoConfirmedLabel = answerMsg.content.replace(/^我(?:确认)?选择[：:]\s*/, '')
                }
              }
            }

            return (
              <div
                key={msg.id}
                className={`director-workbench__msg ${
                  msg.role === 'user' ? 'director-workbench__msg--user' : 'director-workbench__msg--assistant'
                }`}
              >
                {displayContent ? (
                  <div className={`director-workbench__msg-bubble ${msg.error ? 'director-workbench__msg-bubble--error' : ''}`}>
                    {displayContent}
                  </div>
                ) : null}

                {questionnaire ? (
                  <DirectorQuestionnaireCard
                    messageId={msg.id}
                    questionnaire={questionnaire}
                    selectedOptionId={msg.selectedOptionId}
                    confirmedLabel={autoConfirmedLabel}
                    onConfirm={(opt) => handleConfirmQuestionnaire(msg.id, opt)}
                    isBusy={isBusy}
                  />
                ) : null}

              {msg.threadUrl ? (
                <div className="director-workbench__thread-row">
                  <a
                    href={msg.threadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="director-workbench__thread-link"
                    title="在小云雀官网查看此会话"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span>小云雀官网同步</span>
                    <ExternalLink size={10} />
                  </a>
                </div>
              ) : null}

              {msg.executionSteps && msg.executionSteps.length > 0 ? (
                <div className="director-workbench__execution-card" aria-label="任务执行步骤">
                  <div className="director-workbench__execution-title">
                    <ListChecks size={12} />
                    <span>任务执行步骤</span>
                  </div>
                  <ol className="director-workbench__execution-list">
                    {msg.executionSteps.map((step) => (
                      <li key={step.id} data-status={step.status}>
                        <span className="director-workbench__execution-dot" aria-hidden="true" />
                        <span>{step.title}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {/* Observable upstream reasoning and execution detail */}
              {msg.thinking ? (
                <div className="director-workbench__thinking-card">
                  <button
                    className="director-workbench__thinking-toggle"
                    onClick={() =>
                      setExpandedThinking((prev) => ({
                        ...prev,
                        [msg.id]: !prev[msg.id],
                      }))
                    }
                    type="button"
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Brain size={12} />
                      小云雀执行详情
                    </span>
                    {expandedThinking[msg.id] ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                  {expandedThinking[msg.id] ? (
                    <div className="director-workbench__thinking-body">
                      {msg.thinking}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Deliverable Badge (Jump to Canvas Node) */}
              {msg.assetIds && msg.assetIds.length > 0 ? (
                <div className="director-workbench__deliverables-container">
                  {msg.assetIds.map((delivId) => {
                    const isImage = delivId.startsWith('image-')
                    return (
                      <button
                        key={delivId}
                        className="director-workbench__deliverable-badge"
                        onClick={() => handleLocateDeliverable(delivId)}
                        type="button"
                      >
                        {isImage ? <ImageIcon size={12} /> : <Film size={12} />}
                        <span>{isImage ? '已向画布交付图片' : '已向画布交付成片'}</span>
                        <ExternalLink size={10} />
                      </button>
                    )
                  })}
                </div>
              ) : null}

              <span className="director-workbench__msg-time">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )
        })}

          {/* In-progress indicator */}
          {isBusy ? (
            <div className="director-workbench__msg director-workbench__msg--assistant">
              <div
                className="director-workbench__msg-bubble"
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#93c5fd' }}
              >
                <Sparkles className="animate-spin" size={13} />
                <span>AI 导演正在统筹推演中...</span>
              </div>
            </div>
          ) : null}

          <div ref={chatBottomRef} />
        </div>

        {/* BOTTOM COMPOSER: 一体化控制台 (完全参考图二设计语言) */}
        <div className="director-workbench__composer nodrag nopan nowheel">
          {/* 技能注入条 */}
          {data.skills && data.skills.length > 0 ? (
            <div className="director-workbench__skill-strip">
              <div className="director-workbench__skill-strip-title">
                <Sparkles size={11} />
                <span>注入技能 ({data.skills.length})</span>
              </div>
              <div className="director-workbench__skill-strip-list">
                {data.skills.map((s) => (
                  <div key={s.id} className="director-workbench__skill-chip" title={s.name}>
                    <Sparkles size={10} />
                    <span className="director-workbench__skill-chip-name">{s.name}</span>
                    {data.onRemoveSkill ? (
                      <button
                        type="button"
                        className="director-workbench__skill-remove-btn"
                        title="解除技能注入"
                        onClick={(e) => {
                          e.stopPropagation()
                          data.onRemoveSkill?.(id, s.id)
                        }}
                      >
                        <X size={9} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 参考素材缩略胶囊条 */}
          {data.references && data.references.length > 0 ? (
            <div className="director-workbench__ref-strip">
              <div className="director-workbench__ref-strip-title">
                <Layers size={11} />
                <span>参考素材 ({data.references.length})</span>
              </div>
              <div className="director-workbench__ref-strip-list">
                {data.references.map((ref) => (
                  <div key={ref.id} className="director-workbench__ref-chip" title={ref.name}>
                    {ref.url ? (
                      <img
                        src={ref.url}
                        alt={ref.name}
                        className="director-workbench__ref-thumb"
                      />
                    ) : (
                      <div className="director-workbench__ref-thumb-placeholder">
                        <Film size={10} />
                      </div>
                    )}
                    <button
                      type="button"
                      className="director-workbench__ref-tag-btn"
                      title={`点击插入 @${ref.referenceAlias}`}
                      onClick={() => {
                        const tag = `@${ref.referenceAlias} `
                        setInputPrompt((prev) => (prev ? `${prev} ${tag}` : tag))
                      }}
                    >
                      @{ref.referenceAlias}
                    </button>
                    <span className="director-workbench__ref-name">{ref.name}</span>
                    {data.onRemoveReference ? (
                      <button
                        type="button"
                        className="director-workbench__ref-remove-btn"
                        aria-label={`移除参考素材 ${ref.name}`}
                        title="解除关联"
                        onClick={(e) => {
                          e.stopPropagation()
                          void data.onRemoveReference?.(id, ref.id)
                        }}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <textarea
            className="director-workbench__input-textarea"
            onChange={(e) => {
              setInputPrompt(e.target.value)
              data.onPromptChange?.(id, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSendMessage()
              }
            }}
            placeholder="输入创意需求与交付指令，如：为这款国风香水制作15秒唯美意境宣传短片..."
            value={inputPrompt}
          />

          {/* 底部功能栏：[ 📷 供应商 ▾ | 📹 模型 ▾ | ⚙️ 参数胶囊 ▾ ] ... ( ↑ ) */}
          <div className="director-workbench__toolbar">
            <div className="director-workbench__toolbar-left">
              {/* Provider Button */}
              <div style={{ position: 'relative' }}>
                <button
                  aria-label="选择导演智能体平台"
                  className="director-workbench__tool-btn"
                  onClick={() => {
                    setProviderMenuOpen(!providerMenuOpen)
                    setParamsMenuOpen(false)
                  }}
                  type="button"
                >
                  <ServerCog size={13} />
                  <span>{selectedProvider?.name ?? '导演智能体'}</span>
                  <ChevronDown size={11} />
                </button>

                {providerMenuOpen ? (
                  <div className="director-workbench__dropdown-menu" style={{ bottom: 32, left: 0 }}>
                    {availableProviders.map((p) => (
                      <button
                        key={p.id}
                        className={`director-workbench__dropdown-item ${p.id === selectedProvider?.id ? 'active' : ''}`}
                        onClick={() => {
                          data.onSettingsChange?.(id, {
                            ...(data.generationSettings ?? DEFAULT_VIDEO_GENERATION_SETTINGS),
                            providerId: p.id,
                          })
                          setProviderMenuOpen(false)
                        }}
                        type="button"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <span className="director-workbench__tool-divider" />

              {/* Model Button */}
              <div style={{ position: 'relative' }}>
                <button
                  aria-label="选择模型"
                  className="director-workbench__tool-btn"
                  onClick={() => {
                    setParamsMenuOpen(!paramsMenuOpen)
                    setProviderMenuOpen(false)
                  }}
                  type="button"
                >
                  {preferenceTab === 'image' ? <ImageIcon size={13} /> : <Film size={13} />}
                  <span>{selectedModelTitle}</span>
                  <ChevronDown size={11} />
                </button>
              </div>

              <span className="director-workbench__tool-divider" />

              {/* Integrated Settings Pill (Image 2 style: [ 全能参考 · 16:9 · 720p · 5s ▾ ]) */}
              <div style={{ position: 'relative' }}>
                <button
                  ref={pillBtnRef}
                  aria-label="成片生成参数设置"
                  className="director-workbench__pill-btn"
                  onClick={() => {
                    setParamsMenuOpen(!paramsMenuOpen)
                    setProviderMenuOpen(false)
                  }}
                  type="button"
                >
                  <span>{pillSummary}</span>
                  <ChevronDown size={11} />
                </button>

                {paramsMenuOpen && typeof document !== 'undefined'
                  ? createPortal(
                      <div
                        ref={prefModalRef}
                        style={prefModalStyle}
                        className="director-pref__modal nodrag nopan nowheel"
                        role="dialog"
                        aria-label="偏好设置"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        {/* 顶部 Tab 栏 */}
                        <div className="director-pref__tabs">
                          <button
                            type="button"
                            className={`director-pref__tab-btn ${preferenceTab === 'video' ? 'active' : ''}`}
                            onClick={() => setPreferenceTab('video')}
                          >
                            <span>视频偏好</span>
                            {preferenceTab === 'video' ? <span className="director-pref__tab-dot" /> : null}
                          </button>
                          <button
                            type="button"
                            className={`director-pref__tab-btn ${preferenceTab === 'image' ? 'active' : ''}`}
                            onClick={() => setPreferenceTab('image')}
                          >
                            <span>图片偏好</span>
                            {preferenceTab === 'image' ? <span className="director-pref__tab-dot" /> : null}
                          </button>
                        </div>

                        {/* Tab 内容区 */}
                        {preferenceTab === 'video' ? (
                          <div className="director-pref__content">
                            {/* 左栏：视频模型选择 */}
                            <div className="director-pref__col-left">
                              <span className="director-pref__section-title">模型选择</span>
                              <div className="director-pref__model-list">
                                {VIDEO_PREF_MODELS.map((item) => {
                                  const isActive =
                                    (selectedModel?.model === item.id) ||
                                    (!selectedModel?.model && item.id === 'seedance2.0_fast_vision')
                                  return (
                                    <div
                                      key={item.id}
                                      className={`director-pref__model-card ${isActive ? 'active' : ''}`}
                                      onClick={() => {
                                        const matched = availableModels.find((m) => m.model === item.id)
                                        data.onSettingsChange?.(id, {
                                          ...(data.generationSettings ?? DEFAULT_VIDEO_GENERATION_SETTINGS),
                                          model: item.id,
                                          channel: matched?.channel ?? 'video',
                                        })
                                      }}
                                    >
                                      <div className="director-pref__model-header">
                                        <span className="director-pref__model-indicator">
                                          {isActive ? '✓' : '•'}
                                        </span>
                                        <span className="director-pref__model-name">{item.name}</span>
                                        {item.badge ? (
                                          <span className="director-pref__model-badge">{item.badge}</span>
                                        ) : null}
                                      </div>
                                      <div className="director-pref__model-desc">{item.desc}</div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>

                            {/* 右栏：画面比例与规格 */}
                            <div className="director-pref__col-right">
                              {/* 画面比例 */}
                              <div className="director-pref__section-header">
                                <span className="director-pref__section-title">画面比例</span>
                                <span className="director-pref__section-tag">画幅比例</span>
                              </div>
                              <div className="director-pref__ratio-grid">
                                {RATIO_CONFIGS.map((rc) => (
                                  <button
                                    key={rc.id}
                                    type="button"
                                    className={`director-pref__ratio-btn ${rc.id === aspectRatio ? 'active' : ''}`}
                                    onClick={() => setAspectRatio(rc.id)}
                                  >
                                    <div className="director-pref__ratio-icon-box">
                                      {renderRatioWireframe(rc.id)}
                                    </div>
                                    <span className="director-pref__ratio-label">{rc.label}</span>
                                  </button>
                                ))}
                              </div>

                              {/* 视频分辨率 */}
                              <div className="director-pref__section-header">
                                <span className="director-pref__section-title">视频分辨率</span>
                                <span className="director-pref__section-tag">画质规格</span>
                              </div>
                              <div className="director-pref__pills-row">
                                {AVAILABLE_RESOLUTIONS.map((res) => (
                                  <button
                                    key={res}
                                    type="button"
                                    className={`director-pref__pill-btn ${res.toUpperCase() === resolution.toUpperCase() ? 'active' : ''}`}
                                    onClick={() => setResolution(res)}
                                  >
                                    <span>{res}</span>
                                    <span className="director-pref__diamond-icon">💎</span>
                                  </button>
                                ))}
                              </div>

                              {/* 单段时长 */}
                              <div className="director-pref__section-header">
                                <span className="director-pref__section-title">单段时长</span>
                                <span className="director-pref__section-tag">成片时长</span>
                              </div>
                              <div className="director-pref__pills-row">
                                {AVAILABLE_DURATIONS.map((dur) => (
                                  <button
                                    key={dur}
                                    type="button"
                                    className={`director-pref__pill-btn ${dur === durationSec ? 'active' : ''}`}
                                    onClick={() => setDurationSec(dur)}
                                  >
                                    <span>{dur}s</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : preferenceTab === 'image' ? (
                          <div className="director-pref__content">
                            {/* 左栏：图片模型选择 */}
                            <div className="director-pref__col-left">
                              <span className="director-pref__section-title">模型选择</span>
                              <div className="director-pref__model-list">
                                {IMAGE_PREF_MODELS.map((item) => {
                                  const isActive = selectedImageModel === item.id
                                  return (
                                    <div
                                      key={item.id}
                                      className={`director-pref__model-card ${isActive ? 'active' : ''}`}
                                      onClick={() => setSelectedImageModel(item.id)}
                                    >
                                      <div className="director-pref__model-header">
                                        <span className="director-pref__model-indicator">
                                          {isActive ? '✓' : '•'}
                                        </span>
                                        <span className="director-pref__model-name">{item.name}</span>
                                        {item.badge ? (
                                          <span className="director-pref__model-badge">{item.badge}</span>
                                        ) : null}
                                      </div>
                                      <div className="director-pref__model-desc">{item.desc}</div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>

                            {/* 右栏：图片规格 */}
                            <div className="director-pref__col-right">
                              <div className="director-pref__section-header">
                                <span className="director-pref__section-title">画面比例</span>
                              </div>
                              <div className="director-pref__ratio-grid">
                                {RATIO_CONFIGS.map((rc) => (
                                  <button
                                    key={rc.id}
                                    type="button"
                                    className={`director-pref__ratio-btn ${rc.id === imageRatio ? 'active' : ''}`}
                                    onClick={() => setImageRatio(rc.id)}
                                  >
                                    <div className="director-pref__ratio-icon-box">
                                      {renderRatioWireframe(rc.id)}
                                    </div>
                                    <span className="director-pref__ratio-label">{rc.label}</span>
                                  </button>
                                ))}
                              </div>

                              <div className="director-pref__section-header">
                                <span className="director-pref__section-title">图片分辨率</span>
                              </div>
                              <div className="director-pref__pills-row">
                                {['1K 标清', '2K 高清', '4K 超清'].map((q) => (
                                  <button
                                    key={q}
                                    type="button"
                                    className={`director-pref__pill-btn ${imageResolution === q.slice(0, 2) ? 'active' : ''}`}
                                    onClick={() => setImageResolution(q.slice(0, 2))}
                                  >
                                    <span>{q}</span>
                                    {q.includes('K') && !q.includes('1K') ? <span className="director-pref__diamond-icon">💎</span> : null}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            </div>

            {/* Right: Circular Send Button ( ↑ ) */}
            <button
              aria-label="开始交付"
              className="director-workbench__send-btn"
              disabled={!inputPrompt.trim() || isBusy}
              onClick={() => void handleSendMessage()}
              type="button"
            >
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>

      {/* Source handle on Right */}
      <NodeHandle
        id="source"
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        onPointerDown={data.onConnectionPointerDown}
      />
    </article>
  )
}

const StableDirectorNode = memo(
  DirectorNodeContent,
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected &&
    previous.isConnectable === next.isConnectable,
)

export function DirectorNode(props: NodeProps<CanvasFlowNode>) {
  return <StableDirectorNode {...props} />
}
