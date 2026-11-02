import type { AgentRun } from '../../src/contracts/agent.ts'
import type { GenerationRequest } from '../../src/contracts/generation.ts'
import type { CanvasSnapshotV2 } from '../../src/model/project.ts'
import type { WorkspaceMutation } from '../../src/workspace/persistenceProtocol.ts'
import type { ModelMessage, ToolCall } from './model.ts'
import type { SkillPackage } from './skills.ts'

export class AgentError extends Error {
  readonly status: number; readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
export type AgentGrant = { kind: 'local-admin'; tokenDigest?: string } | { kind: 'collaboration'; roomId: string; epoch: string; memberId: string; sessionId: string }
export interface FieldChange { collection: 'nodes' | 'edges' | 'canvas'; id: string; path: string[]; before?: unknown; after?: unknown }
export interface PendingCanvasWrite { operationId: string; changes: FieldChange[]; trackChanges?: boolean; mutation?: WorkspaceMutation; before?: CanvasSnapshotV2; after?: CanvasSnapshotV2 }
export interface StoredOperation { id: string; call: ToolCall; state: 'pending' | 'complete'; result?: unknown }
export interface GenerationBinding { operationId: string; nodeId: string; request: GenerationRequest; jobId?: string; settled?: boolean; applied?: boolean; notSubmitted?: boolean; expectedFields: Record<string, unknown> }
export interface StoredRun {
  executionVersion?: 2
  skillPackage?: SkillPackage
  version: 1 | 2; run: AgentRun; grant: AgentGrant; authority: string; inputDigest: string
  selectedNodeIds: string[]; viewport?: { x: number; y: number; zoom: number }
  messages: ModelMessage[]; operations: StoredOperation[]; changes: FieldChange[]; bindings: GenerationBinding[]
  pendingWrite?: PendingCanvasWrite; round: number; generationBudget: number; stopped: boolean; undone: boolean
  skills: Record<string, { info: { id: string; name: string; description: string; version: string }; content: string }>
  handledRequests: Record<string, string>; pendingCalls: ToolCall[]; intentVersion: number
  observed: Record<string, unknown>
  pendingRound?: number
  roundLimit?: number
  writeAuthorized?: boolean
  generationAttemptsAllowed?: number
  generationPausedByUser?: boolean
  reviewFromOperation?: number
}
