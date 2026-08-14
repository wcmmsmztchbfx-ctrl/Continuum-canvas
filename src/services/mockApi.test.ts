import { describe, expect, it, vi } from 'vitest'

import { referenceProjectSnapshot } from '../fixtures/reference'
import {
  createProjectRepository,
  type ProjectStorageBackend,
} from '../persistence/projectRepository'
import { MockApi } from './mockApi'

class MemoryProjectBackend implements ProjectStorageBackend {
  private readonly records = new Map<string, string>()

  async put(projectId: string, serialized: string): Promise<void> {
    this.records.set(projectId, serialized)
  }

  async get(projectId: string): Promise<string | undefined> {
    return this.records.get(projectId)
  }

  async getAll(): Promise<string[]> {
    return [...this.records.values()]
  }

  async delete(projectId: string): Promise<void> {
    this.records.delete(projectId)
  }
}

function createApi() {
  const sleep = vi.fn(async (_milliseconds: number) => undefined)
  const repository = createProjectRepository(new MemoryProjectBackend())
  const api = new MockApi({
    repository,
    clock: () => new Date('2026-07-15T00:00:00.000Z'),
    random: () => 0.25,
    sleep,
    delayMs: 12,
    origin: 'https://mock.local',
  })

  return { api, repository, sleep }
}

describe('MockApi', () => {
  it('creates, renames and deletes workspaces asynchronously', async () => {
    const { api, sleep } = createApi()

    const workspace = await api.createWorkspace('  本地工作区  ')
    expect(workspace.name).toBe('本地工作区')

    const renamed = await api.renameWorkspace(workspace.id, '创作空间')
    expect(renamed.name).toBe('创作空间')

    await api.deleteWorkspace(workspace.id)
    await expect(api.renameWorkspace(workspace.id, '不存在')).rejects.toThrow(
      `未找到工作区“${workspace.id}”`,
    )
    expect(sleep).toHaveBeenCalledWith(12)
  })

  it('creates, renames, clones and deletes ProjectSnapshotV1 projects', async () => {
    const { api, repository } = createApi()
    const workspace = await api.createWorkspace('工作区')

    const project = await api.createProject(
      workspace.id,
      '参考画布',
      referenceProjectSnapshot,
    )
    expect(project.version).toBe(1)
    expect(project.name).toBe('参考画布')
    expect(project.projectId).not.toBe(referenceProjectSnapshot.projectId)

    const renamed = await api.renameProject(project.projectId, '新名称')
    expect(renamed.name).toBe('新名称')

    const cloned = await api.cloneProject(project.projectId)
    expect(cloned.projectId).not.toBe(project.projectId)
    expect(cloned.name).toBe('新名称 - 副本')
    expect(cloned.nodes).toEqual(renamed.nodes)
    expect(cloned.nodes).not.toBe(renamed.nodes)

    await api.deleteProject(project.projectId)
    expect(await repository.loadProject(project.projectId)).toBeUndefined()
  })

  it('mocks share, publish, invite, upload and download without fetch', async () => {
    const { api } = createApi()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const workspace = await api.createWorkspace('工作区')
    const project = await api.createProject(
      workspace.id,
      '参考画布',
      referenceProjectSnapshot,
    )

    const share = await api.createShareLink(project.projectId)
    const published = await api.publishProject(project.projectId)
    const invitation = await api.inviteMember(
      workspace.id,
      'member@example.com',
      'editor',
    )
    const upload = await api.uploadMetadata(project.projectId, {
      name: 'cover.png',
      size: 2048,
      type: 'image/png',
      lastModified: 123,
    })
    const download = await api.downloadSelection(project.projectId, [
      referenceProjectSnapshot.nodes[0]!.id,
    ])

    expect(share.url).toMatch(/^https:\/\/mock\.local\/share\//)
    expect(published.url).toMatch(/^https:\/\/mock\.local\/published\//)
    expect(invitation).toMatchObject({
      email: 'member@example.com',
      role: 'editor',
      status: 'pending',
    })
    expect(upload).toMatchObject({
      projectId: project.projectId,
      name: 'cover.png',
      size: 2048,
      status: 'uploaded',
    })
    expect(download).toMatchObject({
      projectId: project.projectId,
      nodeIds: [referenceProjectSnapshot.nodes[0]!.id],
      mimeType: 'application/zip',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(api.getHistory().map((record) => record.action)).toEqual(
      expect.arrayContaining([
        'share.create',
        'project.publish',
        'member.invite',
        'asset.upload',
        'selection.download',
      ]),
    )

    fetchSpy.mockRestore()
  })

  it('returns readable Chinese validation and not-found errors', async () => {
    const { api } = createApi()
    const workspace = await api.createWorkspace('工作区')

    await expect(api.createProject(workspace.id, '   ')).rejects.toThrow(
      '项目名称不能为空',
    )
    await expect(api.publishProject('missing-project')).rejects.toThrow(
      '未找到项目“missing-project”',
    )
    await expect(
      api.inviteMember(workspace.id, 'not-an-email'),
    ).rejects.toThrow('请输入有效的邮箱地址')
  })
})
