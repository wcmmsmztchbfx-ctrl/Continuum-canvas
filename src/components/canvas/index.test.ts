import { describe, expect, it } from 'vitest'

import {
  CanvasEdge,
  CanvasWorkspace,
  EmptyMediaPlaceholder,
  GroupNode,
  ImageNode,
  VideoNode,
  mapFixtureToReactFlow,
  mapProjectSnapshotToReactFlow,
} from './index'

describe('canvas public API', () => {
  it('exports the workspace, renderers, and fixture adapter', () => {
    expect(CanvasWorkspace).toBeTypeOf('function')
    expect(ImageNode).toBeTypeOf('function')
    expect(GroupNode).toBeTypeOf('function')
    expect(VideoNode).toBeTypeOf('function')
    expect(EmptyMediaPlaceholder).toBeTypeOf('function')
    expect(CanvasEdge).toBeTypeOf('function')
    expect(mapProjectSnapshotToReactFlow).toBeTypeOf('function')
    expect(mapFixtureToReactFlow).toBe(mapProjectSnapshotToReactFlow)
  })
})
