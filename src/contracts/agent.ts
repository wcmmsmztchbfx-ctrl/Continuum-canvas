export type AgentRunStatus = 'queued' | 'running' | 'waiting_user' | 'waiting_generation' | 'paused' | 'complete' | 'partial' | 'failed' | 'stopped'
export type AgentEventStatus = 'running' | 'complete' | 'failed' | 'waiting' | 'skipped'
export interface AgentAttachment {
  id: string
  nodeId: string
  name: string
  assetId: string
  mediaType: 'image'
  url?: string
  width?: number
  height?: number
}
export interface AgentPlanItem {
  id: string
  title: string
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
}
export interface AgentQuestion {
  id: string
  title: string
  options: string[]
  multiple?: boolean
}
export interface AgentRunEvent {
  id: string
  sequence: number
  type: 'skill' | 'tool' | 'message' | 'question' | 'plan' | 'generation' | 'status' | 'view'
  status: AgentEventStatus
  title: string
  detail?: string
  toolName?: string
  operationId?: string
  nodeIds?: string[]
  createdAt: string
}
export interface AgentOutput {
  nodeId: string
  assetId: string
  url: string
  mediaType: 'image' | 'video'
}
export interface AgentRun {
  id: string
  requestId: string
  canvasId: string
  projectId: string
  prompt: string
  attachments: AgentAttachment[]
  status: AgentRunStatus
  createdAt: string
  updatedAt: string
  sequence: number
  events: AgentRunEvent[]
  plan: AgentPlanItem[]
  question?: AgentQuestion
  response?: string
  error?: { code: string; message: string }
  outputs: AgentOutput[]
  canUndo: boolean
  appliedCanvasRevision?: number
}
export interface AgentCreateRunInput {
  requestId: string
  canvasId: string
  expectedRevision: number
  prompt: string
  attachments: AgentAttachment[]
  selectedNodeIds?: string[]
  viewport?: { x: number; y: number; zoom: number }
}
export type AgentControlAction = 'pause' | 'resume' | 'stop' | 'undo' | 'message'
export interface AgentControlInput {
  action: AgentControlAction
  requestId: string
  message?: string
}
export interface AgentAnswerInput {
  questionId: string
  answer: string
  requestId: string
}
export interface AgentSkillInfo {
  id: string
  name: string
  description: string
  version: string
}
export interface AgentRunsResponse { runs: AgentRun[] }
export interface AgentRunResponse { run: AgentRun }
export interface AgentSkillsResponse { skills: AgentSkillInfo[] }
export const ACTIVE_AGENT_STATUSES: readonly AgentRunStatus[] = ['queued', 'running', 'waiting_user', 'waiting_generation', 'paused']
