import { AgentError } from './types.ts'

export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | ('string' | 'number')[]
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false
  items?: Schema; minItems?: number; maxItems?: number
  enum?: unknown[]; minimum?: number; maximum?: number; maxLength?: number; minLength?: number
}
export const string: Schema = { type: 'string', maxLength: 16000 }
export const identifier: Schema = { type: 'string', minLength: 1, maxLength: 256 }
export const number: Schema = { type: 'number', minimum: -1_000_000, maximum: 1_000_000 }
export const boolean: Schema = { type: 'boolean' }
export const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values })
export const bounded = (minimum: number, maximum: number): Schema => ({ type: 'number', minimum, maximum })
export const array = (items: Schema, minItems = 0, maxItems = 100): Schema => ({ type: 'array', items, minItems, maxItems })
export const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })

/** Bounded, closed schemas are also the exact schemas exposed by discovery. */
export function validateCommandSchema(value: unknown, schema: Schema, path = 'parameters'): void {
  const fail = () => { throw new AgentError(400, 'invalid_command_arguments', `${path} 不符合操作契约。`) }
  if (Array.isArray(schema.type)) {
    if (typeof value !== 'string' && typeof value !== 'number') return fail()
    return validateCommandSchema(value, { ...schema, type: typeof value === 'string' ? 'string' : 'number' }, path)
  }
  if (schema.enum && !schema.enum.includes(value)) fail()
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 16000)) fail()
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail()
  } else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail() }
  else if (schema.type === 'array') {
    if (!Array.isArray(value)) return fail()
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) fail()
    value.forEach((v, i) => validateCommandSchema(v, schema.items!, `${path}[${i}]`))
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    const record = value as Record<string, unknown>
    if ((schema.required ?? []).some(k => !Object.hasOwn(record, k))) fail()
    for (const [key, child] of Object.entries(record)) {
      if (!Object.hasOwn(schema.properties!, key)) fail()
      validateCommandSchema(child, schema.properties![key], `${path}.${key}`)
    }
  }
}
