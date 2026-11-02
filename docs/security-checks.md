# Security and release checks

The `Security analysis` workflow runs real source and history scans in private repositories. It uses Semgrep Community Edition and Gitleaks without signing in to an external scanning platform. Analysis happens inside GitHub Actions; usage metrics and Semgrep version checks are disabled. Reports are retained as Actions artifacts for 14 days under the repository's access controls.

## Gates

| Check | Scope and failure conditions |
| --- | --- |
| Semgrep CE | Runtime source under `src/` and `server/`, startup/build scripts, GitHub workflows and Vite configuration. Findings, analysis errors, unexpected engine versions and missing core-file coverage fail the job. |
| Scanner self-test | A synthetic HTTP-input-to-eval example must be blocked; a corresponding JSON-parsing example must pass. Neither snippet is executed. A broken or empty scanner cannot silently pass. |
| Gitleaks | All reachable Git history, including test files. New leaks fail the job. Reports redact values. `.gitleaksignore` contains only four reviewed historical synthetic-fixture fingerprints. |
| CodeQL | Runs only after the repository is public. Its SARIF upload remains enabled; findings or incomplete local reports fail the job. |
| PR quality gate | Lint, frontend/server tests, performance checks, build, browser smoke, dependency audit and launcher tests on Windows/macOS/Linux. |
| Nightly acceptance | Collaboration, recovery, stress and undo checks, followed by five reviewed Linux visual comparisons. |

Semgrep's source scan excludes `*.test.ts` and `*.test.tsx`, which contain non-shipping mocks and synthetic inputs. These files continue to run in the full test suites and remain included in Git history credential scanning. Production files are not excluded to conceal findings or parser errors. Where required, equivalent JSX entity spelling and quoted TypeScript property names allow complete parsing without changing the UI or serialized field names.

## Private/public behavior

This repository's private stage does **not** run CodeQL with uploading disabled or claim that CodeQL passed. GitHub requires the relevant Code Security entitlement for private CodeQL use. See [GitHub's private-repository requirements](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/private-repository-enablement) and [CodeQL's license](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md).

The workflow includes GitHub's `public` event and a public-repository condition on the CodeQL job. Making the repository public in the future triggers CodeQL on the default branch; pushes, pull requests, scheduled runs and manual dispatch then continue to run it. This configuration does not change repository visibility or purchase any service.

Semgrep CE and CodeQL have different analyses and coverage. A clean CE report is not proof of a clean future CodeQL report or of the absence of vulnerabilities. Findings still require review, and public release should be followed by the actual CodeQL run.

## Reproducible tools and rules

- Semgrep CE is pinned to `1.183.0`; Gitleaks to `8.30.1`, with a pinned binary SHA-256.
- Every GitHub Action is pinned to a full commit SHA.
- `.github/security/semgrep-rules.lock.json` records the upstream rule repository commit, archive SHA-256 and selected file paths. Its selection follows the relevant JavaScript, React, Node.js and CI packs. Rule definitions are fetched at that immutable commit and checksum-verified, not downloaded from a changing registry at scan time.
- Upstream rule text is **not** redistributed in this MIT repository. Fetching preserves selected definitions and the upstream license unchanged in a temporary CI directory. The Semgrep-maintained rules have their own [internal-use license](https://semgrep.dev/legal/rules-license/); they are not MIT-licensed project code.
- No whole-tree suppression, automatic baseline acceptance or `continue-on-error` is used to turn findings into a green status.

Rule updates require reviewing the upstream changes, updating the commit/checksum/file selection, passing the safe/unsafe self-test and reviewing the full new source report. Do not accept a new checksum solely to silence a download mismatch.

## Local reproduction

The application itself does not require Python. To reproduce security CI, use Node.js 22.18+, Python 3.12 and an isolated Python environment:

```bash
python3 -m venv .runtime/security-env
# macOS/Linux; on Windows activate .runtime\security-env\Scripts\activate
. .runtime/security-env/bin/activate
python -m pip install semgrep==1.183.0
python -m unittest discover -s scripts/security -p 'test_*.py'
python scripts/security/fetch_rules.py .github/security/semgrep-rules.lock.json .runtime/security-rules
node scripts/security/check-reports.mjs self-test .runtime/security-rules
semgrep scan --oss-only --metrics off --disable-version-check --strict --error --jobs 2 --timeout 30 \
  --config .runtime/security-rules --exclude '*.test.ts' --exclude '*.test.tsx' \
  --json-output .runtime/semgrep.json --sarif-output .runtime/semgrep.sarif \
  src server scripts .github vite.config.ts
node scripts/security/check-reports.mjs semgrep .runtime/semgrep.json
```

For Gitleaks use the pinned version, verify the release checksum, then run `gitleaks git . --log-opts=--all --redact --report-format sarif --report-path .runtime/gitleaks.sarif` and validate it with `node scripts/security/check-reports.mjs sarif .runtime/gitleaks.sarif`.

Visual baselines use canonical Linux CI; see [visual baseline maintenance](../tests/e2e/visual/README.md). Never replace them with screenshots from a different OS or enable update mode in routine verification.
