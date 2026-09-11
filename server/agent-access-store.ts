import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentAccessToken, AgentScope } from '../src/contracts/agent-api.ts'
import { atomicWriteJson } from './atomic-json.ts'

const TOKEN_PREFIX = 'cva_'
const ALL_SCOPES = new Set<AgentScope>([
  'canvas:read',
  'canvas:write',
  'canvas:delete',
  'workflow:approve',
  'director:generate',
])

interface StoredToken extends AgentAccessToken {
  digest: string
}

interface StoredState {
  version: 1
  tokens: StoredToken[]
}

export class AgentAccessError extends Error {
  readonly code = 'agent_access_denied'
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function publicToken(token: StoredToken): AgentAccessToken {
  const { digest: _digest, ...result } = token
  return structuredClone(result)
}

export class AgentAccessStore {
  readonly #filePath: string
  #state: StoredState = { version: 1, tokens: [] }
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(dataDir: string) {
    this.#filePath = join(dataDir, 'agent-access.json')
  }

  static async open(dataDir: string): Promise<AgentAccessStore> {
    const store = new AgentAccessStore(dataDir)
    try {
      const parsed = JSON.parse(await readFile(store.#filePath, 'utf8')) as StoredState
      if (parsed?.version === 1 && Array.isArray(parsed.tokens)) store.#state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return store
  }

  list(): AgentAccessToken[] {
    return this.#state.tokens.map(publicToken)
  }

  create(input: {
    canvasId: string
    projectId: string
    name: string
    scopes?: AgentScope[]
    expiresAt?: string
  }): Promise<{ token: AgentAccessToken; secret: string }> {
    return this.#serial(async () => {
      const scopes = input.scopes ?? [
        'canvas:read', 'canvas:write', 'workflow:approve', 'director:generate',
      ]
      if (!input.canvasId || !input.projectId || !input.name.trim()) {
        throw new AgentAccessError('Agent token scope is invalid')
      }
      if (scopes.length === 0 || scopes.some((scope) => !ALL_SCOPES.has(scope))) {
        throw new AgentAccessError('Agent token permissions are invalid')
      }
      if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
        throw new AgentAccessError('Agent token expiration is invalid')
      }
      const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      const token: StoredToken = {
        id: randomUUID(),
        canvasId: input.canvasId,
        projectId: input.projectId,
        name: input.name.trim().slice(0, 80),
        scopes: [...new Set(scopes)],
        createdAt: new Date().toISOString(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        digest: digest(secret),
      }
      this.#state.tokens.push(token)
      await this.#save()
      return { token: publicToken(token), secret }
    })
  }

  revoke(id: string): Promise<AgentAccessToken> {
    return this.#serial(async () => {
      const token = this.#state.tokens.find((candidate) => candidate.id === id)
      if (!token) throw new AgentAccessError('Agent token was not found')
      token.revokedAt ??= new Date().toISOString()
      await this.#save()
      return publicToken(token)
    })
  }

  authorize(secret: string, input: {
    canvasId: string
    projectId?: string
    scope: AgentScope
  }): AgentAccessToken {
    if (!secret.startsWith(TOKEN_PREFIX)) throw new AgentAccessError('Agent token is required')
    const candidateDigest = digest(secret)
    const now = Date.now()
    const token = this.#state.tokens.find((candidate) => equalDigest(candidate.digest, candidateDigest))
    if (
      !token || token.revokedAt || token.canvasId !== input.canvasId ||
      (input.projectId && token.projectId !== input.projectId) ||
      !token.scopes.includes(input.scope) ||
      (token.expiresAt && Date.parse(token.expiresAt) <= now)
    ) throw new AgentAccessError('Agent token is invalid, expired, or outside its canvas scope')
    return publicToken(token)
  }

  async #save(): Promise<void> {
    await mkdir(join(this.#filePath, '..'), { recursive: true })
    await atomicWriteJson(this.#filePath, this.#state)
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(operation)
    this.#queue = next
    return next
  }
}

export function bearerToken(header: string | undefined): string {
  if (!header) return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? ''
}
