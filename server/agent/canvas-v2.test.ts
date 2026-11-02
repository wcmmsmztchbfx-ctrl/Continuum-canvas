import { describe, expect, it } from 'vitest'
import { defaultInitialCanvas } from '../canvas-storage.ts'
import { applyChanges, changesBetween } from './canvas.ts'
import type { CanvasNode } from '../../src/model/project.ts'

const text = (id: string): CanvasNode => ({ id, type: 'text', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: id, nodeKind: 'text' } })
const before = () => ({ ...defaultInitialCanvas('canvas-test', 'project-test', 'Test'), nodes: ['a', 'b', 'c'].map(text) })
describe('v2 complete document changes', () => {
  it('records and reverses canvas name and node/edge order without changing the camera', () => {
    const a = before(); const b = { ...a, name: 'Changed', nodes: [...a.nodes].reverse() }
    const changes = changesBetween(a, b, true)
    expect(applyChanges(a, changes).snapshot).toEqual(b)
    expect(applyChanges(b, changes, true).snapshot).toEqual(a)
  })
  it('preserves later human insertions and independent fields while undoing layer order', () => {
    const a = before(); const b = { ...a, nodes: [a.nodes[2], a.nodes[0], a.nodes[1]] }
    const later = { ...b, viewport: { x: 12, y: 4, zoom: 2 }, nodes: [b.nodes[0], text('human'), { ...b.nodes[1], name: 'Human title' }, b.nodes[2]] }
    const result = applyChanges(later, changesBetween(a, b, true), true)
    expect(result.snapshot.nodes.map(n => n.id)).toEqual(['a', 'human', 'b', 'c'])
    expect(result.snapshot.nodes[0].name).toBe('Human title')
    expect(result.snapshot.viewport).toEqual(later.viewport)
  })
  it('keeps a later human reorder and canvas rename instead of overwriting it', () => {
    const a = before(); const b = { ...a, name: 'Agent', nodes: [...a.nodes].reverse() }
    const later = { ...b, name: 'Human', nodes: [a.nodes[1], a.nodes[2], a.nodes[0]] }
    const result = applyChanges(later, changesBetween(a, b, true), true)
    expect(result.snapshot).toEqual(later); expect(result.conflicts.length).toBe(2)
  })
  it('legacy records still omit name/order changes', () => {
    const a = before(); expect(changesBetween(a, { ...a, name: 'Other', nodes: [...a.nodes].reverse() })).toEqual([])
  })
  it('restores a deleted object at its previous layer position', () => {
    const a = before(); const b = { ...a, nodes: a.nodes.filter(n => n.id !== 'b') }
    expect(applyChanges(b, changesBetween(a, b, true), true).snapshot).toEqual(a)
  })
  it('preserves deletion of a node whose optional field was removed by the Agent', () => {
    const a = before(); a.nodes[0].parentId = 'container'
    a.nodes.push({ id: 'container', type: 'group', name: 'G', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, data: { childIds: ['a'] } })
    const b = structuredClone(a); delete b.nodes[0].parentId
    const later = { ...b, nodes: b.nodes.filter(n => n.id !== 'a') }
    expect(() => applyChanges(later, changesBetween(a, b, true), true)).not.toThrow()
    expect(applyChanges(later, changesBetween(a, b, true), true).snapshot.nodes.some(n => n.id === 'a')).toBe(false)
  })
  it('retains a task-created node subsequently reordered by a human', () => {
    const a = before(); const b = { ...a, nodes: [...a.nodes, text('agent')] }
    const later = { ...b, nodes: [b.nodes[3], ...a.nodes] }
    const result = applyChanges(later, changesBetween(a, b, true), true)
    expect(result.snapshot.nodes.map(n => n.id)).toEqual(['agent', 'a', 'b', 'c'])
    expect(result.conflicts.length).toBeGreaterThan(0)
  })
})
