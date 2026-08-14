import type { GenerationQuote, GenerationQuoteRequest } from './generation'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function generationQuoteDigest(request: GenerationQuoteRequest): string {
  return canonical({
    ...request,
    references: [...request.references].sort((left, right) => left.alias - right.alias),
  })
}

export function createGenerationQuote(
  request: GenerationQuoteRequest,
  exactCredits: number,
): GenerationQuote {
  const clonedRequest = structuredClone(request)
  return {
    exactCredits,
    request: clonedRequest,
    requestDigest: generationQuoteDigest(clonedRequest),
  }
}
