import { describe, expect, it } from 'vitest'
import { checkSemgrep, checkSarif, checkCodeql } from '../scripts/security/check-reports.mjs'

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

const digest = 'a'.repeat(64)
const reviewedResult = () => ({ ruleId: 'js/file-access-to-http', message: { text: 'Expected authentication' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'server/agent/model.ts' } } }], partialFingerprints: { primaryLocationLineHash: 'reviewed:1' } })
const reviews = () => ({ version: 1, sources: { 'server/agent/model.ts': digest }, results: [{ ruleId: 'js/file-access-to-http', path: 'server/agent/model.ts', fingerprint: 'reviewed:1', message: 'Expected authentication', reason: 'Only the selected provider API credential is sent in its Authorization header.' }] })
const reviewedReport = () => { const p = cleanSarif(); p.runs[0].results = [reviewedResult()] as never[]; return p }

describe('explicit CodeQL finding reviews', () => {
  it('reports reviewed findings separately and preserves the raw report', () => {
    const report = reviewedReport(); const original = JSON.stringify(report)
    expect(checkCodeql(report, reviews(), { 'server/agent/model.ts': digest })).toEqual({ runs: 1, findings: 1, reviewed: 1, unreviewed: 0 })
    expect(JSON.stringify(report)).toBe(original)
    expect(() => checkSarif(report)).toThrow()
  })
  it('rejects changed source, fingerprint, rule, file or message', () => {
    expect(() => checkCodeql(reviewedReport(), reviews(), { 'server/agent/model.ts': 'b'.repeat(64) })).toThrow()
    for (const mutate of [
      (r: ReturnType<typeof reviewedResult>) => { r.ruleId = 'js/xss' },
      (r: ReturnType<typeof reviewedResult>) => { r.partialFingerprints.primaryLocationLineHash = 'new:1' },
      (r: ReturnType<typeof reviewedResult>) => { r.message.text = 'New data flow' },
      (r: ReturnType<typeof reviewedResult>) => { r.locations[0].physicalLocation.artifactLocation.uri = 'other.ts' },
    ]) { const p = reviewedReport(); mutate(p.runs[0].results[0] as ReturnType<typeof reviewedResult>); expect(() => checkCodeql(p, reviews(), { 'server/agent/model.ts': digest })).toThrow() }
  })
  it('rejects additional findings, stale reviews and incomplete analyses', () => {
    const p = reviewedReport(); p.runs[0].results.push(reviewedResult() as never)
    expect(() => checkCodeql(p, reviews(), { 'server/agent/model.ts': digest })).toThrow()
    expect(() => checkCodeql(cleanSarif(), reviews(), { 'server/agent/model.ts': digest })).toThrow()
    const failed = reviewedReport(); failed.runs[0].invocations[0].executionSuccessful = false
    expect(() => checkCodeql(failed, reviews(), { 'server/agent/model.ts': digest })).toThrow()
  })
  it('rejects missing review evidence and non-CodeQL reports', () => {
    for (const review of [{}, { ...reviews(), sources: {} }, { ...reviews(), results: [{ ...reviews().results[0], reason: '' }] }]) expect(() => checkCodeql(reviewedReport(), review, { 'server/agent/model.ts': digest })).toThrow()
    const p = reviewedReport(); p.runs[0].tool.driver.name = 'Other scanner'
    expect(() => checkCodeql(p, reviews(), { 'server/agent/model.ts': digest })).toThrow()
  })
})
