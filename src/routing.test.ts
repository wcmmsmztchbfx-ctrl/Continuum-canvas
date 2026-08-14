import { describe, expect, it, vi } from 'vitest'

import {
  buildCanvasRoute,
  normalizeCanvasLocation,
  parseAppRoute,
  resolveCanvasLocation,
} from './routing'
import type { WorkspaceManifestV1 } from './workspace/model'
import { referenceProjectSnapshot } from './fixtures/reference'

const manifest: WorkspaceManifestV1 = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  projects: [],
  canvases: [
    {
      canvasId: 'canvas-1',
      projectId: 'project-1',
      name: '画布 1',
      position: { x: 0, y: 0 },
      nodeCount: 0,
      favorite: false,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    },
  ],
  pendingOperations: [],
}

describe('workspace routing', () => {
  it('keeps the root route on the workspace home', () => {
    const replaceState = vi.fn()

    normalizeCanvasLocation(
      { pathname: '/', search: '', hash: '' },
      { replaceState },
    )

    expect(replaceState).not.toHaveBeenCalled()
    expect(parseAppRoute({ pathname: '/', search: '', hash: '' })).toEqual({
      kind: 'workspace',
    })
  })

  it('builds and parses the canonical route with project and canvas ids', () => {
    const url = buildCanvasRoute('项目 / 1', '画布 ? 1')

    expect(url).toBe(
      '/canvas?spaceId=local&projectId=%E9%A1%B9%E7%9B%AE+%2F+1&canvasId=%E7%94%BB%E5%B8%83+%3F+1',
    )
    expect(
      parseAppRoute({ pathname: '/canvas', search: url.slice('/canvas'.length), hash: '' }),
    ).toEqual({ kind: 'canvas', projectId: '项目 / 1', canvasId: '画布 ? 1' })
  })

  it('resolves an old project-only route when exactly one canvas matches', () => {
    const location = {
      pathname: '/canvas',
      search: '?spaceId=local&projectId=project-1',
      hash: '',
    }

    expect(resolveCanvasLocation(location, manifest)).toEqual({
      kind: 'canvas',
      projectId: 'project-1',
      canvasId: 'canvas-1',
      canonicalUrl: '/canvas?spaceId=local&projectId=project-1&canvasId=canvas-1',
    })
  })

  it('does not guess when an old project route has zero or multiple canvases', () => {
    const location = {
      pathname: '/canvas',
      search: '?spaceId=local&projectId=project-1',
      hash: '',
    }

    expect(resolveCanvasLocation(location, { ...manifest, canvases: [] })).toEqual({
      kind: 'invalid',
      reason: 'canvas-not-found',
    })
    expect(
      resolveCanvasLocation(location, {
        ...manifest,
        canvases: [
          ...manifest.canvases,
          { ...manifest.canvases[0]!, canvasId: 'canvas-2' },
        ],
      }),
    ).toEqual({ kind: 'invalid', reason: 'ambiguous-project-route' })
  })

  it('keeps the legacy reference alias working after workspace migration', () => {
    const referenceManifest: WorkspaceManifestV1 = {
      ...manifest,
      canvases: [
        {
          ...manifest.canvases[0]!,
          canvasId: 'legacy-reference-canvas',
          projectId: referenceProjectSnapshot.projectId,
        },
      ],
    }
    expect(
      resolveCanvasLocation(
        {
          pathname: '/canvas',
          search: '?spaceId=local&projectId=reference',
          hash: '',
        },
        referenceManifest,
      ),
    ).toEqual({
      kind: 'canvas',
      projectId: referenceProjectSnapshot.projectId,
      canvasId: 'legacy-reference-canvas',
      canonicalUrl:
        `/canvas?spaceId=local&projectId=${referenceProjectSnapshot.projectId}` +
        '&canvasId=legacy-reference-canvas',
    })
  })
})
