import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const CORE_FILES = ['src/App.tsx', 'server/http-gateway.ts', 'server/agent/service.ts', 'scripts/launch.mjs', '.github/workflows/codeql.yml']
const ENGINE_VERSION = '1.183.0'

function semgrepShape(report) {
  if (!report || report.version !== ENGINE_VERSION || !Array.isArray(report.results) || !Array.isArray(report.errors) || !Array.isArray(report.paths?.scanned)) throw new Error('Missing/malformed Semgrep report or unexpected engine version')
  if (report.errors.length) throw new Error(`Semgrep reported ${report.errors.length} analysis errors`)
}

export function checkSemgrep(report) {
  semgrepShape(report)
  const scanned = new Set(report.paths.scanned)
  for (const path of CORE_FILES) if (!scanned.has(path)) throw new Error(`Core file was not scanned: ${path}`)
  if (report.results.length) throw new Error(`Semgrep found ${report.results.length} issues; review the report`)
  return { scanned: scanned.size, findings: 0 }
}

export function checkSarif(report) {
  if (report?.version !== '2.1.0' || !Array.isArray(report.runs) || !report.runs.length) throw new Error('Missing/malformed SARIF report')
  let findings = 0
  for (const run of report.runs) {
    if (!run.tool?.driver?.name || !Array.isArray(run.results)) throw new Error('SARIF analysis is incomplete')
    if (run.tool.driver.name === 'CodeQL' && (!Array.isArray(run.invocations) || !run.invocations.length || run.invocations.some(invocation => invocation.executionSuccessful !== true))) throw new Error('CodeQL completion metadata is missing or unsuccessful')
    if (run.invocations?.some(invocation => invocation.executionSuccessful === false || invocation.toolExecutionNotifications?.some(n => n.level === 'error'))) throw new Error('SARIF tool reported an analysis failure')
    findings += run.results.length
  }
  if (findings) throw new Error(`SARIF contains ${findings} findings; review the report`)
  return { runs: report.runs.length, findings }
}

async function canary(rules) {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-security-canary-'))
  try {
    // Inert source files for the scanner; these snippets are never executed.
    for (const [name, source, expected] of [
      ['unsafe.js', 'function handler(req, res) { return eval(req.query.code); }\n', 1],
      ['safe.js', 'function handler(req, res) { return JSON.parse(req.query.json); }\n', 0],
    ]) {
      const file = join(directory, name); await writeFile(file, source)
      const run = spawnSync('semgrep', ['scan', '--oss-only', '--metrics', 'off', '--disable-version-check', '--strict', '--error', '--jobs', '1', '--timeout', '30', '--config', rules, '--json', file], { encoding: 'utf8', maxBuffer: 10_000_000, env: { ...process.env, SEMGREP_SEND_METRICS: 'off' } })
      if (run.error || run.status !== expected) throw new Error(`Scanner self-test ${name} returned ${run.status}: ${run.error?.message || run.stderr}`)
      const report = JSON.parse(run.stdout); semgrepShape(report)
      if ((report.results.length > 0) !== (expected === 1) || !report.paths.scanned.length) throw new Error(`Scanner self-test ${name} did not analyze the expected code`)
    }
    console.log('Scanner self-test passed: unsafe eval blocked, safe JSON accepted')
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function main() {
  const [mode, path] = process.argv.slice(2)
  if (!path) throw new Error('Usage: check-reports.mjs semgrep|sarif|self-test <path>')
  if (mode === 'self-test') return canary(path)
  const report = JSON.parse(await readFile(path, 'utf8'))
  if (mode === 'semgrep') console.log(JSON.stringify(checkSemgrep(report)))
  else if (mode === 'sarif') console.log(JSON.stringify(checkSarif(report)))
  else throw new Error('Unknown security report type')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1 })
