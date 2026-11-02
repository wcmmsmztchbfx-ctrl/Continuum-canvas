import { describe, expect, it } from 'vitest'
import { AgentSkills } from './skills.ts'
import { listCanvasCommands } from './commands.ts'

describe('immutable Skill packages', () => {
  it('pins the entire allowlisted package, including documents not yet read', async () => {
    const skills = new AgentSkills(); const bundle = await skills.snapshotV2()
    expect(bundle.version).toBe('2'); expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/)
    const document = skills.readResource(bundle, 'canvas-base', 'commands/geometry.md')
    expect(document.content).toContain('geometry.layout')
    for (const c of listCanvasCommands()) expect(Object.values(bundle.resources).some(r => r.content.includes(c.name))).toBe(true)
    const original = document.content; document.content = 'changed'
    expect(skills.readResource(bundle, 'canvas-base', 'commands/geometry.md').content).toBe(original)
    expect(() => skills.readResource(bundle, 'canvas-base', '../../secret')).toThrow()
    expect(() => skills.readResource(bundle, 'unknown')).toThrow()
    expect((await skills.read('canvas-base')).content).toContain('canvas-base@1')
  })
})
