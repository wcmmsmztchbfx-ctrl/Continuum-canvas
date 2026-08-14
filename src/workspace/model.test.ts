import { describe, expect, it } from 'vitest'

import {
  MAX_WORKSPACE_NAME_LENGTH,
  normalizeWorkspaceName,
  parseWorkspaceManifest,
  type WorkspaceManifestV1,
} from './model'

function makeManifest(): WorkspaceManifestV1 {
  return {
    version: 1,
    viewport: { x: 10, y: 20, zoom: 0.75 },
    projects: [
      {
        projectId: 'project-1',
        name: '同名',
        position: { x: 0, y: 0 },
        size: { width: 620, height: 380 },
        favorite: false,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      {
        projectId: 'project-2',
        name: '同名',
        position: { x: 700, y: 0 },
        size: { width: 620, height: 380 },
        favorite: false,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    ],
    canvases: [],
    pendingOperations: [],
  }
}

describe('workspace model', () => {
  it('accepts duplicate names while preserving stable ids', () => {
    expect(parseWorkspaceManifest(JSON.stringify(makeManifest()))).toEqual(
      makeManifest(),
    )
  })

  it('trims names and enforces a 60-character limit', () => {
    expect(MAX_WORKSPACE_NAME_LENGTH).toBe(60)
    expect(normalizeWorkspaceName('  新项目  ')).toBe('新项目')
    expect(normalizeWorkspaceName('项'.repeat(60))).toBe('项'.repeat(60))
    expect(() => normalizeWorkspaceName('项'.repeat(61))).toThrow(
      '名称不能超过 60 个字符',
    )
    expect(() => normalizeWorkspaceName('   ')).toThrow('名称不能为空')
  })

  it('rejects canvases that neither belong to a project nor stand independently', () => {
    const value = makeManifest()
    value.canvases.push({
      canvasId: 'canvas-1',
      projectId: 'missing-project',
      name: '画布',
      position: { x: 0, y: 0 },
      nodeCount: 0,
      favorite: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })

    expect(() => parseWorkspaceManifest(JSON.stringify(value))).toThrow(
      'Invalid workspace manifest',
    )
  })
})
