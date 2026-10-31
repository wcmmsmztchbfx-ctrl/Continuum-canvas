import { describe, expect, it } from 'vitest'
import { compactConversation, normalizedConversation } from './context.ts'
import type { ModelMessage } from './model.ts'

describe('Agent context checkpoints', () => {
  it('compacts complete old rounds while preserving every user constraint and answer', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Only these selected nodes; one paid attempt.' }]
    for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `tool-${i}` }] },
      { role: 'tool', tool_call_id: `tool-${i}`, content: 'actual-result '.repeat(1500) }, { role: 'user', content: `Constraint ${i}` })
    const result = compactConversation(messages, 30_000)
    expect(result.removedRounds).toBeGreaterThan(0)
    expect(JSON.stringify(result.messages).length).toBeLessThanOrEqual(30_000)
    expect(result.messages.filter(m => m.role === 'user')).toEqual(messages.filter(m => m.role === 'user'))
    for (const message of result.messages.filter(m => m.role === 'tool')) expect(result.messages.some(m => m.role === 'assistant' && JSON.stringify(m.tool_calls).includes(message.tool_call_id!))).toBe(true)
  })
  it('places delayed tool receipts before user supplements in the model protocol', () => {
    const normalized = normalizedConversation([
      { role: 'assistant', content: null, tool_calls: [{ id: 'generation' }] },
      { role: 'user', content: 'Keep the original layout.' },
      { role: 'tool', tool_call_id: 'generation', content: '{"applied":true}' },
    ])
    expect(normalized.map(m => m.role)).toEqual(['assistant', 'tool', 'user'])
  })
  it('never drops an incomplete tool intent or silently truncates user requirements', () => {
    expect(() => compactConversation([{ role: 'user', content: 'x'.repeat(500) }], 100)).toThrow(/用户要求/)
    const incomplete: ModelMessage[] = [{ role: 'assistant', content: 'x'.repeat(500), tool_calls: [{ id: 'pending' }] }]
    expect(() => compactConversation(incomplete, 100)).toThrow()
  })
})
