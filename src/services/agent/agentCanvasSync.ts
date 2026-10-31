import type { AgentRun } from '../../contracts/agent'
import { canvasContentIdentity } from '../../model/canvasContentIdentity'
import { mergeCanvasSnapshots, type CanvasMergeConflict } from '../../model/canvasMerge'
import type { CanvasSnapshotV2 } from '../../model/project'
import type { WorkspaceRepository } from '../../workspace/repository'
import { AgentRuntimeClient } from './agentRuntimeClient'

export interface AgentCanvasSyncOptions {
  canvasId: string
  repository: WorkspaceRepository
  readLocal(): CanvasSnapshotV2
  isCollaborating(): boolean
  applyRemote(canvas: CanvasSnapshotV2): void
  flushLocal(): Promise<void>
  prepareCollaboration?(): Promise<number>
  readRuns?(): Promise<AgentRun[]>
  onError(message: string): void
  intervalMs?: number
}

/** Owned by the editor, independently of the Agent panel's mount lifecycle. */
export function createAgentCanvasSync(options: AgentCanvasSyncOptions) {
  const client = new AgentRuntimeClient()
  const readRuns = options.readRuns ?? (() => client.listRuns(options.canvasId))
  let stopped = false
  let closingSnapshot: CanvasSnapshotV2 | undefined
  let synchronizing = false
  let lastRevision = 0
  let lastError = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingSync: Promise<void> | undefined
  let pendingPoll: Promise<void> | undefined
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : '后台画布同步失败，本地修改已保留'
    if (!stopped && lastError !== message) { lastError = message; options.onError(message) }
  }
  const synchronize = (): Promise<void> => {
    if (pendingSync) return pendingSync
    if (stopped || options.isCollaborating()) return Promise.resolve()
    const synchronizeCanvas = options.repository.synchronizeCanvas
    if (!synchronizeCanvas) return Promise.reject(new Error('当前画布存储不支持后台同步'))
    synchronizing = true
    pendingSync = (async () => {
      let seenLocal = structuredClone(options.readLocal())
      let candidate = seenLocal
      let conflicts: CanvasMergeConflict[] = []
      for (;;) {
        const result = await synchronizeCanvas(candidate, { conflicts })
        const latestLocal = stopped ? closingSnapshot ?? seenLocal : options.readLocal()
        if (latestLocal.canvasId !== options.canvasId) return
        if (canvasContentIdentity(latestLocal) !== canvasContentIdentity(seenLocal) ||
          latestLocal.viewport.x !== seenLocal.viewport.x || latestLocal.viewport.y !== seenLocal.viewport.y || latestLocal.viewport.zoom !== seenLocal.viewport.zoom) {
          const merged = mergeCanvasSnapshots(seenLocal, latestLocal, result.canvas)
          candidate = merged.canvas
          conflicts = [...result.conflicts, ...merged.conflicts]
          seenLocal = structuredClone(latestLocal)
          continue
        }
        lastRevision = Math.max(lastRevision, result.revision)
        if (!stopped && !options.isCollaborating()) options.applyRemote({ ...result.canvas, viewport: latestLocal.viewport })
        if (result.conflicts.length) throw new Error('后台更新与本地编辑冲突，双方内容均已保留。请在保存详情中处理后继续。')
        lastError = ''
        return
      }
    })().finally(() => { synchronizing = false; pendingSync = undefined })
    return pendingSync
  }
  const poll = (): Promise<void> => {
    if (pendingPoll) return pendingPoll
    pendingPoll = (async () => {
      if (stopped || options.isCollaborating() || !options.repository.synchronizeCanvas) return
      const runs = await readRuns()
      if (stopped || options.isCollaborating()) return
      const revision = Math.max(0, ...runs.filter(run => run.canvasId === options.canvasId).map(run => run.appliedCanvasRevision ?? 0))
      if (revision > lastRevision) await synchronize()
    })().finally(() => { pendingPoll = undefined })
    return pendingPoll
  }
  const wake = () => {
    clearTimeout(timer)
    void poll().catch(report).finally(() => { if (!stopped) timer = setTimeout(wake, options.intervalMs ?? 1_500) })
  }
  return {
    poll,
    isSynchronizing: () => synchronizing,
    start() { if (!stopped) wake() },
    async beforeRun(): Promise<{ expectedRevision: number }> {
      if (stopped) throw new Error('画布已切换，请在当前画布重新发送')
      if (options.isCollaborating()) {
        if (!options.prepareCollaboration) throw new Error('请等待协作修改同步完成后再开始任务')
        for (let attempt = 0; attempt < 5; attempt++) {
          const contents = canvasContentIdentity(options.readLocal())
          const expectedRevision = await options.prepareCollaboration()
          if (stopped || !options.isCollaborating()) throw new Error('画布或协作状态已切换，请重新发送')
          if (contents === canvasContentIdentity(options.readLocal())) return { expectedRevision }
        }
        throw new Error('协作画布仍在变化，请等待同步后重新发送任务')
      }
      // A prior revision conflict can be resolved by the scoped three-way merge.
      // Network/cache errors still fail at the remote read or confirmation below.
      for (let attempt = 0; attempt < 5; attempt++) {
        await options.flushLocal().catch(() => undefined)
        await synchronize()
        if (stopped) throw new Error('画布已切换，请在当前画布重新发送')
        const contents = canvasContentIdentity(options.readLocal())
        const expectedRevision = await options.repository.confirmedCanvasRevision?.(options.canvasId)
        if (expectedRevision === undefined || stopped) throw new Error('无法确认当前画布已保存，请稍后重试')
        if (contents === canvasContentIdentity(options.readLocal())) return { expectedRevision }
      }
      throw new Error('画布仍在编辑或同步，请稍后重新发送任务')
    },
    stop() {
      if (synchronizing) closingSnapshot = structuredClone(options.readLocal())
      stopped = true
      clearTimeout(timer)
    },
  }
}

export type AgentCanvasSync = ReturnType<typeof createAgentCanvasSync>
