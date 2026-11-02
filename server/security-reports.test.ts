import { describe, expect, it } from 'vitest'
import { checkSemgrep, checkSarif } from '../scripts/security/check-reports.mjs'

const cleanSemgrep = () => ({ version: '1.183.0', errors: [], results: [], paths: { scanned: ['src/App.tsx', 'server/http-gateway.ts', 'server/agent/service.ts', 'scripts/launch.mjs', '.github/workflows/codeql.yml'] } })
const cleanSarif = () => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [], invocations: [{ executionSuccessful: true }] }] })

describe('security report gates', () => {
  it('accepts a complete zero-finding Semgrep scan with the expected engine and core file coverage', () => {
    expect(checkSemgrep(cleanSemgrep())).toMatchObject({ scanned: 5, findings: 0 })
  })
  it.each([
    ['a finding', (p: ReturnType<typeof cleanSemgrep>) => { p.results = [{}] as never[] }],
    ['a parse error', (p: ReturnType<typeof cleanSemgrep>) => { p.errors = [{}] as never[] }],
    ['missing core coverage', (p: ReturnType<typeof cleanSemgrep>) => { p.paths.scanned.pop() }],
    ['an unexpected engine', (p: ReturnType<typeof cleanSemgrep>) => { p.version = '0.0.0' }],
  ])('rejects %s', (_name, change) => {
    const report = cleanSemgrep(); change(report)
    expect(() => checkSemgrep(report)).toThrow()
  })
  it('rejects absent or malformed scan output instead of treating it as clean', () => {
    for (const report of [null, {}, { results: [], errors: [] }]) expect(() => checkSemgrep(report)).toThrow()
  })
  it('accepts complete, successful SARIF with no findings', () => {
    expect(checkSarif(cleanSarif())).toMatchObject({ runs: 1, findings: 0 })
  })
  it('rejects findings even when their SARIF level is only note', () => {
    const p = cleanSarif(); p.runs[0].results = [{ level: 'note' }] as never[]
    expect(() => checkSarif(p)).toThrow()
  })
  it('rejects unsuccessful analyses and missing runs/results', () => {
    const p = cleanSarif(); p.runs[0].invocations[0].executionSuccessful = false
    for (const report of [p, {}, { version: '2.1.0', runs: [] }, { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } } }] },
      { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [] }] },
      { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [], invocations: [{}] }] },
    ]) expect(() => checkSarif(report)).toThrow()
  })
})
