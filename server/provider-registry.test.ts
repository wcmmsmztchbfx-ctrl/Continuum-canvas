import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from './provider-registry.ts'

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'libtv-providers-'))
}

describe('ProviderRegistry', () => {
  it('creates and persists the stable presets (AIStartLab plus OpenAI-compatible samples)', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: {} })

    expect(registry.listPublic()).toEqual([
      expect.objectContaining({
        id: 'aistartlab',
        adapterType: 'aistartlab-openapi',
        baseUrl: 'https://api.video.aistarslab.com/openapi',
        secretEnvName: 'API_PROVIDER_AISTARTLAB_KEY',
        preferred: true,
        available: false,
        secretConfigured: false,
      }),
      expect.objectContaining({
        id: 'openai',
        name: 'OpenAI 官方',
        adapterType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        secretEnvName: 'API_PROVIDER_OPENAI_KEY',
        enabled: false,
        preferred: false,
        available: false,
      }),
      expect.objectContaining({
        id: 'siliconflow',
        name: '硅基流动',
        adapterType: 'openai-compatible',
        baseUrl: 'https://api.siliconflow.cn/v1',
        secretEnvName: 'API_PROVIDER_SILICONFLOW_KEY',
        enabled: false,
        preferred: false,
        available: false,
      }),
      expect.objectContaining({
        id: 'deepseek',
        name: 'DeepSeek',
        adapterType: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        secretEnvName: 'API_PROVIDER_DEEPSEEK_KEY',
        enabled: false,
        preferred: false,
        available: false,
      }),
    ])

    const persisted = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8'))
    expect(persisted[0].id).toBe('aistartlab')
    expect(persisted[0]).not.toHaveProperty('maskedSecret')
    expect(persisted[0]).not.toHaveProperty('secretConfigured')
    expect(persisted.map((record: { id: string }) => record.id)).toEqual([
      'aistartlab',
      'openai',
      'siliconflow',
      'deepseek',
    ])
  })

  it('accepts any HTTPS base URL for openai-compatible providers', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: {} })

    await registry.upsert({
      id: 'custom',
      name: '自定义 OpenAI 兼容',
      adapterType: 'openai-compatible',
      baseUrl: 'https://custom.example.com/v1',
      enabled: true,
      preferred: false,
    })
    const provider = registry.getPublic('custom')
    expect(provider?.baseUrl).toBe('https://custom.example.com/v1')
    expect(provider?.available).toBe(false) // 未配密钥
  })

  it('allows setting secrets for openai-compatible providers', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: {} })

    await registry.setSecret('openai', 'sk-test-123456')
    expect(registry.getSecret('openai')).toBe('sk-test-123456')
    const provider = registry.getPublic('openai')
    expect(provider?.secretConfigured).toBe(true)
    expect(provider?.maskedSecret).toMatch(/^sk-.*3456$/)
  })

  it('masks configured secrets and never includes the plaintext in public state', async () => {
    const dataDir = await tempDirectory()
    const env: Record<string, string> = { API_PROVIDER_AISTARTLAB_KEY: 'test-secret-123456' }
    const registry = await ProviderRegistry.open({ dataDir, env })

    const provider = registry.listPublic()[0]
    expect(provider.available).toBe(true)
    expect(provider.secretConfigured).toBe(true)
    expect(provider.maskedSecret).toMatch(/^tes.*3456$/)
    expect(JSON.stringify(provider)).not.toContain('test-secret-123456')
    expect(registry.getSecret('aistartlab')).toBe('test-secret-123456')
  })

  it('keeps providers with unsupported adapters unavailable', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: { API_PROVIDER_OTHER_KEY: 'configured' } })

    await registry.upsert({
      id: 'other',
      name: 'Other Provider',
      adapterType: 'not-installed',
      baseUrl: 'https://api.example.com',
      enabled: true,
      preferred: false,
    })

    expect(registry.getPublic('other')).toEqual(expect.objectContaining({
      available: false,
      secretConfigured: false,
    }))
    await expect(registry.setSecret('other', 'must-not-be-stored'))
      .rejects.toThrow('does not accept API keys')
  })

  it('locks the AIStartLab adapter to the exact official endpoint', async () => {
    const registry = await ProviderRegistry.open({ dataDir: await tempDirectory(), env: {} })

    await expect(registry.upsert({
      id: 'aistartlab', name: 'AIStartLab', adapterType: 'aistartlab-openapi',
      baseUrl: 'https://evil.example/openapi', enabled: true, preferred: true,
    })).rejects.toThrow('official AIStartLab endpoint')
    await expect(registry.upsert({
      id: 'evil-copy', name: 'AIStartLab Copy', adapterType: 'aistartlab-openapi',
      baseUrl: 'https://127.0.0.1/openapi', enabled: true, preferred: false,
    })).rejects.toThrow('official AIStartLab endpoint')
  })

  it('writes and removes only the provider env secret while exposing a mask', async () => {
    const dataDir = await tempDirectory()
    const envFile = join(dataDir, '.env.local')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(envFile, 'UNRELATED=value\n'))
    const registry = await ProviderRegistry.open({ dataDir, env: {}, envFile })

    await registry.setSecret('aistartlab', 'new-test-secret-9876')
    expect(registry.getPublic('aistartlab')).toEqual(expect.objectContaining({
      secretConfigured: true,
      maskedSecret: expect.stringMatching(/^new.*9876$/),
    }))
    let source = await readFile(envFile, 'utf8')
    expect(source).toContain('UNRELATED=value')
    expect(source).toContain('API_PROVIDER_AISTARTLAB_KEY="new-test-secret-9876"')

    await registry.deleteSecret('aistartlab')
    source = await readFile(envFile, 'utf8')
    expect(source).toContain('UNRELATED=value')
    expect(source).not.toContain('API_PROVIDER_AISTARTLAB_KEY')
    expect(registry.getPublic('aistartlab')?.secretConfigured).toBe(false)
  })

  it('strictly parses persisted records and never exposes unknown fields', async () => {
    const dataDir = await tempDirectory()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dataDir, 'providers.json'), JSON.stringify([
      {
        id: 'safe-provider', name: 'Safe', adapterType: 'not-installed', baseUrl: 'https://api.example.com',
        enabled: true, preferred: false, secretEnvName: 'STEAL_THIS_SECRET', available: true,
      },
      {
        id: '../../bad', name: 'Bad', adapterType: 'aistartlab-openapi', baseUrl: 'https://evil.example',
        enabled: true, preferred: true,
      },
    ])))
    const registry = await ProviderRegistry.open({
      dataDir,
      env: { API_PROVIDER_SAFE_PROVIDER_KEY: 'configured', STEAL_THIS_SECRET: 'do-not-read' },
    })

    const safe = registry.getPublic('safe-provider')
    expect(safe).toEqual(expect.objectContaining({
      id: 'safe-provider', secretEnvName: 'API_PROVIDER_SAFE_PROVIDER_KEY',
      secretConfigured: false, available: false,
    }))
    expect(Object.keys(safe ?? {}).sort()).toEqual([
      'adapterType', 'available', 'baseUrl', 'enabled', 'id', 'imageRequestMode', 'maskedSecret', 'name',
      'preferred', 'secretConfigured', 'secretEnvName',
    ])
    expect(JSON.stringify(safe)).not.toContain('STEAL_THIS_SECRET')
    expect(registry.getPublic('../../bad')).toBeUndefined()
  })

  it('rejects arbitrary secret env names on provider updates', async () => {
    const registry = await ProviderRegistry.open({ dataDir: await tempDirectory(), env: {} })
    await expect(registry.upsert({
      id: 'other', name: 'Other', adapterType: 'not-installed', baseUrl: 'https://api.example.com',
      enabled: true, preferred: false, secretEnvName: 'ARBITRARY_SECRET',
    } as never)).rejects.toThrow('unknown provider field')
  })

  it('serializes 20 concurrent secret updates without losing unrelated entries', async () => {
    const dataDir = await tempDirectory()
    const envFile = join(dataDir, '.env.local')
    await writeFile(envFile, '# local settings\nUNRELATED=value\n\n')
    const registry = await ProviderRegistry.open({ dataDir, env: {}, envFile })
    const ids = Array.from({ length: 20 }, (_, index) => `provider-${index}`)

    for (const [index, id] of ids.entries()) {
      await registry.upsert({
        id,
        name: `Provider ${index}`,
        adapterType: 'not-installed',
        baseUrl: `https://provider-${index}.example.com`,
        enabled: true,
        preferred: false,
      })
    }

    await Promise.all(ids.map((id, index) =>
      expect(registry.setSecret(id, `secret-${index}`)).rejects.toThrow('does not accept API keys'),
    ))

    const source = await readFile(envFile, 'utf8')
    expect(source).toBe('# local settings\nUNRELATED=value\n\n')
  })

  it('persists and exposes imageRequestMode for openai-compatible providers', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: {} })
    await registry.upsert({
      id: 'json-mode',
      name: 'JSON Mode',
      adapterType: 'openai-compatible',
      baseUrl: 'https://json.example/v1',
      enabled: true,
      preferred: false,
      imageRequestMode: 'openai-json',
    })
    expect(registry.getPublic('json-mode')?.imageRequestMode).toBe('openai-json')
    const persisted = JSON.parse(await readFile(join(dataDir, 'providers.json'), 'utf8'))
    expect(persisted.find((record: { id: string }) => record.id === 'json-mode')?.imageRequestMode)
      .toBe('openai-json')
  })

  it('rejects an invalid imageRequestMode value', async () => {
    const dataDir = await tempDirectory()
    const registry = await ProviderRegistry.open({ dataDir, env: {} })
    await expect(registry.upsert({
      id: 'bad-mode',
      name: 'Bad Mode',
      adapterType: 'openai-compatible',
      baseUrl: 'https://bad.example/v1',
      enabled: true,
      preferred: false,
      imageRequestMode: 'bogus' as never,
    })).rejects.toThrow('Invalid provider record')
  })

  it('defaults legacy provider records to imageRequestMode auto', async () => {
    const dataDir = await tempDirectory()
    await writeFile(join(dataDir, 'providers.json'), JSON.stringify([
      {
        id: 'legacy',
        name: 'Legacy',
        adapterType: 'openai-compatible',
        baseUrl: 'https://legacy.example/v1',
        enabled: true,
        preferred: false,
      },
    ]))
    const registry = await ProviderRegistry.open({ dataDir, env: {} })
    expect(registry.getPublic('legacy')?.imageRequestMode).toBe('auto')
  })
})
