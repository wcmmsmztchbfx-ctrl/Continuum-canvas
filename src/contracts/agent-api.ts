import type {
  CanvasEdge,
  CanvasNode,
  CanvasSnapshotV2,
  DirectorExecutionStep,
  QuestionnairePayload,
} from '../model/project.ts'

export const AGENT_API_VERSION = 1 as const

export type AgentScope =
  | 'canvas:read'
  | 'canvas:write'
  | 'canvas:delete'
  | 'workflow:approve'
  | 'director:generate'

export interface AgentAccessToken {
  id: string
  canvasId: string
  projectId: string
  name: string
  scopes: AgentScope[]
  createdAt: string
  expiresAt?: string
  revokedAt?: string
}

export type CanvasNodeKind = 'image' | 'video' | 'text' | 'frame' | 'skill' | 'director'

export interface CanvasCreateNodeOperation {
  type: 'node.create'
  alias?: string
  node: {
    id?: string
    kind: CanvasNodeKind
    name: string
    text?: string
    prompt?: string
    position?: { x: number; y: number }
    size?: { width: number; height: number }
    aspectRatio?: string
    resolution?: string
    durationSec?: number
    referenceNodeIds?: string[]
  }
}

export interface CanvasUpdateNodeOperation {
  type: 'node.update'
  nodeId: string
  patch: {
    name?: string
    text?: string
    prompt?: string
    position?: { x: number; y: number }
    size?: { width: number; height: number }
    aspectRatio?: string
    resolution?: string
    durationSec?: number
    referenceNodeIds?: string[]
  }
}

export interface CanvasDeleteNodeOperation {
  type: 'node.delete'
  nodeId: string
}

export interface CanvasCreateEdgeOperation {
  type: 'edge.create'
  alias?: string
  edge: {
    id?: string
    source: string
    target: string
    relation: 'reference' | 'output' | 'flow' | 'skill'
    referenceAlias?: number
  }
}

export interface CanvasDeleteEdgeOperation {
  type: 'edge.delete'
  edgeId: string
}

export interface CanvasLayoutOperation {
  type: 'layout.apply'
  strategy: 'storyboard_horizontal' | 'grid' | 'tree'
  nodeIds?: string[]
}

export type CanvasOperation =
  | CanvasCreateNodeOperation
  | CanvasUpdateNodeOperation
  | CanvasDeleteNodeOperation
  | CanvasCreateEdgeOperation
  | CanvasDeleteEdgeOperation
  | CanvasLayoutOperation

export interface CanvasOperationBatch {
  operationId: string
  baseRevision?: number
  operations: CanvasOperation[]
}

export interface CanvasOperationReceipt {
  operationId: string
  canvasId: string
  projectId: string
  revision: number
  createdNodeIds: string[]
  updatedNodeIds: string[]
  deletedNodeIds: string[]
  createdEdgeIds: string[]
  deletedEdgeIds: string[]
  aliases: Record<string, string>
  replayed: boolean
  committedAt: string
}

export interface CanvasRevisionConflict {
  code: 'canvas_revision_conflict'
  expectedRevision: number
  actualRevision: number
}

export interface AgentCanvasContext {
  version: typeof AGENT_API_VERSION
  revision: number
  canvas: CanvasSnapshotV2
  selectedNodes?: CanvasNode[]
  adjacentEdges?: CanvasEdge[]
}

export interface DirectorLaunchSettings {
  providerId?: string
  model?: string
  imageModel?: string
  preferenceMode: 'image' | 'video'
  aspectRatio?: string
  duration?: number
  resolution?: string
}

export interface WorkflowCandidate {
  nodeId: string
  title: string
}

export type WorkflowStatus =
  | 'awaiting_approval'
  | 'running'
  | 'awaiting_input'
  | 'complete'
  | 'partial_failure'
  | 'failed'

export type DirectorRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'complete'
  | 'failed'

export interface DirectorArtifact {
  id: string
  kind: 'image' | 'video'
  url: string
  /** Stable identity derived from the upstream URL without rotating query credentials. */
  sourceKey?: string
  nodeId?: string
  createdAt: string
}

export interface DirectorRun {
  id: string
  workflowId: string
  canvasId: string
  projectId: string
  candidateNodeId: string
  directorNodeId?: string
  status: DirectorRunStatus
  settings: DirectorLaunchSettings
  referenceNodeIds: string[]
  skillNodeIds: string[]
  threadId?: string
  runId?: string
  threadUrl?: string
  reply?: string
  thinking?: string
  executionSteps?: DirectorExecutionStep[]
  questionnaire?: QuestionnairePayload
  artifacts: DirectorArtifact[]
  error?: string
  attempt: number
  createdAt: string
  updatedAt: string
}

export interface WorkflowRun {
  id: string
  canvasId: string
  projectId: string
  status: WorkflowStatus
  candidates: WorkflowCandidate[]
  approvedNodeIds: string[]
  referenceNodeIds: string[]
  skillNodeIds: string[]
  settings: DirectorLaunchSettings
  directorRuns: DirectorRun[]
  createdAt: string
  updatedAt: string
}

export interface ApprovalRequest {
  workflowId: string
  approvedNodeIds: string[]
}

export interface DirectorRunEvent {
  id: string
  canvasId: string
  workflowId: string
  runId?: string
  type: 'workflow.updated' | 'director.updated' | 'canvas.updated'
  createdAt: string
}
