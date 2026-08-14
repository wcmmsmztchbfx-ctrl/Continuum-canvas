/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'

export interface GenerationApprovalDetails {
  providerName: string
  modelName: string
  credits: number
  quote: GenerationApprovalQuote
}

export interface GenerationApprovalQuote {
  requestDigest: string
  request: unknown
}

interface GenerationApprovalState {
  requestGeneration: (
    details: GenerationApprovalDetails,
    action: (quote: GenerationApprovalQuote) => void,
    isCurrent: (quote: GenerationApprovalQuote) => boolean,
  ) => void
}

const GenerationApprovalContext =
  createContext<GenerationApprovalState | null>(null)

function frozenClone<T>(value: T): T {
  const clone = structuredClone(value)
  const freeze = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    Object.freeze(candidate)
    for (const child of Object.values(candidate)) freeze(child)
  }
  freeze(clone)
  return clone
}

export function GenerationApprovalProvider({ children }: { children: ReactNode }) {
  const requestGeneration = useCallback(
    (
      details: GenerationApprovalDetails,
      action: (quote: GenerationApprovalQuote) => void,
      isCurrent: (quote: GenerationApprovalQuote) => boolean,
    ) => {
      const frozenDetails = frozenClone(details)
      if (isCurrent(frozenDetails.quote)) action(frozenDetails.quote)
    },
    [],
  )

  const value = useMemo(() => ({ requestGeneration }), [requestGeneration])

  return (
    <GenerationApprovalContext.Provider value={value}>
      {children}
    </GenerationApprovalContext.Provider>
  )
}

export function useGenerationApproval(): GenerationApprovalState {
  const value = useContext(GenerationApprovalContext)
  if (!value) {
    throw new Error(
      'useGenerationApproval must be used inside GenerationApprovalProvider',
    )
  }
  return value
}

export function useOptionalGenerationApproval(): GenerationApprovalState | null {
  return useContext(GenerationApprovalContext)
}
