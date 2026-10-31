import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfigStore } from '../agent-config-store.ts'
import { configuredModel, type AgentModelInput } from './model.ts'

const config = { getPreferred: () => ({ id: 'test', enabled: true, secretConfigured: true, model: 'test-vision', baseUrl: 'https://model.invalid/v1/' }), getSecret: () => 'fixture-only' } as unknown as AgentConfigStore
const input = (): AgentModelInput => ({ system: 'canvas-base@1', tools: [{ type: 'function', function: { name: 'create_node' } }], signal: new AbortController().signal, hasImages: true,
  messages: [{ role: 'user', content: [{ type: 'text', text: '参考图 1' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] })
afterEach(() => vi.unstubAllGlobals())

describe('configured canvas Agent model protocol', () => {
  it('sends real vision parts, current skill and tools and parses native function calls', async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
      tool_calls: [{ id: 'call-real', type: 'function', function: { name: 'create_node', arguments: JSON.stringify({ type: 'image', name: '苹果' }) } }] } }] }))
    vi.stubGlobal('fetch', fetcher)
    expect(await configuredModel(config)(input())).toEqual({ text: undefined, calls: [{ id: 'call-real', name: 'create_node', arguments: { type: 'image', name: '苹果' } }] })
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://model.invalid/v1/chat/completions')
    expect(JSON.parse(String(request.body))).toMatchObject({ stream: false, tools: input().tools,
      messages: [{ role: 'system', content: 'canvas-base@1' }, ...input().messages] })
  })
  it.each([
    [{ finish_reason: 'length', message: { content: 'partial' } }, 'model_incomplete'],
    [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'create_node', arguments: '{broken' } }] } }, 'model_invalid_tool'],
    [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'create_node', arguments: '[]' } }] } }, 'model_invalid_tool'],
  ])('rejects incomplete or malformed commands without executing text', async (choice, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [choice] })))
    await expect(configuredModel(config)(input())).rejects.toMatchObject({ code })
  })
  it('never treats a JSON-looking ordinary reply as a canvas command', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"tool":"delete_nodes"}' } }] })))
    expect(await configuredModel(config)(input())).toEqual({ text: '{"tool":"delete_nodes"}', calls: [] })
  })
  it('bounds upstream content and reports provider HTTP failure without leaking its body', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('upstream private diagnostics', { status: 401 })).mockResolvedValueOnce(new Response('x'.repeat(512_001)))
    vi.stubGlobal('fetch', fetcher)
    await expect(configuredModel(config)(input())).rejects.toMatchObject({ code: 'model_rejected', message: expect.not.stringContaining('private') })
    await expect(configuredModel(config)(input())).rejects.toMatchObject({ code: 'model_response_limit' })
  })
})
