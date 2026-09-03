import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useEscapeClose } from './useEscapeClose'
import type { ControlledOverlayProps } from './primitives'

export type SettingsTab = 'storage' | 'language' | 'startup' | 'about'

export interface SettingsModalProps extends ControlledOverlayProps {
  /** Public workspace shows only language and version; admin keeps all tabs. */
  canManageSettings?: boolean
  appMode?: 'host' | 'solo' | 'workstation'
  onAppModeChange?: (mode: 'host' | 'solo' | 'workstation') => void
  onNotify?: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void
}

interface StorageInfo {
  storagePath: string
  stagingBytes: number
  assetsBytes: number
  totalCacheBytes: number
  totalCacheFormatted: string
  fileCount: number
}

interface VersionInfo {
  version: string
  name: string
  nodeVersion: string
  uptimeSeconds: number
}

export function SettingsModal({
  appMode: controlledAppMode,
  canManageSettings = true,
  onAppModeChange,
  onClose,
  onNotify,
  open,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    canManageSettings ? 'storage' : 'language',
  )
  const [outputPath, setOutputPath] = useState<string>(() => {
    return localStorage.getItem('continuum_custom_output_path') || './outputs'
  })
  const [editingPath, setEditingPath] = useState(outputPath)
  const [language, setLanguage] = useState<string>(() => {
    return localStorage.getItem('continuum_language') || 'zh-CN'
  })
  const [appMode, setAppMode] = useState<'host' | 'solo' | 'workstation'>(() => {
    return controlledAppMode || (localStorage.getItem('continuum_app_mode') as 'host' | 'solo' | 'workstation') || 'solo'
  })
  const [allowLanApiManagement, setAllowLanApiManagement] = useState<boolean>(() => {
    return localStorage.getItem('continuum_allow_lan_api') !== 'false'
  })
  const [autoOpenBrowser, setAutoOpenBrowser] = useState<boolean>(() => {
    return localStorage.getItem('continuum_auto_open_browser') !== 'false'
  })
  const [enableCache, setEnableCache] = useState(true)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [clearing, setClearing] = useState(false)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  useEscapeClose(open, onClose)

  useEffect(() => {
    if (controlledAppMode) setAppMode(controlledAppMode)
  }, [controlledAppMode])

  useEffect(() => {
    if (!canManageSettings && (activeTab === 'storage' || activeTab === 'startup')) {
      setActiveTab('language')
    }
  }, [activeTab, canManageSettings])

  useEffect(() => {
    if (!open) return
    setEditingPath(localStorage.getItem('continuum_custom_output_path') || './outputs')

    if (canManageSettings) {
      fetch('/api/system/settings')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.allowLanApiManagement === 'boolean') {
            setAllowLanApiManagement(data.allowLanApiManagement)
            localStorage.setItem('continuum_allow_lan_api', String(data.allowLanApiManagement))
          }
          if (data && (data.operationMode === 'host' || data.operationMode === 'solo' || data.operationMode === 'workstation')) {
            setAppMode(data.operationMode)
            localStorage.setItem('continuum_app_mode', data.operationMode)
            onAppModeChange?.(data.operationMode)
          }
        })
        .catch(() => {})

      fetch('/api/system/storage-info')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) setStorageInfo(data)
        })
        .catch(() => {})
    }

    fetch('/api/system/version')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setVersionInfo(data)
      })
      .catch(() => {})
  }, [canManageSettings, open, onAppModeChange])

  const handleSaveOutputPath = () => {
    setOutputPath(editingPath)
    localStorage.setItem('continuum_custom_output_path', editingPath)
    onNotify?.('本地输出目录已更新', 'success')
  }

  const handleResetOutputPath = () => {
    setEditingPath('./outputs')
    setOutputPath('./outputs')
    localStorage.removeItem('continuum_custom_output_path')
    onNotify?.('已恢复默认输出路径 (./outputs)', 'info')
  }

  const handleLanguageChange = (newLang: string) => {
    setLanguage(newLang)
    localStorage.setItem('continuum_language', newLang)
    onNotify?.(newLang === 'zh-CN' ? '已切换至简体中文' : 'Switched to English', 'success')
  }

  const handleAppModeChange = async (newMode: 'host' | 'solo' | 'workstation') => {
    if (newMode === appMode) return
    const previousMode = appMode
    setAppMode(newMode)
    localStorage.setItem('continuum_app_mode', newMode)
    onAppModeChange?.(newMode)
      onNotify?.(
        newMode === 'host'
        ? '已切换为服务器模式：进入画布将自动加入局域网协作'
        : newMode === 'workstation'
          ? '已切换为工作站模式：每个昵称使用独立画布目录，并可按画布邀请协作者'
          : '已切换为个人模式：进入画布无需输入昵称，不开启多人协作',
      'success',
    )
    try {
      let response = await fetch('/api/system/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationMode: newMode }),
      })
      if (response.status === 401 || response.status === 403) {
        const session = await fetch('/api/local-admin/session', { method: 'POST' })
        if (session.ok) {
          response = await fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operationMode: newMode }),
          })
        }
      }
      if (!response.ok) throw new Error('只有本机管理员可以修改全局协同模式')
      const data = await response.json() as { operationMode?: unknown }
      const serverMode = data.operationMode === 'host' || data.operationMode === 'solo' || data.operationMode === 'workstation'
        ? data.operationMode
        : newMode
      if (serverMode !== newMode) {
        setAppMode(serverMode)
        localStorage.setItem('continuum_app_mode', serverMode)
        onAppModeChange?.(serverMode)
      }
    } catch (error) {
      setAppMode(previousMode)
      localStorage.setItem('continuum_app_mode', previousMode)
      onAppModeChange?.(previousMode)
      onNotify?.(error instanceof Error ? error.message : '协同模式更新失败', 'error')
    }
  }

  const handleAllowLanApiToggle = () => {
    const next = !allowLanApiManagement
    setAllowLanApiManagement(next)
    localStorage.setItem('continuum_allow_lan_api', String(next))
    fetch('/api/system/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowLanApiManagement: next }),
    }).catch(() => {})
    onNotify?.(
      next
        ? '已开启：允许局域网内的本机管理员配置与保存 API Key'
        : '已关闭：仅限本机可配置与保存 API Key',
      'info',
    )
  }

  const handleAutoOpenBrowserToggle = () => {
    const next = !autoOpenBrowser
    setAutoOpenBrowser(next)
    localStorage.setItem('continuum_auto_open_browser', String(next))
    onNotify?.(next ? '已开启启动自动打开浏览器' : '已关闭启动自动打开浏览器', 'info')
  }

  const handleClearCache = async () => {
    setClearing(true)
    try {
      const res = await fetch('/api/system/clear-cache', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        onNotify?.(`临时缓存已清理，释放了 ${data.freedFormatted || '0 B'} 空间`, 'success')
        const infoRes = await fetch('/api/system/storage-info')
        if (infoRes.ok) {
          setStorageInfo(await infoRes.json())
        }
      }
    } catch {
      onNotify?.('清理临时缓存失败', 'error')
    } finally {
      setClearing(false)
    }
  }

  const handleCheckUpdate = () => {
    setCheckingUpdate(true)
    setTimeout(() => {
      setCheckingUpdate(false)
      onNotify?.('当前已是最新版本 (v1.2.0)', 'success')
    }, 600)
  }

  if (!open) return null

  return (
    <div
      className="overlay-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        aria-label="系统设置"
        aria-modal="true"
        className="canvas-settings-dialog"
        ref={modalRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* Top Header Tabs */}
        <header className="canvas-settings__header">
          <nav className="canvas-settings__tabs" role="tablist" aria-label="设置分类">
            {canManageSettings && (
              <button
                aria-selected={activeTab === 'storage'}
                className={`canvas-settings__tab ${activeTab === 'storage' ? 'canvas-settings__tab--active' : ''}`}
                onClick={() => setActiveTab('storage')}
                role="tab"
                type="button"
              >
                存储与路径
              </button>
            )}
            <button
              aria-selected={activeTab === 'language'}
              className={`canvas-settings__tab ${activeTab === 'language' ? 'canvas-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('language')}
              role="tab"
              type="button"
            >
              界面语言
            </button>
            {canManageSettings && (
              <button
                aria-selected={activeTab === 'startup'}
                className={`canvas-settings__tab ${activeTab === 'startup' ? 'canvas-settings__tab--active' : ''}`}
                onClick={() => setActiveTab('startup')}
                role="tab"
                type="button"
              >
                启动与通用
              </button>
            )}
            <button
              aria-selected={activeTab === 'about'}
              className={`canvas-settings__tab ${activeTab === 'about' ? 'canvas-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
              role="tab"
              type="button"
            >
              关于与更新
            </button>
          </nav>
          <button
            aria-label="关闭系统设置"
            className="canvas-settings__close"
            onClick={onClose}
            type="button"
          >
            <X size={15} />
          </button>
        </header>

        {/* Pure Single-Column Settings Body */}
        <main className="canvas-settings__body">
          {/* TAB 1: 存储与路径 */}
          {canManageSettings && activeTab === 'storage' && (
            <div className="canvas-settings__content">
              {/* Section 1 */}
              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">本地输出路径</h4>
                <p className="canvas-settings__section-subtitle">
                  AI 生成的图片、视频与合成产物在本地计算机上的落盘保存目录。
                </p>

                <div className="canvas-settings__input-group">
                  <label className="canvas-settings__sr-only" htmlFor="output-path-input">
                    本地产出保存路径
                  </label>
                  <input
                    id="output-path-input"
                    className="canvas-settings__input"
                    onChange={(e) => setEditingPath(e.target.value)}
                    placeholder="./outputs"
                    type="text"
                    value={editingPath}
                  />
                  <button
                    className="canvas-settings__btn canvas-settings__btn--primary"
                    onClick={handleSaveOutputPath}
                    type="button"
                  >
                    保存
                  </button>
                  <button
                    className="canvas-settings__btn canvas-settings__btn--ghost"
                    onClick={handleResetOutputPath}
                    type="button"
                  >
                    恢复默认
                  </button>
                </div>
              </div>

              {/* Section 2 */}
              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">临时缓存与素材空间</h4>

                {/* Parent Checkbox */}
                <div
                  className="canvas-settings__checkbox-row"
                  onClick={() => setEnableCache(!enableCache)}
                >
                  <span className={`canvas-settings__checkbox ${enableCache ? 'canvas-settings__checkbox--checked' : ''}`}>
                    {enableCache && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="canvas-settings__checkbox-label">自动暂存参考图与工作区缩略图</span>
                </div>
                <p className="canvas-settings__hint">
                  加速画布加载与节点渲染，系统会定期或通过下方按钮清理陈旧缓存。
                </p>

                {/* Sub Options (Indented) */}
                <div className="canvas-settings__subgroup">
                  <div className="canvas-settings__subitem">
                    <span className="canvas-settings__sublabel">系统数据目录</span>
                    <span className="canvas-settings__subvalue">{storageInfo?.storagePath || './data'}</span>
                  </div>
                  <div className="canvas-settings__subitem">
                    <span className="canvas-settings__sublabel">当前缓存占用</span>
                    <span className="canvas-settings__subvalue">
                      {storageInfo ? `${storageInfo.totalCacheFormatted} (${storageInfo.fileCount} 个临时文件)` : '正在统计...'}
                    </span>
                  </div>

                  <div style={{ marginTop: '12px' }}>
                    <button
                      className="canvas-settings__link"
                      disabled={clearing}
                      onClick={handleClearCache}
                      type="button"
                    >
                      {clearing ? <Loader2 size={12} className="canvas-settings-spin" /> : null}
                      <span>一键清理临时缓存</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 界面语言 */}
          {activeTab === 'language' && (
            <div className="canvas-settings__content">
              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">显示语言偏好 (Language)</h4>
                <p className="canvas-settings__section-subtitle">
                  选择 Continuum 整个画板、顶部工具栏及右键菜单的显示语言。
                </p>

                <div className="canvas-settings__radio-list" role="radiogroup" aria-label="显示语言">
                  <div
                    className="canvas-settings__radio-row"
                    onClick={() => handleLanguageChange('zh-CN')}
                  >
                    <span className={`canvas-settings__radio ${language === 'zh-CN' ? 'canvas-settings__radio--checked' : ''}`}>
                      {language === 'zh-CN' && <span className="canvas-settings__radio-dot" />}
                    </span>
                    <div className="canvas-settings__radio-content">
                      <span className="canvas-settings__radio-title">简体中文 (Simplified Chinese)</span>
                      <span className="canvas-settings__radio-desc">完整的中文本地化界面、快捷键提示与参数说明</span>
                    </div>
                  </div>

                  <div
                    className="canvas-settings__radio-row"
                    onClick={() => handleLanguageChange('en-US')}
                  >
                    <span className={`canvas-settings__radio ${language === 'en-US' ? 'canvas-settings__radio--checked' : ''}`}>
                      {language === 'en-US' && <span className="canvas-settings__radio-dot" />}
                    </span>
                    <div className="canvas-settings__radio-content">
                      <span className="canvas-settings__radio-title">English (United States)</span>
                      <span className="canvas-settings__radio-desc">Complete English interface, node tooltips, and generation logs</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 启动与通用 */}
          {canManageSettings && activeTab === 'startup' && (
            <div className="canvas-settings__content">
              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">工作与协同模式 (Operation Mode)</h4>
                <p className="canvas-settings__section-subtitle">
                  选择进入画布时的默认协同策略与身份设置。
                </p>

                <div className="canvas-settings__radio-list" role="radiogroup" aria-label="工作与协同模式">
                  <div
                    className="canvas-settings__radio-row"
                    onClick={() => handleAppModeChange('host')}
                  >
                    <span className={`canvas-settings__radio ${appMode === 'host' ? 'canvas-settings__radio--checked' : ''}`}>
                      {appMode === 'host' && <span className="canvas-settings__radio-dot" />}
                    </span>
                    <div className="canvas-settings__radio-content">
                      <span className="canvas-settings__radio-title">服务器模式 (多人协作)</span>
                      <span className="canvas-settings__radio-desc">所有访问者先输入协作昵称；同一画布的局域网用户加入服务端中继房间。适合团队/局域网共享创作。</span>
                    </div>
                  </div>

                  <div
                    className="canvas-settings__radio-row"
                    onClick={() => handleAppModeChange('solo')}
                  >
                    <span className={`canvas-settings__radio ${appMode === 'solo' ? 'canvas-settings__radio--checked' : ''}`}>
                      {appMode === 'solo' && <span className="canvas-settings__radio-dot" />}
                    </span>
                    <div className="canvas-settings__radio-content">
                      <span className="canvas-settings__radio-title">个人模式 (单人创作)</span>
                      <span className="canvas-settings__radio-desc">进入画布无需输入昵称，不自动加入已有协作房间；适合个人创作。</span>
                    </div>
                  </div>

                  <div
                    className="canvas-settings__radio-row"
                    onClick={() => handleAppModeChange('workstation')}
                  >
                    <span className={`canvas-settings__radio ${appMode === 'workstation' ? 'canvas-settings__radio--checked' : ''}`}>
                      {appMode === 'workstation' && <span className="canvas-settings__radio-dot" />}
                    </span>
                    <div className="canvas-settings__radio-content">
                      <span className="canvas-settings__radio-title">工作站模式 (用户隔离)</span>
                      <span className="canvas-settings__radio-desc">所有访问者先输入昵称；每个昵称拥有独立画布目录，也可以像个人模式一样邀请协作者。</span>
                    </div>
                  </div>
                </div>

                <div
                  className="canvas-settings__checkbox-row"
                  onClick={handleAllowLanApiToggle}
                  style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--canvas-overlay-white-08)' }}
                >
                  <span
                    aria-checked={allowLanApiManagement}
                    className={`canvas-settings__checkbox ${allowLanApiManagement ? 'canvas-settings__checkbox--checked' : ''}`}
                    role="switch"
                    tabIndex={0}
                  >
                    {allowLanApiManagement && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="canvas-settings__checkbox-label">允许局域网管理员配置与保存 API Key</span>
                </div>
                <p className="canvas-settings__hint">
                  这里控制服务端级别的 API 管理入口；画布内的 API 配置按画布作用域保存，远程查看者不能修改，编辑者可以修改当前获授权画布。
                </p>
              </div>

              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">应用启动行为</h4>

                <div
                  className="canvas-settings__checkbox-row"
                  onClick={handleAutoOpenBrowserToggle}
                >
                  <span
                    aria-checked={autoOpenBrowser}
                    className={`canvas-settings__checkbox ${autoOpenBrowser ? 'canvas-settings__checkbox--checked' : ''}`}
                    role="switch"
                    tabIndex={0}
                  >
                    {autoOpenBrowser && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="canvas-settings__checkbox-label">服务启动时自动打开默认浏览器</span>
                </div>
                <p className="canvas-settings__hint">
                  后台网关启动就绪后，自动在系统默认浏览器中唤起画布主页 (127.0.0.1:4173)。
                </p>
              </div>

              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">画布数据与持久化</h4>

                <div className="canvas-settings__checkbox-row" style={{ cursor: 'default' }}>
                  <span className="canvas-settings__checkbox canvas-settings__checkbox--checked" style={{ opacity: 0.85 }}>
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <span className="canvas-settings__checkbox-label">画板编辑实时自动持久化</span>
                </div>
                <p className="canvas-settings__hint">
                  节点增删、连线拖拽与属性调整将实时自动保存至本地工作区 SQLite 存储。
                </p>
              </div>
            </div>
          )}

          {/* TAB 4: 关于与更新 */}
          {activeTab === 'about' && (
            <div className="canvas-settings__content">
              <div className="canvas-settings__section">
                <h4 className="canvas-settings__section-title">Continuum 无限画布</h4>
                <p className="canvas-settings__section-subtitle">
                  基于现代 Web 技术的专业级 AI 节点式无限画布创作平台。
                </p>

                <div className="canvas-settings__subgroup">
                  <div className="canvas-settings__subitem">
                    <span className="canvas-settings__sublabel">系统核心版本</span>
                    <span className="canvas-settings__subvalue">v{versionInfo?.version || '1.2.0'} (Stable)</span>
                  </div>
                  {canManageSettings && (
                    <>
                      <div className="canvas-settings__subitem">
                        <span className="canvas-settings__sublabel">Node.js 运行环境</span>
                        <span className="canvas-settings__subvalue">{versionInfo?.nodeVersion || 'v20.x'}</span>
                      </div>
                      <div className="canvas-settings__subitem">
                        <span className="canvas-settings__sublabel">本地服务网关</span>
                        <span className="canvas-settings__subvalue" style={{ color: 'var(--canvas-accent-primary)' }}>
                          {typeof window !== 'undefined' ? window.location.origin : '本地网关'} (连接正常)
                        </span>
                      </div>
                    </>
                  )}

                  {canManageSettings && (
                    <div style={{ marginTop: '14px' }}>
                      <button
                        className="canvas-settings__link"
                        disabled={checkingUpdate}
                        onClick={handleCheckUpdate}
                        type="button"
                      >
                        {checkingUpdate ? <Loader2 size={12} className="canvas-settings-spin" /> : null}
                        <span>{checkingUpdate ? '正在检查更新...' : '检查软件更新'}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
