import { PROJECT_SNAPSHOT_VERSION } from '../model/project'
import type { ProjectSnapshotV1 } from '../model/project'
import {
  cloneProjectSnapshot,
  defaultProjectRepository,
} from '../persistence/projectRepository'
import type { ProjectRepository } from '../persistence/projectRepository'
import { recordHistory } from './history'
import type { HistoryAction, HistoryRecord } from './history'

const DEFAULT_DELAY_MS = 24
const DEFAULT_ORIGIN = 'https://mock.local'

export interface Workspace {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface ShareLink {
  id: string
  projectId: string
  url: string
  createdAt: string
}

export interface PublishResult {
  projectId: string
  url: string
  publishedAt: string
}

export type WorkspaceRole = 'viewer' | 'editor'

export interface Invitation {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceRole
  status: 'pending'
  createdAt: string
}

export interface UploadMetadataInput {
  name: string
  size: number
  type: string
  lastModified?: number
}

export interface UploadMetadata extends UploadMetadataInput {
  id: string
  projectId: string
  status: 'uploaded'
  uploadedAt: string
}

export interface DownloadSelectionResult {
  id: string
  projectId: string
  nodeIds: string[]
  fileName: string
  mimeType: 'application/zip'
  createdAt: string
}

export interface MockApiOptions {
  repository?: ProjectRepository
  clock?: () => Date
  random?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  delayMs?: number
  origin?: string
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function requireName(value: string, entityLabel: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${entityLabel}名称不能为空`)
  }
  return normalized
}

function safeFileName(value: string): string {
  const invalidCharacters = '<>:"/\\|?*'
  const sanitized = [...value]
    .map((character) =>
      character.charCodeAt(0) <= 31 || invalidCharacters.includes(character)
        ? '_'
        : character,
    )
    .join('')
    .trim()
  return sanitized || '项目'
}

export class MockApi {
  private readonly repository: ProjectRepository
  private readonly clock: () => Date
  private readonly random: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly delayMs: number
  private readonly origin: string
  private readonly workspaces = new Map<string, Workspace>()
  private readonly projectWorkspaceIds = new Map<string, string>()
  private history: HistoryRecord[] = []
  private sequence = 0

  constructor(options: MockApiOptions = {}) {
    this.repository = options.repository ?? defaultProjectRepository
    this.clock = options.clock ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.sleep = options.sleep ?? defaultSleep
    this.delayMs = Math.max(0, options.delayMs ?? DEFAULT_DELAY_MS)
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  }

  private async wait(): Promise<void> {
    await this.sleep(this.delayMs)
  }

  private now(): string {
    return new Date(this.clock().getTime()).toISOString()
  }

  private createId(prefix: string): string {
    this.sequence += 1
    const timestamp = this.clock().getTime().toString(36)
    const randomValue = Math.min(Math.max(this.random(), 0), 0.999999999999)
    const randomPart = Math.floor(randomValue * 0x1_0000_0000).toString(36)
    return `${prefix}_${timestamp}_${randomPart}_${this.sequence.toString(36)}`
  }

  private appendHistory(action: HistoryAction, subject: string): void {
    this.history = recordHistory(this.history, action, {
      id: this.createId('history'),
      subject,
      createdAt: this.now(),
    })
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) {
      throw new Error(`未找到工作区“${workspaceId}”`)
    }
    return workspace
  }

  private async requireProject(projectId: string): Promise<ProjectSnapshotV1> {
    const project = await this.repository.loadProject(projectId)
    if (!project) {
      throw new Error(`未找到项目“${projectId}”`)
    }
    return project
  }

  async createWorkspace(name: string): Promise<Workspace> {
    await this.wait()
    const normalizedName = requireName(name, '工作区')
    const timestamp = this.now()
    const workspace: Workspace = {
      id: this.createId('workspace'),
      name: normalizedName,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.workspaces.set(workspace.id, workspace)
    this.appendHistory('workspace.create', workspace.name)
    return { ...workspace }
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    await this.wait()
    const workspace = this.requireWorkspace(workspaceId)
    const renamed: Workspace = {
      ...workspace,
      name: requireName(name, '工作区'),
      updatedAt: this.now(),
    }
    this.workspaces.set(workspaceId, renamed)
    this.appendHistory('workspace.rename', renamed.name)
    return { ...renamed }
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.wait()
    const workspace = this.requireWorkspace(workspaceId)
    const projectIds = [...this.projectWorkspaceIds.entries()]
      .filter(([, ownerWorkspaceId]) => ownerWorkspaceId === workspaceId)
      .map(([projectId]) => projectId)

    await Promise.all(
      projectIds.map((projectId) => this.repository.deleteProject(projectId)),
    )
    projectIds.forEach((projectId) => this.projectWorkspaceIds.delete(projectId))
    this.workspaces.delete(workspaceId)
    this.appendHistory('workspace.delete', workspace.name)
  }

  async createProject(
    workspaceId: string,
    name: string,
    template?: ProjectSnapshotV1,
  ): Promise<ProjectSnapshotV1> {
    await this.wait()
    this.requireWorkspace(workspaceId)
    const normalizedName = requireName(name, '项目')
    const projectId = this.createId('project')
    const project: ProjectSnapshotV1 = template
      ? {
          ...cloneProjectSnapshot(template),
          projectId,
          name: normalizedName,
        }
      : {
          version: PROJECT_SNAPSHOT_VERSION,
          projectId,
          name: normalizedName,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
        }

    await this.repository.saveProject(project)
    this.projectWorkspaceIds.set(project.projectId, workspaceId)
    this.appendHistory('project.create', project.name)
    return cloneProjectSnapshot(project)
  }

  async renameProject(projectId: string, name: string): Promise<ProjectSnapshotV1> {
    await this.wait()
    const project = await this.requireProject(projectId)
    const renamed = {
      ...project,
      name: requireName(name, '项目'),
    }
    await this.repository.saveProject(renamed)
    this.appendHistory('project.rename', renamed.name)
    return cloneProjectSnapshot(renamed)
  }

  async cloneProject(
    projectId: string,
    name?: string,
  ): Promise<ProjectSnapshotV1> {
    await this.wait()
    const source = await this.requireProject(projectId)
    const clone = {
      ...cloneProjectSnapshot(source),
      projectId: this.createId('project'),
      name: requireName(name ?? `${source.name} - 副本`, '项目'),
    }
    await this.repository.saveProject(clone)

    const workspaceId = this.projectWorkspaceIds.get(projectId)
    if (workspaceId) {
      this.projectWorkspaceIds.set(clone.projectId, workspaceId)
    }
    this.appendHistory('project.clone', clone.name)
    return cloneProjectSnapshot(clone)
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.wait()
    const project = await this.requireProject(projectId)
    await this.repository.deleteProject(projectId)
    this.projectWorkspaceIds.delete(projectId)
    this.appendHistory('project.delete', project.name)
  }

  async createShareLink(projectId: string): Promise<ShareLink> {
    await this.wait()
    const project = await this.requireProject(projectId)
    const id = this.createId('share')
    const shareLink: ShareLink = {
      id,
      projectId,
      url: `${this.origin}/share/${id}`,
      createdAt: this.now(),
    }
    this.appendHistory('share.create', project.name)
    return shareLink
  }

  async publishProject(projectId: string): Promise<PublishResult> {
    await this.wait()
    const project = await this.requireProject(projectId)
    const publishId = this.createId('publish')
    const result: PublishResult = {
      projectId,
      url: `${this.origin}/published/${publishId}`,
      publishedAt: this.now(),
    }
    this.appendHistory('project.publish', project.name)
    return result
  }

  async inviteMember(
    workspaceId: string,
    email: string,
    role: WorkspaceRole = 'viewer',
  ): Promise<Invitation> {
    await this.wait()
    this.requireWorkspace(workspaceId)
    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('请输入有效的邮箱地址')
    }
    if (role !== 'viewer' && role !== 'editor') {
      throw new Error('邀请角色无效')
    }

    const invitation: Invitation = {
      id: this.createId('invitation'),
      workspaceId,
      email: normalizedEmail,
      role,
      status: 'pending',
      createdAt: this.now(),
    }
    this.appendHistory('member.invite', normalizedEmail)
    return invitation
  }

  async uploadMetadata(
    projectId: string,
    file: UploadMetadataInput,
  ): Promise<UploadMetadata> {
    await this.wait()
    await this.requireProject(projectId)
    const name = file.name.trim()
    if (!name) {
      throw new Error('文件名不能为空')
    }
    if (!Number.isFinite(file.size) || file.size < 0) {
      throw new Error('文件大小无效')
    }

    const metadata: UploadMetadata = {
      ...file,
      id: this.createId('upload'),
      projectId,
      name,
      status: 'uploaded',
      uploadedAt: this.now(),
    }
    this.appendHistory('asset.upload', name)
    return metadata
  }

  async downloadSelection(
    projectId: string,
    nodeIds: readonly string[],
  ): Promise<DownloadSelectionResult> {
    await this.wait()
    const project = await this.requireProject(projectId)
    const uniqueNodeIds = [...new Set(nodeIds)]
    if (uniqueNodeIds.length === 0) {
      throw new Error('请至少选择一个节点')
    }

    const availableNodeIds = new Set(project.nodes.map((node) => node.id))
    const missingNodeId = uniqueNodeIds.find((nodeId) => !availableNodeIds.has(nodeId))
    if (missingNodeId) {
      throw new Error(`项目“${projectId}”中不存在节点“${missingNodeId}”`)
    }

    const result: DownloadSelectionResult = {
      id: this.createId('download'),
      projectId,
      nodeIds: uniqueNodeIds,
      fileName: `${safeFileName(project.name)}-选中内容.zip`,
      mimeType: 'application/zip',
      createdAt: this.now(),
    }
    this.appendHistory('selection.download', project.name)
    return result
  }

  getHistory(): HistoryRecord[] {
    return this.history.map((record) => ({ ...record }))
  }
}

export const mockApi = new MockApi()

let defaultWorkspacePromise: Promise<Workspace> | undefined

export function ensureMockWorkspace(api: MockApi = mockApi): Promise<Workspace> {
  defaultWorkspacePromise ??= api.createWorkspace('未命名工作区')
  return defaultWorkspacePromise
}

