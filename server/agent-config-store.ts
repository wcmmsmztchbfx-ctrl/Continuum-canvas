import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicUpdateText, atomicWriteJson } from './atomic-json.ts'

export interface AgentProviderRecord {
  id: string
  name: string
  baseUrl: string
  model: string
  enabled: boolean
  preferred: boolean
  secretEnvName: string
}

export interface PublicAgentProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  enabled: boolean
  preferred: boolean
  secretConfigured: boolean
  maskedSecret?: string
}

export const AGENT_LLM_PRESETS: readonly Omit<AgentProviderRecord, 'secretEnvName'>[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    enabled: true,
    preferred: true,
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    enabled: true,
    preferred: false,
  },
  {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    enabled: true,
    preferred: false,
  },
  {
    id: 'kimi',
    name: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    enabled: true,
    preferred: false,
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    enabled: true,
    preferred: false,
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    enabled: true,
    preferred: false,
  },
  {
    id: 'qianfan',
    name: '百度千帆 (文心一言)',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.0-8k-latest',
    enabled: true,
    preferred: false,
  },
  {
    id: 'lingyi',
    name: '零一万物 (01.AI)',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    model: 'yi-lightning',
    enabled: true,
    preferred: false,
  },
  {
    id: 'baichuan',
    name: '百川智能 (Baichuan)',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    model: 'Baichuan4',
    enabled: true,
    preferred: false,
  },
  {
    id: 'minimax',
    name: 'MiniMax (海螺 AI)',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'abab6.5s-chat',
    enabled: true,
    preferred: false,
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-1-8k',
    enabled: true,
    preferred: false,
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    enabled: true,
    preferred: false,
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容接口',
    baseUrl: 'https://api.example.com/v1',
    model: 'default-model',
    enabled: true,
    preferred: false,
  },
] as const

export class AgentConfigStore {
  private readonly filePath: string
  private readonly env: Record<string, string | undefined>
  private readonly envFile?: string
  private readonly secretFile?: string
  private secrets: Record<string, string>
  private providers: AgentProviderRecord[]

  private constructor(
    filePath: string,
    env: Record<string, string | undefined>,
    providers: AgentProviderRecord[],
    envFile?: string,
    secretFile?: string,
    secrets: Record<string, string> = {},
  ) {
    this.filePath = filePath
    this.env = env
    this.providers = providers
    this.envFile = envFile
    this.secretFile = secretFile
    this.secrets = secrets
  }

  static async open(options: {
    dataDir: string
    env?: Record<string, string | undefined>
    envFile?: string
    secretFile?: string
    seed?: { providers: AgentProviderRecord[]; secrets?: Record<string, string> }
  }): Promise<AgentConfigStore> {
    await mkdir(options.dataDir, { recursive: true })
    const filePath = join(options.dataDir, 'agent-providers.json')

    let loadedProviders: AgentProviderRecord[] = []
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        loadedProviders = parsed.map((item) => ({
          id: String(item.id || ''),
          name: String(item.name || ''),
          baseUrl: String(item.baseUrl || ''),
          model: String(item.model || ''),
          enabled: Boolean(item.enabled),
          preferred: Boolean(item.preferred),
          secretEnvName: String(item.secretEnvName || `AGENT_LLM_${String(item.id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`),
        })).filter((p) => p.id && p.name && p.baseUrl)
      }
    } catch {
      // First run — start with empty list; user adds via presets
    }

    if (loadedProviders.length === 0 && options.seed?.providers) {
      loadedProviders = options.seed.providers.map((provider) => ({ ...provider }))
    }

    // Ensure at most one preferred
    if (loadedProviders.length > 0 && !loadedProviders.some((p) => p.preferred)) {
      loadedProviders[0]!.preferred = true
    }

    let secrets: Record<string, string> = {}
    if (options.secretFile) {
      let secretFileExists = true
      try {
        const parsed: unknown = JSON.parse(await readFile(options.secretFile, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          secrets = Object.fromEntries(Object.entries(parsed).filter(([id, value]) =>
            /^[a-z][a-z0-9-]{0,63}$/.test(id) && typeof value === 'string' && value.length > 0,
          ))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') secretFileExists = false
        else throw error
      }
      if (!secretFileExists && options.seed?.secrets) {
        secrets = Object.fromEntries(Object.entries(options.seed.secrets).filter(([id, value]) =>
          /^[a-z][a-z0-9-]{0,63}$/.test(id) && typeof value === 'string' && value.length > 0,
        ))
      }
    }

    const store = new AgentConfigStore(
      filePath,
      options.env ?? process.env,
      loadedProviders,
      options.envFile,
      options.secretFile,
      secrets,
    )
    await store.persist()
    if (options.secretFile) await store.persistSecrets()
    return store
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, this.providers)
  }

  private async persistEnvSecret(name: string, value?: string): Promise<void> {
    if (!this.envFile) return
    await atomicUpdateText(this.envFile, (source) => {
      const newline = source.includes('\r\n') ? '\r\n' : '\n'
      const assignment = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`)
      const lines = source.split(/\r?\n/)
      while (lines.at(-1) === '') lines.pop()
      const updated = lines.filter((line) => !assignment.test(line))
      if (value !== undefined) updated.push(`${name}=${JSON.stringify(value)}`)
      return updated.length > 0 ? `${updated.join(newline)}${newline}` : ''
    })
  }

  private async persistSecrets(): Promise<void> {
    if (!this.secretFile) return
    await atomicWriteJson(this.secretFile, this.secrets)
  }

  listRecords(): AgentProviderRecord[] {
    return this.providers.map((provider) => ({ ...provider }))
  }

  listSecrets(): Record<string, string> {
    return Object.fromEntries(this.providers.flatMap((provider) => {
      const secret = this.getSecret(provider.id)
      return secret ? [[provider.id, secret]] : []
    }))
  }

  getSecret(id: string): string | undefined {
    const provider = this.providers.find((p) => p.id === id)
    if (!provider) return undefined
    const key = provider.secretEnvName || `AGENT_LLM_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`
    return (this.secretFile ? this.secrets[id] : this.env[key])?.trim() || undefined
  }

  async setSecret(id: string, secret: string): Promise<void> {
    const provider = this.providers.find((p) => p.id === id)
    if (!provider) return
    const key = provider.secretEnvName || `AGENT_LLM_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`
    if (this.secretFile) {
      this.secrets[id] = secret.trim()
      await this.persistSecrets()
    } else {
      this.env[key] = secret.trim()
      await this.persistEnvSecret(key, secret.trim())
    }
  }

  async deleteSecret(id: string): Promise<void> {
    const provider = this.providers.find((p) => p.id === id)
    if (!provider) return
    const key = provider.secretEnvName || `AGENT_LLM_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`
    if (this.secretFile) {
      delete this.secrets[id]
      await this.persistSecrets()
    } else {
      delete this.env[key]
      await this.persistEnvSecret(key)
    }
  }

  toPublic(record: AgentProviderRecord): PublicAgentProvider {
    const secret = this.getSecret(record.id)
    let maskedSecret: string | undefined
    if (secret) {
      if (secret.length > 8) {
        maskedSecret = `${secret.slice(0, 4)}••••${secret.slice(-4)}`
      } else {
        maskedSecret = '••••••••'
      }
    }

    return {
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      model: record.model,
      enabled: record.enabled,
      preferred: record.preferred,
      secretConfigured: Boolean(secret),
      maskedSecret,
    }
  }

  listPublic(): PublicAgentProvider[] {
    return this.providers.map((p) => this.toPublic(p))
  }

  getPublic(id: string): PublicAgentProvider | undefined {
    const record = this.providers.find((p) => p.id === id)
    return record ? this.toPublic(record) : undefined
  }

  getPreferred(): PublicAgentProvider | undefined {
    const preferred = this.providers.find((p) => p.preferred && p.enabled) ||
      this.providers.find((p) => p.enabled && this.getSecret(p.id)) ||
      this.providers.find((p) => p.preferred) ||
      this.providers[0]
    return preferred ? this.toPublic(preferred) : undefined
  }

  async upsert(input: {
    id: string
    name: string
    baseUrl: string
    model: string
    enabled?: boolean
    preferred?: boolean
    secret?: string
  }): Promise<PublicAgentProvider> {
    const id = input.id.trim().toLowerCase()
    const existingIndex = this.providers.findIndex((p) => p.id === id)

    const isPreferred = Boolean(input.preferred)
    if (isPreferred) {
      for (const p of this.providers) {
        p.preferred = false
      }
    }

    const newRecord: AgentProviderRecord = {
      id,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      model: input.model.trim(),
      enabled: input.enabled !== undefined ? input.enabled : true,
      preferred: isPreferred,
      secretEnvName: existingIndex >= 0 ? this.providers[existingIndex]!.secretEnvName : `AGENT_LLM_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`,
    }

    if (existingIndex >= 0) {
      this.providers[existingIndex] = newRecord
    } else {
      this.providers.push(newRecord)
    }

    if (input.secret !== undefined && input.secret.trim()) {
      await this.setSecret(id, input.secret.trim())
    }

    await this.persist()
    return this.toPublic(newRecord)
  }

  async delete(id: string): Promise<boolean> {
    const index = this.providers.findIndex((p) => p.id === id)
    if (index === -1) return false
    await this.deleteSecret(id)
    this.providers.splice(index, 1)
    if (!this.providers.some((p) => p.preferred) && this.providers.length > 0) {
      this.providers[0]!.preferred = true
    }
    await this.persist()
    return true
  }

  async setPreferred(id: string): Promise<PublicAgentProvider | undefined> {
    const target = this.providers.find((p) => p.id === id)
    if (!target) return undefined
    for (const p of this.providers) {
      p.preferred = p.id === id
    }
    await this.persist()
    return this.toPublic(target)
  }

  async testConnection(input: {
    baseUrl: string
    model: string
    secret?: string
    id?: string
  }): Promise<{ ok: boolean; message?: string }> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    const model = input.model.trim()
    const secret = input.secret?.trim() || (input.id ? this.getSecret(input.id) : undefined)

    if (!secret) {
      return { ok: false, message: '未填写 API Key' }
    }

    const endpoint = `${baseUrl}/chat/completions`

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, message: `大模型返回错误 (${res.status}): ${text.slice(0, 150)}` }
      }

      return { ok: true, message: '连接成功！大模型正常响应。' }
    } catch (err: unknown) {
      return { ok: false, message: `请求失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
