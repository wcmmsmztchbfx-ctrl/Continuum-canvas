import { ProviderRequestRejectedError } from './provider-adapter.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function dataRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error('Provider returned an invalid response')
  return isRecord(payload.data) ? payload.data : payload
}

export function normalizedBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL must be HTTPS without credentials, query, or fragment')
  }
  return url.href.replace(/\/$/, '')
}

export function rejectionDetail(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {}
  const error = isRecord(payload.error) ? payload.error : undefined
  const data = isRecord(payload.data) ? payload.data : undefined
  const rawCode = payload.code ?? error?.code ?? data?.code
  const rawMessage = payload.message ?? payload.msg ?? error?.message ?? error?.msg ?? data?.message ?? data?.msg
  const code = typeof rawCode === 'string' || typeof rawCode === 'number'
    ? String(rawCode).slice(0, 64)
    : undefined
  const message = typeof rawMessage === 'string'
    ? [...rawMessage]
        .map((character) => {
          const point = character.codePointAt(0) ?? 0
          return point < 32 || point === 127 ? ' ' : character
        })
        .join('')
        .trim()
        .slice(0, 240)
    : undefined
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) }
}

export function rejectedRequest(payload: unknown, fallbackCode?: string): ProviderRequestRejectedError {
  const detail = rejectionDetail(payload)
  return new ProviderRequestRejectedError(
    detail.message ? `Provider rejected the request: ${detail.message}` : undefined,
    detail.code ?? fallbackCode,
  )
}

export function operationSignal(
  timeoutMs: number,
  signalForTimeout: (timeoutMs: number) => AbortSignal,
  external?: AbortSignal,
): AbortSignal {
  const timeout = signalForTimeout(timeoutMs)
  return external ? AbortSignal.any([external, timeout]) : timeout
}
