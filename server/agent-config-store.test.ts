import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentConfigStore, AGENT_LLM_PRESETS } from './agent-config-store.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'agent-config-test-'))
}

describe('AgentConfigStore', () => {
  it('initializes empty on fresh start and provides 13+ presets for selection', async () => {
    const dataDir = await tempDirectory()
    const store = await AgentConfigStore.open({ dataDir, env: {} })

    const list = store.listPublic()
    // Fresh store starts empty so only user-added models appear in the list
    expect(list.length).toBe(0)
    expect(AGENT_LLM_PRESETS.length).toBeGreaterThanOrEqual(13)
    expect(store.getPreferred()).toBeUndefined()
  })

  it('updates provider, sets secret and masks secret', async () => {
    const dataDir = await tempDirectory()
    const env: Record<string, string | undefined> = {}
    const store = await AgentConfigStore.open({ dataDir, env })

    const updated = await store.upsert({
      id: 'openai',
      name: 'OpenAI 官方',
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-4o',
      preferred: true,
      secret: 'sk-1234567890abcdef',
    })

    expect(updated.id).toBe('openai')
    expect(updated.baseUrl).toBe('https://api.openai.com/v1')
    expect(updated.preferred).toBe(true)
    expect(updated.secretConfigured).toBe(true)
    expect(updated.maskedSecret).toBe('sk-1••••cdef')
    expect(store.getSecret('openai')).toBe('sk-1234567890abcdef')

    const preferred = store.getPreferred()
    expect(preferred?.id).toBe('openai')
  })

  it('adds custom provider and allows deletion', async () => {
    const dataDir = await tempDirectory()
    const env: Record<string, string | undefined> = {}
    const store = await AgentConfigStore.open({ dataDir, env })

    const custom = await store.upsert({
      id: 'my-custom-llm',
      name: '私有中转大模型',
      baseUrl: 'https://my-proxy.com/v1',
      model: 'claude-3-5-sonnet',
      secret: 'custom-secret-key-123',
    })

    expect(custom.id).toBe('my-custom-llm')
    expect(store.getPublic('my-custom-llm')).toBeDefined()
    expect(store.getSecret('my-custom-llm')).toBe('custom-secret-key-123')

    const deleted = await store.delete('my-custom-llm')
    expect(deleted).toBe(true)
    expect(store.getPublic('my-custom-llm')).toBeUndefined()
    expect(store.getSecret('my-custom-llm')).toBeUndefined()
  })

  it('persists secrets to envFile atomically', async () => {
    const dataDir = await tempDirectory()
    const envFile = join(dataDir, '.env.local')
    const env: Record<string, string | undefined> = {}
    const store = await AgentConfigStore.open({ dataDir, env, envFile })

    await store.upsert({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      secret: 'sk-deepseek-secret-12345',
    })

    // Reopen store from fresh with empty initial in-memory env
    const reloadedEnv: Record<string, string | undefined> = {}
    // Read from written envFile into reloadedEnv
    const { readFile } = await import('node:fs/promises')
    const fileContent = await readFile(envFile, 'utf8')
    expect(fileContent).toContain('AGENT_LLM_DEEPSEEK_KEY="sk-deepseek-secret-12345"')

    // Simulate dotenv loading into env
    reloadedEnv['AGENT_LLM_DEEPSEEK_KEY'] = 'sk-deepseek-secret-12345'
    const reloadedStore = await AgentConfigStore.open({ dataDir, env: reloadedEnv, envFile })
    expect(reloadedStore.getSecret('deepseek')).toBe('sk-deepseek-secret-12345')
    expect(reloadedStore.getPublic('deepseek')?.secretConfigured).toBe(true)
  })
})
