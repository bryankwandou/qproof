# E2E (Playwright) report — Putri Maharani

Start: 2026-10-04 18:33 WITA. The agent wrote the suites, then hit the session limit.
The coordinator ran them and fixed what they found on 2026-10-05.

Suite: 50 tests in `e2e/` (Chromium): page loads with no console errors and no third-party requests, header
navigation and language switch, the scan flow with a mocked RPC (no network), mobile 375px layout, and axe
WCAG A/AA checks. Command: `npm run build && npx playwright test` (the config starts `next start -p 3107`).

## Results

| Run | Passed | Failed | Cause |
|---|---|---|---|
| 1. First CSP version | 1 | 49 | CSP blocked Next's inline bootstrap scripts, so React never hydrated (`fixtures.ts` `waitForHydration` timed out) |
| 2. CSP fixed (Chloé, #2) | 42 | 8 | 6 × the wallet adapter stylesheet requests Google Fonts; 1 × list markup (axe); 1 × mobile overflow on `/attestations` |
| 3. This PR | **50** | **0** | — |

## Bugs found by the suite and fixed here

1. **Third-party font request on every page.** `@solana/wallet-adapter-react-ui/styles.css` starts with an
   `@import` of DM Sans from Google Fonts. That leaks every visitor's IP to Google and breaks a self-only CSP.
   Fix: `src/styles/wallet-adapter.css` is a copy of the stylesheet (v0.9.40) without the import, and
   `providers.tsx` imports it. The CSP stays `style-src 'self' 'unsafe-inline'; font-src 'self' data:`.
2. **Invalid list markup on `/` (axe `list`, `listitem`, serious).** The `Reveal` animation `<div>` sat between
   `<ol>` and `<li>`. Fix: `<li>` is the direct child, with `Reveal` inside it.
3. **Mobile `/attestations` widened the layout viewport to 748px.** The table scrolls inside an
   `overflow-x-auto` box, but its `sr-only` header label is `position: absolute` and the box was not
   positioned, so the label escaped to the page. Fix: `relative` on the scroll box. Checked in the browser:
   page width goes from 747 to 375.
4. **Hero panel text overlap while loading.** The finding row animates its height from 0 without
   `overflow-hidden`, so for ~0.5 s its text was drawn over the score row (visible in the first desktop
   screenshot). Fix: `overflow-hidden` on that row.
5. **Screenshots missed scroll-revealed sections.** `snap()` now scrolls through the page before the
   full-page capture, so the evidence images show every section.

## Evidence

Screenshots from run 3 are in `reports/screenshots/`:

- desktop: `desktop-home.png`, `desktop-scan.png`, `desktop-attestations.png`, `scan-program-report-desktop.png`
- mobile 375px: `mobile-home.png`, `mobile-attestations.png`, `mobile-scan-source-report.png`

Other checks on the same tree: `npm run typecheck` and `npm run lint` clean, Vitest 605 passed / 0 failed.
