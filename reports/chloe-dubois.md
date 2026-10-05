# qproof hardening — Chloé Dubois

Start: 2026-10-05 14:40 WITA. The agent hit the session limit at about 15:49 while
waiting on an e2e run. The coordinator finished the CSP work on 2026-10-05 evening.

Scope: the open items from Lina Marlina's audit and Yusuf Hakim's blueprint check.

## Changes

| Item | Where | Status |
|---|---|---|
| Security headers: CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` | `next.config.mjs` | done |
| CSP `connect-src` limited to the configured devnet and mainnet RPC origins (+ their `wss://`) | `next.config.mjs` | done |
| CSP stays self-only for styles and fonts. The wallet adapter stylesheet `@import`s DM Sans from Google Fonts; that import is removed in the e2e follow-up PR (vendored stylesheet), not allowed in the CSP | `next.config.mjs` | done |
| Upload size cap, 2 MB | `src/app/scan/page.tsx`, `MAX_UPLOAD_BYTES` in `src/lib/chain.ts` | in the MVP commit |
| On-chain IDL cap, 1 MiB compressed and decompressed (`inflateCapped`) | `src/lib/chain.ts` | in the MVP commit |
| Attest only when the RPC reports the devnet genesis hash, not based on the URL text | `src/app/scan/page.tsx:420` | in the MVP commit |
| Broken `attest:sample` script removed | `package.json` | in the MVP commit |
| README: routes, rules, run commands, registry layout, security notes | `README.md` | done |
| postcss override | `package.json` | **not done** |
| Move deployer keypairs out of the project folder | local disk | **not done** (both folders are gitignored, nothing is committed) |

The cap and genesis-check edits were made in files that the MVP commit already
includes, so they ship in PR #1. This PR carries the headers and the README.

## The hydration bug and the fix

With the first version of the CSP, every Playwright test timed out in
`waitForHydration` (`e2e/fixtures.ts:208`): React never attached its props to the
language buttons. Next.js injects inline bootstrap scripts, so `script-src` needs
`'unsafe-inline'` (or nonces via middleware). `'unsafe-eval'` is added only in dev.

Verified on `next start -p 3107` after `npm run build`:
- `/scan` hydrates (the language button has React props within 3 s).
- The only console errors left are the blocked Google Fonts request from the wallet adapter stylesheet. Putri Maharani's follow-up PR removes that request.

Follow-up: replace `'unsafe-inline'` with per-request nonces from middleware.
