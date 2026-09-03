import { describe, expect, it } from 'vitest'

import { referenceProjectSnapshot } from '../fixtures/reference'
import { deterministicLegacyCanvasId } from '../model/project'
import { migrateLegacyProjects } from './migration'

describe('legacy workspace migration', () => {
  const now = '2026-07-18T00:00:00.000Z'

  it('migrates each v1 project to a same-name project and deterministic 画布 1', () => {
    const legacy = {
      ...referenceProjectSnapshot,
      projectId: 'legacy-project',
      name: '旧项目',
    }

    const first = migrateLegacyProjects([legacy], { now, seedProject: legacy })
    const second = migrateLegacyProjects([legacy], { now, seedProject: legacy })
    const canvasId = deterministicLegacyCanvasId('legacy-project')

    expect(second).toEqual(first)
    expect(first.manifest.projects).toEqual([
      expect.objectContaining({ projectId: 'legacy-project', name: '旧项目' }),
    ])
    expect(first.manifest.canvases).toEqual([
      expect.objectContaining({
        canvasId,
        projectId: 'legacy-project',
        name: '画布 1',
        nodeCount: legacy.nodes.length,
      }),
    ])
    expect(first.documents).toEqual([
      expect.objectContaining({
        version: 3,
        canvasId,
        projectId: 'legacy-project',
        name: '画布 1',
        nodes: expect.arrayContaining(legacy.nodes.map((node) => expect.objectContaining({ id: node.id, position: node.position }))),
        edges: legacy.edges,
      }),
    ])
  })

  it('creates the example project from the supplied seed when legacy storage is empty', () => {
    const result = migrateLegacyProjects([], {
      now,
      seedProject: referenceProjectSnapshot,
    })

    expect(result.manifest.projects).toHaveLength(1)
    expect(result.manifest.projects[0]).toMatchObject({
      projectId: referenceProjectSnapshot.projectId,
      name: referenceProjectSnapshot.name,
    })
    expect(result.documents[0]?.nodes).toHaveLength(
      referenceProjectSnapshot.nodes.length,
    )
  })
})
