# Yusuf Hakim - qproof blueprint compliance (read-only review)

Start: 2026-10-05T06:07:02Z
End:   2026-10-05T06:12:00Z

## Spec search result
No blueprint, PLAN, SPEC or README exists. qproof/ has no .md files (outside node_modules), and the parent folder has none mentioning qproof. The only descriptions are the doc comments in program/src/lib.rs:1-22 and the agent reports (FINAL-REPORT.md, lina-marlina.md). package.json refers to a README ("See README.md", chain.ts:5), but it is absent.
So I checked against the implied spec (a Solana post-quantum readiness scanner with an attestation registry) and the brief's known state. This is not a formal blueprint audit.

## Checklist
| Requirement | Status | Evidence |
|---|---|---|
| Written blueprint/spec/README | missing | no *.md in qproof; chain.ts:5 references a missing README |
| Route / | met | src/app/page.tsx (247 lines); build passes |
| Route /scan | met | src/app/scan/page.tsx; upload accepts .rs,.json,.txt (l.223); sample buttons l.208-214 |
| Route /attestations | met | src/app/attestations/page.tsx; sendTransaction l.113; revoke l.112 |
| Route /docs | met | src/app/docs/page.tsx |
| Scanner for Rust source | met | src/lib/scanner/rust.ts (505 lines); rules QP001-QP007 in rules.ts |
| Scanner for IDL | met | scanner/idl.ts; rules QP101-103 |
| Scanner for on-chain program/account | met | scanner/onchain.ts, account.ts; rules QP201-204 |
| Post-quantum angle (classical-only signatures, single Ed25519 authority) | partial | QP006 (low), QP201, QP203 exist; nothing for hash-based or PQ signature migration or scoring. This is a judgement, since there is no spec |
| Attestation program, attest + revoke | met | program/src/lib.rs:5-13, IX_ATTEST/IX_REVOKE |
| Canonical bump, never caller-supplied | met | lib.rs:15-16 |
| Attester in PDA seeds (anti-squat) | met | lib.rs:17-18; chain.ts:32 |
| Signer and owner checks | met | lib.rs ~110-135 (is_signer, IllegalOwner, ERR_UNAUTHORIZED) |
| Only the attester can revoke | met | ERR_UNAUTHORIZED check in revoke |
| Program tests | met | 42/42 pass (reported); program/tests/registry.rs |
| Unit tests | met | vitest 602 pass (31 expected-fail, 6 skipped per FINAL-REPORT) |
| E2E / a11y tests | partial | e2e/*.spec.ts exist; I did not see them run |
| Devnet deploy | missing | faucet 429; PROGRAM_ID default 81k7... in chain.ts:7 is not verified on devnet |
| Security audit | met | agent-reports/lina-marlina.md; PDA bug fixed |
| Audit follow-ups: CSP/frame headers | missing | next.config.mjs has no headers() |
| Audit follow-ups: IDL/upload size cap | missing | no size limit in scan/page.tsx |
| Audit follow-ups: deployer keypair out of project | missing | keys/ folder still inside qproof (names only, contents not opened) |
| Audit follow-ups: postcss override | not verified | not checked |
| scripts/attest-sample.mjs | missing | package.json "attest:sample" points to it; qproof/scripts is empty |
| Mainnet read-only scan | met | chain.ts:11-13 |
| i18n | met | lib/i18n.tsx, providers.tsx |

## Top gaps (priority order)
1. Devnet deploy not done, so the attestation flow has never run end to end on a live cluster. Retry the faucet or fund via another route, then verify PROGRAM_ID.
2. Deployer and program keypairs sit in qproof/keys/. Move them out and confirm they are gitignored.
3. No blueprint or README. Write one (scope, rule list, registry layout) so compliance can be checked.
4. Missing CSP and frame headers in next.config.mjs, and no size cap on upload or IDL input (Lina follow-ups).
5. scripts/attest-sample.mjs is missing, so `npm run attest:sample` is broken.
6. The post-quantum coverage is thin (3 rules) and unspecified.
7. E2E tests were not confirmed passing.

Limits: nothing was run or edited. Build, test and deploy status is taken from the brief and FINAL-REPORT.md. No file with wallet/key/API in its name was opened.
