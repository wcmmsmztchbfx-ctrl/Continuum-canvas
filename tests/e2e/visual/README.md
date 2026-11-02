# Visual baselines

The canonical baselines are the Linux `chrome-desktop` screenshots from the
Nightly CI job (`ubuntu-latest`, Playwright Chromium). Other operating systems
can render fonts differently; do not replace the Linux files with local macOS
or Windows captures.

These five baselines were visually reviewed and copied unchanged from Nightly
run `41416205784`, source commit
`9f70f0954203eb5c2d8524f183bacaec235f345a`. They use the seeded reference canvas
and network-isolated synthetic color-bar media from `tests/fixtures/e2e-env.ts`.
They contain no personal media or external commercial imagery.

Normal verification uses `CI=true npm run test:e2e:visual` and must not update
expectations. For an intentional UI or Linux/browser/font platform change:

1. Use the canonical Linux CI environment with `npm ci` and
   `npx playwright install --with-deps chromium`.
2. Explicitly run `CI=true npm run test:e2e:update-visual`.
3. Review every changed screenshot and its diff for layout, text, fixture media,
   and unintended content before committing the PNGs. Record the source commit
   and platform change in the review.
4. Rerun the visual suite without update mode, then run Nightly CI.

Missing or changed screenshots are failures to review, not a reason to enable
automatic snapshot updates or increase comparison tolerances.
