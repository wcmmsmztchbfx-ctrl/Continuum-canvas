import { useRef } from 'react'
import {
  Cable,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Settings2,
  TestTube2,
  X,
} from 'lucide-react'

import { GENERATION_ADAPTER_TYPES } from '../../contracts/catalog'
import { useOptionalProviderCatalog } from '../providers/ProviderCatalogContext'
import type { ControlledOverlayProps } from './primitives'
import { usePopoverClose } from './usePopoverClose'

export interface ApiIntegrationPopoverProps extends ControlledOverlayProps {
  onManage?: () => void
  onUnavailable?: () => void
}

function formatSyncTime(value?: string): string {
  if (!value) return '从未同步'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '同步时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function ApiIntegrationPopover({
  onClose,
  onManage,
  onUnavailable,
  open,
}: ApiIntegrationPopoverProps) {
  const surfaceRef = useRef<HTMLElement | null>(null)
  const providers = useOptionalProviderCatalog()
  const current = providers?.preferredProvider ?? providers?.selectedProvider
  const catalog = providers?.catalog
  const catalogStatus = catalog?.stale
    ? '需要同步'
    : catalog
      ? `${catalog.models.length} 个模型`
      : current?.secretConfigured
        ? '目录尚未同步'
        : '配置密钥后同步目录'
  usePopoverClose(open, onClose, surfaceRef)

  if (!open) return null

  const runTest = () => {
    if (providers && current) void providers.testProvider(current.id)
    else onUnavailable?.()
  }
  const runSync = () => {
    if (providers && current) void providers.syncProvider(current.id)
    else onUnavailable?.()
  }

  return (
    <section
      aria-label="API 接入"
      className="overlay-surface integration-popover api-integration-popover"
      ref={surfaceRef}
      role="dialog"
    >
      <header className="integration-popover__header">
        <div>
          <Cable aria-hidden="true" focusable="false" />
          <strong>API 接入</strong>
          <span
            className="integration-status"
            data-tone={current?.available ? 'online' : 'idle'}
          >
            {current?.available ? '可生成' : '待配置'}
          </span>
        </div>
        <button
          aria-label="关闭 API 接入"
          className="overlay-icon-button"
          onClick={onClose}
          title="关闭 API 接入"
          type="button"
        >
          <X aria-hidden="true" focusable="false" />
        </button>
      </header>

      <div className="provider-summary">
        {providers?.loading ? (
          <div className="provider-summary__empty">正在读取本地接入配置</div>
        ) : current ? (
          <>
            <div className="provider-summary__title">
              <span className="provider-summary__mark">
                {current.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{current.name}</strong>
                <small>{current.adapterType}</small>
              </div>
              {current.preferred ? <span>首选</span> : null}
            </div>
            <dl className="provider-summary__meta">
              <div>
                <dt><KeyRound aria-hidden="true" />密钥</dt>
                <dd>{current.secretConfigured ? '已配置密钥' : '未配置'}</dd>
              </div>
              {current.maskedSecret ? (
                <div>
                  <dt>掩码</dt>
                  <dd className="provider-summary__secret">{current.maskedSecret}</dd>
                </div>
              ) : null}
              <div>
                <dt><RefreshCw aria-hidden="true" />最近同步</dt>
                <dd>{formatSyncTime(current.lastSyncedAt)}</dd>
              </div>
              <div>
                <dt><CheckCircle2 aria-hidden="true" />目录</dt>
                <dd>{catalogStatus}</dd>
              </div>
            </dl>
            {!current.available ? (
              <p className="provider-summary__warning">
                {!GENERATION_ADAPTER_TYPES.has(current.adapterType)
                  ? '当前适配器不支持生成'
                  : '启用供应商并配置密钥后可生成'}
              </p>
            ) : null}
          </>
        ) : (
          <div className="provider-summary__empty">尚未添加供应商</div>
        )}
        {providers?.error ? (
          <p className="provider-summary__warning">{providers.error}</p>
        ) : null}
      </div>

      <footer className="integration-popover__actions integration-popover__actions--split">
        <div>
          <button
            className="overlay-text-button"
            disabled={!current || providers?.busyAction === `test:${current.id}`}
            onClick={runTest}
            type="button"
          >
            <TestTube2 aria-hidden="true" />
            快速测试
          </button>
          <button
            className="overlay-text-button"
            disabled={!current || providers?.busyAction === `sync:${current.id}`}
            onClick={runSync}
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            同步配置
          </button>
        </div>
        <button
          className="overlay-primary-button"
          onClick={onManage ?? onUnavailable}
          type="button"
        >
          <Settings2 aria-hidden="true" />
          管理接入
        </button>
      </footer>
    </section>
  )
}
