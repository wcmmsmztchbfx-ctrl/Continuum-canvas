import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  ImagePlus,
  Maximize2,
  Minimize2,
  RefreshCw,
  ServerCog,
  Trash2,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
} from 'lucide-react'

import type {
  CatalogModel,
  GenerationQuote,
  GenerationQuoteRequest,
  ProviderCatalog,
} from '../../contracts/generation'
import {
  isProviderCatalogFresh,
  selectCatalogModel,
} from '../../contracts/catalog'
import { createGenerationQuote } from '../../contracts/quote'
import type {
  MediaGeneration,
  MediaGenerationSettings,
} from '../../model/project'
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
} from '../../model/project'
import { useOptionalGenerationApproval } from '../providers/GenerationApprovalContext'
import { useOptionalProviderCatalog } from '../providers/ProviderCatalogContext'
import {
  estimateGenerationCredits,
  findInvalidMentionAliases,
  modelCanGenerateAudio,
  normalizeSettingsForModel,
  supportedVideoModes,
  validateGenerationUi,
} from './generationUi'
import { GenerationSettingsPopover } from './GenerationSettingsPopover'
import { correctViewportOverflow } from './floatingGeometry'
import { FloatingChoiceMenu } from './FloatingChoiceMenu'
import {
  ReferencePromptEditor,
  type PromptReference,
  type PromptReferenceCandidate,
} from './ReferencePromptEditor'

type GeneratorKind = 'image' | 'video'

const MAX_CATALOG_RECOVERY_ATTEMPTS = 3
const CATALOG_RECOVERY_BASE_DELAY_MS = 500

interface ReferenceCandidate {
  id: string
  name: string
  kind: 'image' | 'video' | 'audio'
  url?: string
  poster?: string
}

interface NodeGeneratorPanelProps {
  canvasId?: string
  kind: GeneratorKind
  nodeId: string
  projectId?: string
  generation?: MediaGeneration
  promptDraft?: string
  references?: PromptReference[]
  referenceCandidates?: ReferenceCandidate[]
  referencePickerActive?: boolean
  unresolvedReferences?: boolean
  onAttachReference?: (targetNodeId: string, sourceNodeId: string) => Promise<number | undefined>
  onRemoveReference?: (targetNodeId: string, sourceNodeId: string) => Promise<void | undefined>
  onReferencePickerChange?: (targetNodeId: string, active: boolean) => void
  onGenerate?: (nodeId: string, request: GenerationQuoteRequest) => void
  onPromptChange?: (nodeId: string, prompt: string) => void
  onRetry?: (nodeId: string, prompt: string) => void
  pending?: boolean
  error?: { code: string; message: string }
  settings?: MediaGenerationSettings
  onSettingsChange?: (
    nodeId: string,
    settings: MediaGenerationSettings,
    options?: { resolveCatalogChanged?: boolean },
  ) => void | Promise<void>
  lockedBy?: {
    displayName: string
  }
  interactionLeaseLost?: number
  onInteractionStart?: (nodeId: string, kind: 'settings') => boolean
  onInteractionEnd?: (nodeId: string, kind: 'settings') => void
  mode?: 'generate' | 'edit'
  onModeChange?: (mode: 'generate' | 'edit') => void
  editContent?: ReactNode
  versionControl?: ReactNode
  captureFrameAvailable?: boolean
  onCaptureFrame?: (capture: 'first' | 'current' | 'last') => void
}

const imageTools = [
  { id: 'reference', label: '参考', icon: ImagePlus },
] as const

const videoTools = [
  { id: 'reference', label: '参考', icon: ImagePlus },
] as const

const phaseLabels: Record<string, string> = {
  queued: '排队中',
  uploading: '上传参考',
  submitted: '已提交',
  running: '生成中',
  downloading: '保存结果',
  complete: '已完成',
  failed: '生成失败',
}

function defaultSettings(kind: GeneratorKind): MediaGenerationSettings {
  return kind === 'image'
    ? { ...DEFAULT_IMAGE_GENERATION_SETTINGS }
    : { ...DEFAULT_VIDEO_GENERATION_SETTINGS }
}

function settingsEqual(
  left: MediaGenerationSettings,
  right: MediaGenerationSettings,
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function modelTitle(model: CatalogModel): string {
  return model.title ?? model.label ?? model.model
}

function imageMode(
  model: CatalogModel,
  referenceCount: number,
  current?: string,
): string | undefined {
  const preferred = referenceCount > 0
    ? model.modes.find((mode) => /image|reference/i.test(mode))
    : model.modes.find((mode) => /text/i.test(mode))
  return preferred ?? (current && model.modes.includes(current) ? current : model.modes[0])
}

function normalizePanelSettings(
  settings: MediaGenerationSettings,
  model: CatalogModel,
  catalogVersion: string,
  providerId: string,
  referenceCount: number,
): MediaGenerationSettings {
  let next = normalizeSettingsForModel(
    settings,
    model,
    catalogVersion,
    providerId,
  )
  if (next.kind === 'image' && model.mediaType === 'image') {
    next = {
      ...next,
      mode: imageMode(model, referenceCount, next.mode),
    }
  }
  if (
    next.kind === 'video' &&
    model.mediaType === 'video' &&
    !modelCanGenerateAudio(model) &&
    next.generateAudio
  ) {
    next = { ...next, generateAudio: false }
  }
  return next
}

function comparableQuoteRequest(request: GenerationQuoteRequest | Omit<GenerationQuoteRequest, 'clientRequestId'>) {
  const { catalogVersion: _catalogVersion, clientRequestId: _clientRequestId, ...semantic } = request as GenerationQuoteRequest
  return JSON.stringify(semantic)
}

function settingsIntent(settings: MediaGenerationSettings) {
  const {
    providerId: _providerId,
    catalogVersion: _catalogVersion,
    channel: _channel,
    ...intent
  } = settings
  return JSON.stringify(intent)
}

function refreshedModelChoice(
  catalog: ProviderCatalog | undefined,
  settings: MediaGenerationSettings,
  referenceKinds: readonly ('image' | 'video' | 'audio')[],
  currentCredits: number,
) {
  if (!catalog) return undefined
  return catalog.models
    .filter((model) => model.mediaType === settings.kind)
    .map((model, index) => {
      const next = normalizePanelSettings(
        settings,
        model,
        catalog.version,
        catalog.providerId,
        referenceKinds.length,
      )
      const validation = validateGenerationUi({
        settings: next,
        model,
        referenceAliases: referenceKinds.map((_, alias) => alias + 1),
        references: referenceKinds.map((mediaType, alias) => ({ alias: alias + 1, mediaType })),
        invalidMentionAliases: [],
      })
      const credits = estimateGenerationCredits(model, next, referenceKinds)
      return {
        model,
        next,
        credits,
        valid: validation.valid,
        score: [
          model.model === settings.model ? 0 : 1,
          settingsIntent(next) === settingsIntent(settings) ? 0 : 1,
          Math.abs(credits - currentCredits),
          model.raw.channelDefaultOption === true ? 0 : 1,
          index,
        ],
      }
    })
    .filter((candidate) => candidate.valid)
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index += 1) {
        const difference = left.score[index] - right.score[index]
        if (difference !== 0) return difference
      }
      return 0
    })[0]
}

function ReferenceStrip({
  limits,
  nodeId,
  onPicker,
  onRemove,
  pickerActive,
  references,
}: {
  limits?: CatalogModel['inputLimits']
  nodeId: string
  onPicker?: (targetNodeId: string, active: boolean) => void
  onRemove?: (targetNodeId: string, sourceNodeId: string) => void
  pickerActive: boolean
  references: PromptReference[]
}) {
  const counts = {
    images: references.filter((reference) => reference.kind === 'image').length,
    videos: references.filter((reference) => reference.kind === 'video').length,
    audios: references.filter((reference) => reference.kind === 'audio').length,
  }
  const totalLimit = limits
    ? limits.images + limits.videos + limits.audios
    : undefined
  const allLimitsReached = Boolean(
    limits &&
      counts.images >= limits.images &&
      counts.videos >= limits.videos &&
      counts.audios >= limits.audios,
  )
  const limitLabel = totalLimit ?? '—'
  return (
    <div
      aria-label={`参考素材 ${references.length}/${limitLabel}`}
      className="canvas-reference-strip"
      data-limit-reached={allLimitsReached || undefined}
      data-limit-unknown={!limits || undefined}
    >
      <div className="canvas-reference-strip__items">
        {references.map((reference) => (
          <figure
            aria-label={`参考 @${reference.referenceAlias}：${reference.name}`}
            className="canvas-reference-card"
            data-broken={reference.broken || undefined}
            data-media-kind={reference.kind}
            data-reference-alias={reference.referenceAlias}
            key={reference.id}
          >
            <div className="canvas-reference-card__preview">
              {reference.url || reference.poster ? (
                <img
                  alt=""
                  draggable={false}
                  src={reference.poster || reference.url}
                />
              ) : (
                <ImagePlus aria-hidden="true" size={18} />
              )}
              <span>@{reference.referenceAlias}</span>
              <button
                aria-label={`移除参考 @${reference.referenceAlias}`}
                onClick={() => onRemove?.(nodeId, reference.id)}
                title={`移除参考 @${reference.referenceAlias}`}
                type="button"
              >
                <Trash2 aria-hidden="true" size={12} />
              </button>
            </div>
            <figcaption>{reference.name}</figcaption>
          </figure>
        ))}
        <button
          aria-label="添加参考"
          aria-pressed={pickerActive}
          className="canvas-reference-card canvas-reference-card--add"
          disabled={!limits || totalLimit === 0 || allLimitsReached}
          onClick={() => onPicker?.(nodeId, !pickerActive)}
          title="从画布选择参考素材"
          type="button"
        >
          <ImagePlus aria-hidden="true" size={18} />
          <span>{pickerActive ? '选择中' : '画布选择'}</span>
        </button>
      </div>
      <span className="canvas-reference-strip__count">
        {references.length}/{limitLabel}
      </span>
    </div>
  )
}

function focusMenuItem(menu: HTMLElement | null, index: 'first' | 'last') {
  const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]')
  if (!items?.length) return
  items[index === 'first' ? 0 : items.length - 1]?.focus()
}

function handleChoiceMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  close: () => void,
  trigger: HTMLButtonElement | null,
) {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  )
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    trigger?.focus()
    return
  }
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLElement)
  let next: number | undefined
  if (event.key === 'ArrowDown') next = (current + 1) % items.length
  if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = items.length - 1
  if (next === undefined) return
  event.preventDefault()
  items[next]?.focus()
}

function createClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `quote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function NodeGeneratorPanel({
  canvasId,
  generation,
  kind,
  nodeId,
  projectId = 'local',
  onAttachReference,
  onGenerate,
  onPromptChange,
  onReferencePickerChange,
  onRemoveReference,
  onRetry,
  pending = false,
  promptDraft,
  error,
  interactionLeaseLost,
  lockedBy,
  onInteractionEnd,
  onInteractionStart,
  onSettingsChange,
  referenceCandidates = [],
  referencePickerActive = false,
  references = [],
  settings,
  unresolvedReferences = false,
  mode = 'generate',
  onModeChange,
  editContent,
  versionControl,
  captureFrameAvailable = false,
  onCaptureFrame,
}: NodeGeneratorPanelProps) {
  const providerState = useOptionalProviderCatalog()
  const approval = useOptionalGenerationApproval()
  const tools = kind === 'image' ? imageTools : videoTools
  const [prompt, setPrompt] = useState(promptDraft ?? generation?.prompt ?? '')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [videoModeOpen, setVideoModeOpen] = useState(false)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [resolvedCatalogErrorIdentity, setResolvedCatalogErrorIdentity] =
    useState<string>()
  const [catalogDifference, setCatalogDifference] = useState<string>()
  const [submissionGuarded, setSubmissionGuarded] = useState(false)
  const [showCompletedStatus, setShowCompletedStatus] = useState(false)
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeMenuRef = useRef<HTMLDivElement | null>(null)
  const providerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const providerMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const expandedDialogRef = useRef<HTMLDivElement | null>(null)
  const interactionHeld = useRef(false)
  const [interactionLockMessage, setInteractionLockMessage] = useState<string>()
  const [panelShift, setPanelShift] = useState({ x: 0, y: 0 })
  const modelInitialFocusRef = useRef<'first' | 'last'>('first')
  const modeInitialFocusRef = useRef<'first' | 'last'>('first')
  const providerInitialFocusRef = useRef<'first' | 'last'>('first')
  const currentQuoteStateRef = useRef<{
    exactCredits: number
    request: Omit<GenerationQuoteRequest, 'clientRequestId'>
    valid: boolean
  } | null>(null)
  const rejectedQuoteRef = useRef(new Map<string, GenerationQuote>())
  const catalogRecoveryRef = useRef(new Set<string>())
  const catalogRecoveryAttemptsRef = useRef(new Map<string, number>())
  const catalogRecoveryExhaustedRef = useRef(new Set<string>())
  const catalogRecoveryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const activeCatalogErrorIdentityRef = useRef<string | undefined>(undefined)
  const [catalogRecoveryTick, setCatalogRecoveryTick] = useState(0)
  const submissionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [resolvedSettings, setResolvedSettings] =
    useState<MediaGenerationSettings>(() => settings ?? defaultSettings(kind))

  const beginSettingsInteraction = useCallback(() => {
    if (interactionHeld.current) return true
    if (lockedBy) {
      setInteractionLockMessage(`${lockedBy.displayName} 正在编辑生成设置`)
      return false
    }
    const granted = onInteractionStart?.(nodeId, 'settings') ?? true
    if (!granted) {
      setInteractionLockMessage('生成设置正在由其他成员编辑')
      return false
    }
    interactionHeld.current = true
    setInteractionLockMessage(undefined)
    return true
  }, [lockedBy, nodeId, onInteractionStart])
  const endSettingsInteraction = useCallback(() => {
    if (!interactionHeld.current) return
    interactionHeld.current = false
    onInteractionEnd?.(nodeId, 'settings')
  }, [nodeId, onInteractionEnd])
  const runReferenceMutation = useCallback(async <T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const shouldRestore = interactionHeld.current
    endSettingsInteraction()
    try {
      return await operation()
    } finally {
      if (
        shouldRestore &&
        (expanded || panelRef.current?.contains(document.activeElement))
      ) {
        beginSettingsInteraction()
      }
    }
  }, [beginSettingsInteraction, endSettingsInteraction, expanded])

  useEffect(() => () => endSettingsInteraction(), [endSettingsInteraction])
  useEffect(() => () => {
    if (submissionTimerRef.current) clearTimeout(submissionTimerRef.current)
  }, [])
  useEffect(() => {
    if (generation?.status !== 'complete') {
      setShowCompletedStatus(false)
      return
    }
    setShowCompletedStatus(true)
    const timer = setTimeout(() => setShowCompletedStatus(false), 2_500)
    return () => clearTimeout(timer)
  }, [generation?.clientRequestId, generation?.jobId, generation?.status])
  useEffect(() => {
    if (interactionLeaseLost === undefined) return
    interactionHeld.current = false
    setInteractionLockMessage(
      lockedBy ? `${lockedBy.displayName} 正在编辑生成设置` : '生成设置编辑锁已失效',
    )
  }, [interactionLeaseLost, lockedBy])

  const selectedProvider = providerState?.selectedProvider
  const catalog = providerState?.catalog
  const models = useMemo(
    () => catalog?.models.filter((model) => model.mediaType === kind) ?? [],
    [catalog?.models, kind],
  )
  const selectedModel = catalog
    ? selectCatalogModel(catalog, {
        providerId: resolvedSettings.providerId ?? catalog.providerId,
        channel: resolvedSettings.channel,
        model: resolvedSettings.model,
        mediaType: kind,
      }) ?? models[0]
    : undefined

  useEffect(
    () => setPrompt(promptDraft ?? generation?.prompt ?? ''),
    [generation?.prompt, promptDraft],
  )
  useEffect(() => {
    const next = settings ?? defaultSettings(kind)
    setResolvedSettings(next)
  }, [kind, settings])

  useEffect(() => {
    if (!selectedModel || !catalog) return
    const next = normalizePanelSettings(
      resolvedSettings,
      selectedModel,
      catalog.version,
      catalog.providerId,
      references.length,
    )
    if (settingsEqual(next, resolvedSettings)) return
    setResolvedSettings(next)
    if (onInteractionStart && !interactionHeld.current) return
    onSettingsChange?.(nodeId, next)
  }, [
    catalog,
    nodeId,
    onInteractionStart,
    onSettingsChange,
    references.length,
    resolvedSettings,
    selectedModel,
  ])

  useEffect(() => {
    if (!settingsOpen && !modelMenuOpen && !videoModeOpen && !providerMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSettingsOpen(false)
      setModelMenuOpen(false)
      setVideoModeOpen(false)
      setProviderMenuOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [modelMenuOpen, providerMenuOpen, settingsOpen, videoModeOpen])

  useLayoutEffect(() => {
    if (modelMenuOpen) focusMenuItem(modelMenuRef.current, modelInitialFocusRef.current)
  }, [modelMenuOpen])

  useLayoutEffect(() => {
    if (videoModeOpen) focusMenuItem(modeMenuRef.current, modeInitialFocusRef.current)
  }, [videoModeOpen])

  useLayoutEffect(() => {
    if (providerMenuOpen) focusMenuItem(providerMenuRef.current, providerInitialFocusRef.current)
  }, [providerMenuOpen])

  useLayoutEffect(() => {
    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const bounds = panelRef.current?.getBoundingClientRect()
        if (!bounds?.width || !bounds.height) return
        const correction = correctViewportOverflow(bounds, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
        if (correction.x === 0 && correction.y === 0) return
        setPanelShift((current) => ({
          x: current.x + correction.x,
          y: current.y + correction.y,
        }))
      })
    }
    update()
    window.addEventListener('resize', update)
    const flowViewport = panelRef.current
      ?.closest('.react-flow')
      ?.querySelector('.react-flow__viewport')
    const viewportObserver = flowViewport && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(update)
      : undefined
    if (flowViewport) viewportObserver?.observe(flowViewport, {
      attributeFilter: ['style'],
      attributes: true,
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      viewportObserver?.disconnect()
    }
  }, [])

  const catalogErrorIdentity = error?.code === 'catalog_changed'
    ? `${generation?.clientRequestId ?? 'legacy'}:${error.message}`
    : undefined
  activeCatalogErrorIdentityRef.current = catalogErrorIdentity
  const catalogChanged = Boolean(
    catalogErrorIdentity &&
    catalogErrorIdentity !== resolvedCatalogErrorIdentity,
  )
  const visibleError =
    error?.code === 'catalog_changed' && !catalogChanged ? undefined : error

  const handleSettingsChange = (next: MediaGenerationSettings) => {
    if (!beginSettingsInteraction()) return
    setResolvedSettings(next)
    onSettingsChange?.(nodeId, next)
  }
  const switchProvider = async (providerId: string) => {
    if (!beginSettingsInteraction()) return
    setProviderMenuOpen(false)
    setModelMenuOpen(false)
    setSettingsOpen(false)
    setCatalogDifference(undefined)
    setSubmissionGuarded(false)
    await providerState?.selectProvider(providerId)
    const nextCatalog = providerState
      ? await providerState.refreshCatalog(providerId)
      : undefined
    if (!nextCatalog) return
    const model = nextCatalog.models.find(
      (candidate) => candidate.mediaType === kind,
    )
    const next = model
      ? normalizePanelSettings(
          resolvedSettings,
          model,
          nextCatalog.version,
          nextCatalog.providerId,
          references.length,
        )
      : {
          ...resolvedSettings,
          providerId,
          channel: '',
          model: '',
          catalogVersion: undefined,
        }
    handleSettingsChange(next)
  }
  const videoModes = selectedModel ? supportedVideoModes(selectedModel) : []
  const selectedVideoMode =
    resolvedSettings.kind === 'video'
      ? videoModes.find((mode) => mode.value === resolvedSettings.mode)
      : undefined
  const referenceAliases = references.map((reference) => reference.referenceAlias)
  const invalidMentionAliases = findInvalidMentionAliases(prompt, referenceAliases)
  const catalogNeedsSync = Boolean(
    catalog && (catalog.stale || !isProviderCatalogFresh(catalog)),
  )
  const validation = selectedModel
    ? validateGenerationUi({
        settings: resolvedSettings,
        model: selectedModel,
        referenceAliases,
        references: references.map((reference) => ({
          alias: reference.referenceAlias,
          mediaType: reference.kind,
        })),
        invalidMentionAliases,
        unresolvedReferences:
          unresolvedReferences || references.some((reference) => reference.broken),
      })
    : { valid: false, message: providerState?.loading ? '正在加载模型目录' : '模型目录不可用' }
  const estimatedCredits = selectedModel
    ? estimateGenerationCredits(
        selectedModel,
        resolvedSettings,
        references.map((reference) => reference.kind),
      )
    : 0
  const displayedRatio = generation?.outputAspectRatio &&
    generation.outputAspectRatio !== resolvedSettings.aspectRatio
    ? `${resolvedSettings.aspectRatio}（实际 ${generation.outputAspectRatio}）`
    : resolvedSettings.aspectRatio
  const settingsSummary =
    resolvedSettings.kind === 'image'
      ? `${displayedRatio} · ${resolvedSettings.quality} · ${resolvedSettings.count}张`
      : `${displayedRatio} · ${resolvedSettings.resolution} · ${resolvedSettings.durationSec}s · ${resolvedSettings.count}个`
  const settingsLabel =
    resolvedSettings.kind === 'video'
      ? `生成详情：${settingsSummary}，音频${resolvedSettings.generateAudio ? '开启' : '关闭'}`
      : `生成详情：${settingsSummary}`
  const placeholder =
    kind === 'image'
      ? '描述画面，输入 @ 可在关键位置引用图片'
      : '描述镜头动作与节奏，输入 @ 引用人物、场景或关键帧'
  const recoverable =
    onRetry !== undefined &&
    (error?.code === 'manual_recovery_required' ||
      error?.code === 'poll_timeout' ||
      error?.code === 'poll_unavailable' ||
      error?.code === 'network_error' ||
      error?.code === 'local_persistence_failed' ||
      error?.code === 'REFERENCE_STAGING_FAILED')
  const submitLabel = recoverable
    ? '恢复生成'
    : pending
      ? '生成提交中'
      : '开始生成'
  const phaseLabel = generation?.phase === 'complete' && !showCompletedStatus
    ? ''
    : generation?.phase
    ? phaseLabels[generation.phase]
    : generation?.status === 'generating'
      ? '生成中'
      : ''
  const progressLabel =
    phaseLabel && generation?.status === 'generating'
      ? `${phaseLabel}${generation.progress !== undefined ? ` ${generation.progress}%` : ''}`
      : phaseLabel
  const providerUnavailable =
    !selectedProvider ||
    !selectedProvider.enabled ||
    !selectedProvider.available ||
    !selectedProvider.secretConfigured
  const referenceCounts = {
    image: references.filter((reference) => reference.kind === 'image').length,
    video: references.filter((reference) => reference.kind === 'video').length,
    audio: references.filter((reference) => reference.kind === 'audio').length,
  }
  const referenceLimits = selectedModel?.inputLimits
  const limitFor = (mediaType: 'image' | 'video' | 'audio') =>
    referenceLimits?.[
      mediaType === 'image' ? 'images' : mediaType === 'video' ? 'videos' : 'audios'
    ] ?? 0
  const candidates: PromptReferenceCandidate[] = [...new Map(
    [
      ...references.map((reference) => ({
        id: reference.id,
        name: reference.name,
        kind: reference.kind,
        url: reference.url,
        poster: reference.poster,
        connectedAlias: reference.referenceAlias,
      })),
      ...referenceCandidates.map((candidate) => ({
        ...candidate,
        connectedAlias: references.find((reference) => reference.id === candidate.id)
          ?.referenceAlias,
      })),
    ].map((candidate) => [candidate.id, candidate]),
  ).values()].filter((candidate) =>
    candidate.connectedAlias !== undefined ||
    (referenceLimits !== undefined &&
      referenceCounts[candidate.kind] < limitFor(candidate.kind)),
  )

  const quoteRequest = (): Omit<GenerationQuoteRequest, 'clientRequestId'> | null => {
    if (!selectedModel || !catalog) return null
    return {
      ...(canvasId ? { canvasId } : {}),
      projectId,
      providerId: catalog.providerId,
      catalogVersion: catalog.version,
      mediaType: kind,
      channel: selectedModel.channel,
      model: selectedModel.model,
      prompt: prompt.trim(),
      quality: resolvedSettings.kind === 'image'
        ? resolvedSettings.quality
        : resolvedSettings.resolution,
      aspectRatio: resolvedSettings.aspectRatio,
      n: resolvedSettings.count,
      ...(resolvedSettings.kind === 'video'
        ? {
            duration: resolvedSettings.durationSec,
            generateAudio: resolvedSettings.generateAudio,
          }
        : {}),
      ...(resolvedSettings.mode ? { mode: resolvedSettings.mode } : {}),
      references: references.map((reference) => ({
        alias: reference.referenceAlias,
        mediaType: reference.kind,
        nodeId: reference.id,
      })),
    }
  }
  const currentQuoteRequest = quoteRequest()
  currentQuoteStateRef.current = currentQuoteRequest
    ? { exactCredits: estimatedCredits, request: currentQuoteRequest, valid: validation.valid }
    : null

  if (
    catalogErrorIdentity &&
    !rejectedQuoteRef.current.has(catalogErrorIdentity) &&
    currentQuoteStateRef.current
  ) {
    rejectedQuoteRef.current.set(catalogErrorIdentity, createGenerationQuote({
      ...currentQuoteStateRef.current.request,
      clientRequestId: generation?.clientRequestId ?? createClientRequestId(),
    }, currentQuoteStateRef.current.exactCredits))
  }

  useEffect(() => {
    const recoveryTimers = catalogRecoveryTimersRef.current
    return () => {
      for (const timer of recoveryTimers.values()) clearTimeout(timer)
      recoveryTimers.clear()
    }
  }, [])

  useEffect(() => {
    if (
      !catalogErrorIdentity ||
      !providerState ||
      !catalog ||
      !onGenerate ||
      catalogRecoveryRef.current.has(catalogErrorIdentity) ||
      catalogRecoveryExhaustedRef.current.has(catalogErrorIdentity) ||
      catalogRecoveryTimersRef.current.has(catalogErrorIdentity)
    ) return
    const rejected = rejectedQuoteRef.current.get(catalogErrorIdentity)
    if (!rejected) return
    const attempt = (catalogRecoveryAttemptsRef.current.get(catalogErrorIdentity) ?? 0) + 1
    catalogRecoveryAttemptsRef.current.set(catalogErrorIdentity, attempt)
    catalogRecoveryRef.current.add(catalogErrorIdentity)

    const retryLater = () => {
      catalogRecoveryRef.current.delete(catalogErrorIdentity)
      if (activeCatalogErrorIdentityRef.current !== catalogErrorIdentity) return
      if (attempt >= MAX_CATALOG_RECOVERY_ATTEMPTS) {
        catalogRecoveryExhaustedRef.current.add(catalogErrorIdentity)
        return
      }
      const delay = CATALOG_RECOVERY_BASE_DELAY_MS * 2 ** (attempt - 1)
      const timer = setTimeout(() => {
        catalogRecoveryTimersRef.current.delete(catalogErrorIdentity)
        setCatalogRecoveryTick((current) => current + 1)
      }, delay)
      catalogRecoveryTimersRef.current.set(catalogErrorIdentity, timer)
    }

    void (async () => {
      try {
        let refreshed = await providerState.syncProvider(catalog.providerId, { force: true })
        if (refreshed && refreshed.version === rejected.request.catalogVersion) {
          refreshed = await providerState.refreshCatalog(catalog.providerId)
        }
        if (!refreshed || activeCatalogErrorIdentityRef.current !== catalogErrorIdentity) {
          retryLater()
          return
        }
        const refreshedModel = selectCatalogModel(refreshed, {
          providerId: resolvedSettings.providerId ?? refreshed.providerId,
          channel: resolvedSettings.channel,
          model: resolvedSettings.model,
          mediaType: kind,
        }) ?? refreshed.models.find((model) => model.mediaType === kind)
        if (!refreshedModel) {
          retryLater()
          return
        }
        const next = normalizePanelSettings(
          resolvedSettings,
          refreshedModel,
          refreshed.version,
          refreshed.providerId,
          references.length,
        )
        const nextCredits = estimateGenerationCredits(
          refreshedModel,
          next,
          references.map((reference) => reference.kind),
        )
        const nextRequest: GenerationQuoteRequest = {
          ...rejected.request,
          providerId: refreshed.providerId,
          catalogVersion: refreshed.version,
          channel: refreshedModel.channel,
          model: refreshedModel.model,
          quality: next.kind === 'image' ? next.quality : next.resolution,
          aspectRatio: next.aspectRatio,
          n: next.count,
          ...(next.kind === 'video'
            ? { duration: next.durationSec, generateAudio: next.generateAudio }
            : {}),
          ...(next.mode ? { mode: next.mode } : {}),
        }
        const comparable = (request: GenerationQuoteRequest) => {
          const { catalogVersion: _catalog, clientRequestId: _id, ...semantic } = request
          return JSON.stringify(semantic)
        }
        const unchanged =
          comparable(rejected.request) === comparable(nextRequest) &&
          rejected.exactCredits === nextCredits
        await onSettingsChange?.(nodeId, next, { resolveCatalogChanged: true })
        if (activeCatalogErrorIdentityRef.current !== catalogErrorIdentity) return
        setResolvedSettings(next)
        setResolvedCatalogErrorIdentity(catalogErrorIdentity)
        if (unchanged) {
          setCatalogDifference(undefined)
          onGenerate(nodeId, nextRequest)
          return
        }
        setCatalogDifference(
          `目录已更新：${rejected.request.quality} / ${rejected.exactCredits} 积分 → ` +
          `${nextRequest.quality} / ${nextCredits} 积分，请确认后重新生成`,
        )
      } catch {
        retryLater()
      }
    })()
  }, [
    catalog,
    catalogRecoveryTick,
    catalogErrorIdentity,
    kind,
    nodeId,
    onGenerate,
    onSettingsChange,
    providerState,
    references,
    resolvedSettings,
  ])

  const submit = () => {
    void submitAfterCatalogRefresh()
  }

  const submitAfterCatalogRefresh = async () => {
    if (submissionGuarded && !recoverable) return
    if (!beginSettingsInteraction()) return
    const trimmedPrompt = prompt.trim()
    if (recoverable) {
      onRetry?.(nodeId, trimmedPrompt)
      return
    }
    const currentQuoteState = currentQuoteStateRef.current
    if (
      !onGenerate || !selectedModel || !selectedProvider || !catalog ||
      !providerState || !currentQuoteState?.valid
    ) return
    setSubmissionGuarded(true)
    if (submissionTimerRef.current) clearTimeout(submissionTimerRef.current)
    setCatalogDifference(undefined)
    let submitted = false
    try {
      const refreshed = await providerState.syncProvider(catalog.providerId, { force: true })
      if (!refreshed) {
        setCatalogDifference('目录同步失败，未提交任务')
        return
      }
      const latestBeforeUpdate = currentQuoteStateRef.current
      if (
        !latestBeforeUpdate?.valid ||
        comparableQuoteRequest(latestBeforeUpdate.request) !==
          comparableQuoteRequest(currentQuoteState.request)
      ) {
        setCatalogDifference('生成内容已变化，未提交任务，请再次点击生成')
        return
      }
      const choice = refreshedModelChoice(
        refreshed,
        resolvedSettings,
        references.map((reference) => reference.kind),
        currentQuoteState.exactCredits,
      )
      if (!choice) {
        setCatalogDifference('新目录中没有兼容的生成线路，未提交任务')
        return
      }
      const nextRequest: Omit<GenerationQuoteRequest, 'clientRequestId'> = {
        ...currentQuoteState.request,
        providerId: refreshed.providerId,
        catalogVersion: refreshed.version,
        channel: choice.model.channel,
        model: choice.model.model,
        quality: choice.next.kind === 'image'
          ? choice.next.quality
          : choice.next.resolution,
        aspectRatio: choice.next.aspectRatio,
        n: choice.next.count,
        ...(choice.next.kind === 'video'
          ? { duration: choice.next.durationSec, generateAudio: choice.next.generateAudio }
          : {}),
        ...(choice.next.mode ? { mode: choice.next.mode } : {}),
      }
      const changed =
        comparableQuoteRequest(currentQuoteState.request) !== comparableQuoteRequest(nextRequest) ||
        currentQuoteState.exactCredits !== choice.credits
      if (!settingsEqual(choice.next, resolvedSettings)) {
        setResolvedSettings(choice.next)
        await onSettingsChange?.(nodeId, choice.next)
      }
      if (changed) {
        setCatalogDifference(
          `线路已更新：${modelTitle(selectedModel)}（${String(selectedModel.channel)}）/ ` +
          `${currentQuoteState.exactCredits} 积分 → ${modelTitle(choice.model)}` +
          `（${String(choice.model.channel)}）/ ${choice.credits} 积分，未提交任务，请再次点击生成`,
        )
        return
      }
      const quote = createGenerationQuote({
        ...nextRequest,
        clientRequestId: createClientRequestId(),
      }, choice.credits)
      const action = (approved: GenerationQuote) => onGenerate(nodeId, approved.request)
      const details = {
        providerName: selectedProvider.name,
        modelName: modelTitle(choice.model),
        credits: choice.credits,
        quote,
      }
      if (approval) approval.requestGeneration(
        details,
        (approved) => action(approved as GenerationQuote),
        () => true,
      )
      else action(quote)
      submitted = true
    } catch {
      setCatalogDifference('目录同步失败，未提交任务')
    } finally {
      if (submitted) {
        submissionTimerRef.current = setTimeout(() => setSubmissionGuarded(false), 500)
      } else {
        setSubmissionGuarded(false)
      }
    }
  }

  const closeExpanded = useCallback(() => {
    setExpanded(false)
    endSettingsInteraction()
    window.requestAnimationFrame(() => {
      document.getElementById(`node-editor-expand-${nodeId}`)?.focus()
    })
  }, [endSettingsInteraction, nodeId])

  useEffect(() => {
    if (!expanded) return
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (modelMenuOpen || videoModeOpen || settingsOpen || providerMenuOpen) {
        event.preventDefault()
        setModelMenuOpen(false)
        setVideoModeOpen(false)
        setSettingsOpen(false)
        setProviderMenuOpen(false)
        return
      }
      event.preventDefault()
      closeExpanded()
    }
    document.addEventListener('keydown', handleEscape)
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('.canvas-node-editor-dialog textarea')
        ?.focus()
    })
    return () => document.removeEventListener('keydown', handleEscape)
  }, [closeExpanded, expanded, modelMenuOpen, providerMenuOpen, settingsOpen, videoModeOpen])

  const editor = (
    <section
      className="canvas-node-generator-anchor nodrag nowheel nopan"
      data-node-editor={kind}
      onClick={(event) => event.stopPropagation()}
      onFocusCapture={() => beginSettingsInteraction()}
      onPointerDown={(event) => {
        beginSettingsInteraction()
        event.stopPropagation()
      }}
      onPointerLeave={endSettingsInteraction}
    >
      <div
        className="canvas-node-generator"
        data-viewport-clamped="true"
        ref={panelRef}
        style={
          {
            '--generator-shift-x': `${panelShift.x}px`,
            '--generator-shift-y': `${panelShift.y}px`,
          } as CSSProperties
        }
      >
        <div className="canvas-node-generator__toolbar">
          {kind === 'image' && editContent ? <div className="canvas-node-generator__modes" role="tablist" aria-label="图片操作模式"><button aria-selected={mode === 'generate'} onClick={() => onModeChange?.('generate')} role="tab" type="button">生成</button><button aria-selected={mode === 'edit'} onClick={() => onModeChange?.('edit')} role="tab" type="button">编辑</button></div> : null}
          <div className="canvas-node-generator__tools">
            {mode === 'generate' ? tools.map(({ id, label, icon: Icon }) => (
              <button
                aria-label={id === 'reference' ? '参考拾取模式' : label}
                aria-pressed={
                  referencePickerActive
                }
                className="canvas-node-generator__tool"
                data-active={
                  referencePickerActive
                }
                key={id}
                onClick={() => {
                  onReferencePickerChange?.(nodeId, !referencePickerActive)
                }}
                title={id === 'reference' ? '从画布选择参考图片' : label}
                type="button"
              >
                <Icon aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            )) : versionControl}
            {mode === 'generate' && kind === 'video' && captureFrameAvailable ?
              (['first', 'current', 'last'] as const).map((capture) => {
                const label = capture === 'first' ? '首帧' : capture === 'last' ? '尾帧' : '当前帧'
                return <button aria-label={`截取${label}`} className="canvas-node-generator__tool"
                  key={capture} onClick={() => onCaptureFrame?.(capture)} title={`截取${label}`} type="button">
                  <Camera aria-hidden="true" size={12} strokeWidth={1.8} /><span>{label}</span>
                </button>
              }) : null}
          </div>
          <div className="canvas-node-generator__toolbar-meta">
            {providerState?.catalogSyncing ? (
              <span className="canvas-node-generator__sync" role="status">
                <RefreshCw aria-hidden="true" size={11} />
                同步中
              </span>
            ) : catalog && catalogNeedsSync ? (
              <span className="canvas-node-generator__sync">使用缓存目录</span>
            ) : null}
            <button
              aria-label={expanded ? '收起节点编辑器' : '展开节点编辑器'}
              className="canvas-node-generator__expand"
              id={`node-editor-expand-${nodeId}`}
              onClick={() => expanded ? closeExpanded() : setExpanded(true)}
              title={expanded ? '收起节点编辑器' : '展开节点编辑器'}
              type="button"
            >
              {expanded ? (
                <Minimize2 size={14} strokeWidth={1.7} />
              ) : (
                <Maximize2 size={14} strokeWidth={1.7} />
              )}
            </button>
          </div>
        </div>

        {mode === 'generate' ? <><ReferenceStrip
          limits={referenceLimits}
          nodeId={nodeId}
          onPicker={onReferencePickerChange}
          onRemove={(targetNodeId, sourceNodeId) => {
            if (!beginSettingsInteraction()) return
            void runReferenceMutation(() =>
              onRemoveReference?.(targetNodeId, sourceNodeId) ?? Promise.resolve(undefined),
            )
          }}
          pickerActive={referencePickerActive}
          references={references}
        />

        <ReferencePromptEditor
          candidates={candidates}
          invalidAliases={invalidMentionAliases}
          label={kind === 'image' ? '图片生成描述' : '视频生成描述'}
          onAttachReference={(sourceNodeId) =>
            beginSettingsInteraction()
              ? runReferenceMutation(() =>
                  onAttachReference?.(nodeId, sourceNodeId) ?? Promise.resolve(undefined),
                )
              : Promise.resolve(undefined)
          }
          onChange={(nextPrompt) => {
            if (!beginSettingsInteraction()) return
            setPrompt(nextPrompt)
            onPromptChange?.(nodeId, nextPrompt)
          }}
          placeholder={placeholder}
          prompt={prompt}
          references={references}
        />

        {interactionLockMessage ? (
          <p className="canvas-node-generator__lock-message" role="status">
            {interactionLockMessage}
          </p>
        ) : null}

        {visibleError ? (
          <div className="canvas-node-generator__error" role="alert">
            <span>{visibleError.message}</span>
          </div>
        ) : catalogDifference ? (
          <p className="canvas-node-generator__catalog-diff" role="status">
            {catalogDifference}
          </p>
        ) : !validation.valid && selectedModel ? (
          <p className="canvas-node-generator__validation" role="status">
            {validation.message}
          </p>
        ) : null}

        <div className="canvas-node-generator__footer">
          {(providerState?.providers.length ?? 0) > 1 ? (
            <>
              <div className="canvas-node-generator__menu-control">
                <button
                  aria-expanded={providerMenuOpen}
                  aria-label="选择生成平台"
                  className="canvas-node-generator__select"
                  data-active={providerMenuOpen}
                  disabled={providerState?.loading}
                  onClick={() => {
                    setProviderMenuOpen((open) => !open)
                    setModelMenuOpen(false)
                    setVideoModeOpen(false)
                    setSettingsOpen(false)
                  }}
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    providerInitialFocusRef.current =
                      event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first'
                    setProviderMenuOpen(true)
                  }}
                  ref={providerTriggerRef}
                  type="button"
                >
                  <ServerCog size={14} strokeWidth={1.8} />
                  <span>{providerState?.selectedProvider?.name ?? '选择平台'}</span>
                  <ChevronDown size={11} />
                </button>
                {providerMenuOpen ? (
                  <FloatingChoiceMenu
                    anchor={providerTriggerRef.current}
                    ariaLabel="生成平台"
                    className="canvas-node-generator__choice-menu canvas-node-generator__provider-menu"
                    menuRef={providerMenuRef}
                    onKeyDown={(event) => handleChoiceMenuKeyDown(
                      event,
                      () => setProviderMenuOpen(false),
                      providerTriggerRef.current,
                    )}
                    portalRoot={expanded ? expandedDialogRef.current : undefined}
                  >
                    {providerState?.providers.map((candidate) => (
                      <button
                        key={candidate.id}
                        onClick={() => void switchProvider(candidate.id)}
                        role="menuitem"
                        type="button"
                      >
                        <span>
                          <strong>{candidate.name}</strong>
                          <small>
                            {candidate.available
                              ? '可生成'
                              : candidate.enabled
                                ? '待配置密钥'
                                : '未启用'}
                          </small>
                        </span>
                        {providerState?.selectedProviderId === candidate.id
                          ? <Check aria-hidden="true" />
                          : null}
                      </button>
                    ))}
                  </FloatingChoiceMenu>
                ) : null}
              </div>
              <span className="canvas-node-generator__divider" />
            </>
          ) : null}
          <div className="canvas-node-generator__menu-control">
            <button
              aria-expanded={modelMenuOpen}
              aria-label={kind === 'image' ? '选择图片模型' : '选择视频模型'}
              className="canvas-node-generator__select"
              data-active={modelMenuOpen}
              disabled={models.length === 0}
              onClick={() => {
                setModelMenuOpen((open) => !open)
                setVideoModeOpen(false)
                setSettingsOpen(false)
              }}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                modelInitialFocusRef.current =
                  event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first'
                setModelMenuOpen(true)
              }}
              ref={modelTriggerRef}
              type="button"
            >
              {kind === 'image' ? (
                <WandSparkles size={14} strokeWidth={1.8} />
              ) : (
                <Video size={14} strokeWidth={1.8} />
              )}
              <span>{selectedModel ? modelTitle(selectedModel) : '等待模型目录'}</span>
              <ChevronDown size={11} />
            </button>
            {modelMenuOpen ? (
              <FloatingChoiceMenu
                anchor={modelTriggerRef.current}
                ariaLabel={kind === 'image' ? '图片模型' : '视频模型'}
                className="canvas-node-generator__choice-menu canvas-node-generator__model-menu"
                menuRef={modelMenuRef}
                onKeyDown={(event) => handleChoiceMenuKeyDown(
                  event,
                  () => setModelMenuOpen(false),
                  modelTriggerRef.current,
                )}
                portalRoot={expanded ? expandedDialogRef.current : undefined}
              >
                {models.map((model) => (
                  <button
                    key={`${model.channel}-${model.model}`}
                    onClick={() => {
                      if (!catalog) return
                      const next = normalizeSettingsForModel(
                        resolvedSettings,
                        model,
                        catalog.version,
                        catalog.providerId,
                      )
                      handleSettingsChange(next)
                      setModelMenuOpen(false)
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span>
                      <strong>{modelTitle(model)}</strong>
                      <small>{model.channelDescription ?? model.channelTitle ?? model.model}</small>
                    </span>
                    {selectedModel?.model === model.model &&
                    String(selectedModel.channel) === String(model.channel)
                      ? <Check aria-hidden="true" />
                      : null}
                  </button>
                ))}
              </FloatingChoiceMenu>
            ) : null}
          </div>
          {kind === 'video' ? (
            <>
              <span className="canvas-node-generator__divider" />
              <div className="canvas-node-generator__menu-control">
                <button
                  aria-expanded={videoModeOpen}
                  aria-label={`视频生成模式：${selectedVideoMode?.label ?? '未配置'}`}
                  className="canvas-node-generator__select"
                  data-active={videoModeOpen}
                  disabled={videoModes.length === 0}
                  onClick={() => {
                    setVideoModeOpen((open) => !open)
                    setModelMenuOpen(false)
                    setSettingsOpen(false)
                  }}
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    modeInitialFocusRef.current =
                      event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first'
                    setVideoModeOpen(true)
                  }}
                  ref={modeTriggerRef}
                  type="button"
                >
                  <span>{selectedVideoMode?.label ?? '未配置'}</span>
                  <ChevronDown size={11} />
                </button>
                {videoModeOpen ? (
                  <FloatingChoiceMenu
                    anchor={modeTriggerRef.current}
                    ariaLabel="视频生成模式"
                    className="canvas-node-generator__choice-menu canvas-node-generator__mode-menu"
                    menuRef={modeMenuRef}
                    onKeyDown={(event) => handleChoiceMenuKeyDown(
                      event,
                      () => setVideoModeOpen(false),
                      modeTriggerRef.current,
                    )}
                    portalRoot={expanded ? expandedDialogRef.current : undefined}
                  >
                    {videoModes.map((mode) => (
                      <button
                        key={mode.value}
                        onClick={() => {
                          if (resolvedSettings.kind === 'video') {
                            handleSettingsChange({ ...resolvedSettings, mode: mode.value })
                          }
                          setVideoModeOpen(false)
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <span>{mode.label}</span>
                        {selectedVideoMode?.value === mode.value ? <Check aria-hidden="true" /> : null}
                      </button>
                    ))}
                  </FloatingChoiceMenu>
                ) : null}
              </div>
            </>
          ) : null}
          <span className="canvas-node-generator__divider" />
          <div className="canvas-node-generator__settings-control">
            <button
              aria-expanded={settingsOpen}
              aria-label={settingsLabel}
              className="canvas-node-generator__select"
              data-active={settingsOpen}
              disabled={!selectedModel}
              onClick={() => {
                setSettingsOpen((open) => !open)
                setModelMenuOpen(false)
                setVideoModeOpen(false)
              }}
              ref={settingsTriggerRef}
              type="button"
            >
              <span>{settingsSummary}</span>
              {resolvedSettings.kind === 'video' ? (
                <>
                  <span aria-hidden="true">·</span>
                  {resolvedSettings.generateAudio ? (
                    <Volume2 aria-hidden="true" size={12} />
                  ) : (
                    <VolumeX aria-hidden="true" size={12} />
                  )}
                </>
              ) : null}
              <ChevronDown aria-hidden="true" size={11} />
            </button>
            {settingsOpen ? (
              <GenerationSettingsPopover
                anchor={settingsTriggerRef.current}
                kind={kind}
                model={selectedModel}
                onChange={handleSettingsChange}
                portalRoot={expanded ? expandedDialogRef.current : undefined}
                settings={resolvedSettings}
              />
            ) : null}
          </div>
          <span className="canvas-node-generator__spacer" />
          {selectedModel ? (
            <span className="canvas-node-generator__cost" title="预计生成积分">
              {estimatedCredits} 积分
            </span>
          ) : null}
          <span
            aria-live="polite"
            className="canvas-node-generator__status"
            data-active={Boolean(progressLabel || pending)}
          >
            {pending && !progressLabel
              ? recoverable
                ? '等待恢复'
                : '提交中'
              : progressLabel}
          </span>
          <button
            aria-label={submitLabel}
            className="canvas-node-generator__submit"
            disabled={
              recoverable
                ? false
                : !prompt.trim() ||
                  providerUnavailable ||
                  catalogChanged ||
                  !validation.valid ||
                  submissionGuarded ||
                  (pending && !recoverable) ||
                  (!pending && generation?.status === 'generating')
            }
            onClick={submit}
            title={validation.valid ? submitLabel : validation.message}
            type="button"
          >
            <ArrowUp size={17} strokeWidth={2} />
          </button>
        </div></> : <div className="canvas-node-generator__edit-workspace">{editContent}</div>}
      </div>
    </section>
  )

  return (
    <>
      {!expanded ? editor : null}
      {expanded
        ? createPortal(
            <div
              className="canvas-node-editor-backdrop nodrag nowheel nopan"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeExpanded()
              }}
            >
              <div
                aria-label="节点编辑器"
                aria-modal="true"
                className="canvas-node-editor-dialog"
                onKeyDown={(event) => {
                  if (event.key !== 'Tab') return
                  const focusable = Array.from(
                    event.currentTarget.querySelectorAll<HTMLElement>(
                      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
                    ),
                  )
                  if (focusable.length === 0) return
                  const first = focusable[0]!
                  const last = focusable.at(-1)!
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                }}
                ref={expandedDialogRef}
                role="dialog"
              >
                {editor}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
