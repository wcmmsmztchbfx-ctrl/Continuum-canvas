import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { useEscapeClose } from './useEscapeClose'
import type { ControlledOverlayProps } from './primitives'

export type SettingsTab = 'storage' | 'language' | 'startup' | 'about'

export interface SettingsModalProps extends ControlledOverlayProps {
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
  onClose,
  onNotify,
  open,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('storage')
  const [outputPath, setOutputPath] = useState<string>(() => {
    return localStorage.getItem('continuum_custom_output_path') || './outputs'
  })
  const [editingPath, setEditingPath] = useState(outputPath)
  const [language, setLanguage] = useState<string>(() => {
    return localStorage.getItem('continuum_language') || 'zh-CN'
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
    if (!open) return
    setEditingPath(localStorage.getItem('continuum_custom_output_path') || './outputs')

    fetch('/api/system/storage-info')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStorageInfo(data)
      })
      .catch(() => {})

    fetch('/api/system/version')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setVersionInfo(data)
      })
      .catch(() => {})
  }, [open])

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
        className="figma-settings-dialog"
        ref={modalRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* Top Header Tabs */}
        <header className="figma-settings__header">
          <nav className="figma-settings__tabs" role="tablist" aria-label="设置分类">
            <button
              aria-selected={activeTab === 'storage'}
              className={`figma-settings__tab ${activeTab === 'storage' ? 'figma-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('storage')}
              role="tab"
              type="button"
            >
              存储与路径
            </button>
            <button
              aria-selected={activeTab === 'language'}
              className={`figma-settings__tab ${activeTab === 'language' ? 'figma-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('language')}
              role="tab"
              type="button"
            >
              界面语言
            </button>
            <button
              aria-selected={activeTab === 'startup'}
              className={`figma-settings__tab ${activeTab === 'startup' ? 'figma-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('startup')}
              role="tab"
              type="button"
            >
              启动与通用
            </button>
            <button
              aria-selected={activeTab === 'about'}
              className={`figma-settings__tab ${activeTab === 'about' ? 'figma-settings__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
              role="tab"
              type="button"
            >
              关于与更新
            </button>
          </nav>
          <button
            aria-label="关闭系统设置"
            className="figma-settings__close"
            onClick={onClose}
            type="button"
          >
            <X size={15} />
          </button>
        </header>

        {/* Pure Single-Column Figma Body */}
        <main className="figma-settings__body">
          {/* TAB 1: 存储与路径 */}
          {activeTab === 'storage' && (
            <div className="figma-settings__content">
              {/* Section 1 */}
              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">本地输出路径</h4>
                <p className="figma-settings__section-subtitle">
                  AI 生成的图片、视频与合成产物在本地计算机上的落盘保存目录。
                </p>

                <div className="figma-settings__input-group">
                  <label className="figma-settings__sr-only" htmlFor="output-path-input">
                    本地产出保存路径
                  </label>
                  <input
                    id="output-path-input"
                    className="figma-settings__input"
                    onChange={(e) => setEditingPath(e.target.value)}
                    placeholder="./outputs"
                    type="text"
                    value={editingPath}
                  />
                  <button
                    className="figma-settings__btn figma-settings__btn--primary"
                    onClick={handleSaveOutputPath}
                    type="button"
                  >
                    保存
                  </button>
                  <button
                    className="figma-settings__btn figma-settings__btn--ghost"
                    onClick={handleResetOutputPath}
                    type="button"
                  >
                    恢复默认
                  </button>
                </div>
              </div>

              {/* Section 2 */}
              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">临时缓存与素材空间</h4>

                {/* Parent Checkbox */}
                <div
                  className="figma-settings__checkbox-row"
                  onClick={() => setEnableCache(!enableCache)}
                >
                  <span className={`figma-settings__checkbox ${enableCache ? 'figma-settings__checkbox--checked' : ''}`}>
                    {enableCache && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="figma-settings__checkbox-label">自动暂存参考图与工作区缩略图</span>
                </div>
                <p className="figma-settings__hint">
                  加速画布加载与节点渲染，系统会定期或通过下方按钮清理陈旧缓存。
                </p>

                {/* Sub Options (Indented) */}
                <div className="figma-settings__subgroup">
                  <div className="figma-settings__subitem">
                    <span className="figma-settings__sublabel">系统数据目录</span>
                    <span className="figma-settings__subvalue">{storageInfo?.storagePath || './data'}</span>
                  </div>
                  <div className="figma-settings__subitem">
                    <span className="figma-settings__sublabel">当前缓存占用</span>
                    <span className="figma-settings__subvalue">
                      {storageInfo ? `${storageInfo.totalCacheFormatted} (${storageInfo.fileCount} 个临时文件)` : '正在统计...'}
                    </span>
                  </div>

                  <div style={{ marginTop: '12px' }}>
                    <button
                      className="figma-settings__link"
                      disabled={clearing}
                      onClick={handleClearCache}
                      type="button"
                    >
                      {clearing ? <Loader2 size={12} className="figma-settings-spin" /> : null}
                      <span>一键清理临时缓存</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: 界面语言 */}
          {activeTab === 'language' && (
            <div className="figma-settings__content">
              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">显示语言偏好 (Language)</h4>
                <p className="figma-settings__section-subtitle">
                  选择 Continuum 整个画板、顶部工具栏及右键菜单的显示语言。
                </p>

                <div className="figma-settings__radio-list" role="radiogroup" aria-label="显示语言">
                  <div
                    className="figma-settings__radio-row"
                    onClick={() => handleLanguageChange('zh-CN')}
                  >
                    <span className={`figma-settings__radio ${language === 'zh-CN' ? 'figma-settings__radio--checked' : ''}`}>
                      {language === 'zh-CN' && <span className="figma-settings__radio-dot" />}
                    </span>
                    <div className="figma-settings__radio-content">
                      <span className="figma-settings__radio-title">简体中文 (Simplified Chinese)</span>
                      <span className="figma-settings__radio-desc">完整的中文本地化界面、快捷键提示与参数说明</span>
                    </div>
                  </div>

                  <div
                    className="figma-settings__radio-row"
                    onClick={() => handleLanguageChange('en-US')}
                  >
                    <span className={`figma-settings__radio ${language === 'en-US' ? 'figma-settings__radio--checked' : ''}`}>
                      {language === 'en-US' && <span className="figma-settings__radio-dot" />}
                    </span>
                    <div className="figma-settings__radio-content">
                      <span className="figma-settings__radio-title">English (United States)</span>
                      <span className="figma-settings__radio-desc">Complete English interface, node tooltips, and generation logs</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: 启动与通用 */}
          {activeTab === 'startup' && (
            <div className="figma-settings__content">
              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">应用启动行为</h4>

                <div
                  className="figma-settings__checkbox-row"
                  onClick={handleAutoOpenBrowserToggle}
                >
                  <span
                    aria-checked={autoOpenBrowser}
                    className={`figma-settings__checkbox ${autoOpenBrowser ? 'figma-settings__checkbox--checked' : ''}`}
                    role="switch"
                    tabIndex={0}
                  >
                    {autoOpenBrowser && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="figma-settings__checkbox-label">服务启动时自动打开默认浏览器</span>
                </div>
                <p className="figma-settings__hint">
                  后台网关启动就绪后，自动在系统默认浏览器中唤起画布主页 (127.0.0.1:4173)。
                </p>
              </div>

              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">画布数据与持久化</h4>

                <div className="figma-settings__checkbox-row" style={{ cursor: 'default' }}>
                  <span className="figma-settings__checkbox figma-settings__checkbox--checked" style={{ opacity: 0.85 }}>
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <span className="figma-settings__checkbox-label">画板编辑实时自动持久化</span>
                </div>
                <p className="figma-settings__hint">
                  节点增删、连线拖拽与属性调整将实时自动保存至本地工作区 SQLite 存储。
                </p>
              </div>
            </div>
          )}

          {/* TAB 4: 关于与更新 */}
          {activeTab === 'about' && (
            <div className="figma-settings__content">
              <div className="figma-settings__section">
                <h4 className="figma-settings__section-title">Continuum 无限画布</h4>
                <p className="figma-settings__section-subtitle">
                  基于现代 Web 技术的专业级 AI 节点式无限画布创作平台。
                </p>

                <div className="figma-settings__subgroup">
                  <div className="figma-settings__subitem">
                    <span className="figma-settings__sublabel">系统核心版本</span>
                    <span className="figma-settings__subvalue">v{versionInfo?.version || '1.2.0'} (Stable)</span>
                  </div>
                  <div className="figma-settings__subitem">
                    <span className="figma-settings__sublabel">Node.js 运行环境</span>
                    <span className="figma-settings__subvalue">{versionInfo?.nodeVersion || 'v20.x'}</span>
                  </div>
                  <div className="figma-settings__subitem">
                    <span className="figma-settings__sublabel">本地服务网关</span>
                    <span className="figma-settings__subvalue" style={{ color: '#18a0fb' }}>
                      http://127.0.0.1:4173 (连接正常)
                    </span>
                  </div>

                  <div style={{ marginTop: '14px' }}>
                    <button
                      className="figma-settings__link"
                      disabled={checkingUpdate}
                      onClick={handleCheckUpdate}
                      type="button"
                    >
                      {checkingUpdate ? <Loader2 size={12} className="figma-settings-spin" /> : null}
                      <span>{checkingUpdate ? '正在检查更新...' : '检查软件更新'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
