# qproof

qproof is a post-quantum readiness and security scanner for Solana programs, with an on-chain attestation registry. Paste Rust source or an Anchor IDL, or enter a program or account address, and it reports findings with a score. A scan report can be attested on devnet so others can compare its hash.

## Routes

- `/` landing page
- `/scan` scan pasted or uploaded source (.rs, .json, .txt, up to 2 MB), an Anchor IDL, or an on-chain address (devnet or mainnet, read-only); sign an attestation with a wallet
- `/attestations` list, verify and revoke attestations from the registry
- `/docs` rule reference and usage notes

## Scanner rules

Source (Rust):
- QP001 Non-canonical PDA bump (critical)
- QP002 Missing signer check
- QP003 Missing owner check
- QP004 One-time key reuse
- QP005 Unchecked data read
- QP006 Classical-only signatures
- QP007 Unchecked lamport arithmetic

IDL:
- QP101 Bump accepted as instruction argument
- QP102 Authority account not marked signer
- QP103 Writable instruction without any signer

On-chain:
- QP201 Upgrade authority is a single Ed25519 key
- QP202 No public IDL
- QP203 Funds held by an Ed25519-only key
- QP204 Account owned by a single-key upgradeable program

Severities and titles live in `src/lib/scanner/rules.ts`.

## Run

```
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run lint
npm test             # vitest unit tests
npm run build && npm start
npm run e2e          # Playwright, needs a running `next start`
npm run test:program # Rust program tests (cargo)
```

Optional env vars: `NEXT_PUBLIC_RPC_URL` (devnet RPC), `NEXT_PUBLIC_MAINNET_RPC_URL` (read-only scans), `NEXT_PUBLIC_PROGRAM_ID`. These are inlined into the public bundle, so never put a secret RPC key in them.

## Attestation program

`program/` holds the registry program (`program/src/lib.rs`). It has two instructions, attest and revoke, and stores a 128-byte record per PDA with seeds `["attest", attester, target, report_hash]`. The bump is canonical, the attester must sign, and only the attester can revoke. Scores are self-reported by the attester, so treat them as claims, not proof. Deployment on devnet is pending, and the attest button stays disabled until the program account exists.

## Security notes

- Security headers are set in `next.config.mjs`: CSP (connect-src limited to the configured RPC origins), `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin.
- Uploads are capped at 2 MB. On-chain IDLs are capped at 1 MiB, compressed and decompressed.
- Attest is enabled only when the connected RPC reports the devnet genesis hash; the URL text is not trusted.
- The only signing path is the explicit "Sign attestation" click. The app never signs on load.
- Keypairs are gitignored and must stay out of the project folder before any deploy. Set the program upgrade authority to a multisig or make it final.
- Known `npm audit` items (postcss inside Next, jayson via web3.js) are build-time or not reachable from the browser client.
