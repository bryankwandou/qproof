# qproof security and supply-chain audit (pre-publish)

- Agent: Lina Marlina
- Started: 2026-10-04T18:33:31+08:00
- Finished: 2026-10-05T00:20:20+08:00
- Target: `qproof/`
- Mode: read-only. No project files were modified and nothing was committed. Secret files were never printed. To check which key matches which program, public keys were derived in memory; no private key bytes were output.
- Snapshot note: other agents kept changing the tree while this audit ran. `program/src/lib.rs` was modified at 18:56, `e2e/*` was added between 18:38 and 18:53, and `tests/_probe.test.ts` appeared at 19:04. I re-checked the findings against the tree as it stood at about 00:15.

## Verdict

**Secrets: OK to publish.** Every keypair and `.env` file in the tree is gitignored, and none of the 57 files git would commit contain a secret. The repo has no commits yet, so there is no history to clean.

**Fix before deploying the attestation feature:** P1, the frontend and program disagree on the PDA seeds. P2 to P5 are hardening items that matter as soon as the app is public and wallet-connected.

---

## 1. Secrets that would be committed

`git ls-files --others --exclude-standard` lists 57 files. I scanned them for keypair byte arrays, base58 secrets, PEM blocks, `api-key=`, Helius, Alchemy and QuickNode URLs, and GitHub, OpenAI and AWS tokens. **None found.**

Keypair-shaped files on disk, all ignored (confirmed with `git check-ignore -v`):

| Path | Ignored by |
|---|---|
| `.devnet-keys/deployer.json` | `.gitignore:20` `.devnet-keys/` |
| `.devnet-keys/fresh-deployer.json` | `.gitignore:20` |
| `.devnet-keys/fresh-program.json` | `.gitignore:20` |
| `.devnet-keys/program.json` (its pubkey is the hardcoded `PROGRAM_ID`) | `.gitignore:20` |
| `keys/deployer.json` | `.gitignore:7` `keys/` |
| `keys/program-keypair.json` | `.gitignore:7` |
| `program/target/deploy/qproof_registry-keypair.json` | `.gitignore:11-12` `program/target/`, `target/` |

- `.env*`: the only one present is `.env.example`, which has an empty value. `.gitignore:5-6` covers `.env*` and re-includes `.env.example`.
- RPC URLs in source are public defaults only (`src/lib/chain.ts:9,11`). There are no keyed URLs anywhere.
- `e2e/test-results`, `e2e/playwright-report` and `e2e/node_modules` are all ignored.
- `package.json` has `"private": true`, so an accidental `npm publish` is blocked.
- On-chain check, read-only: `PROGRAM_ID` 81k7…UsT does **not exist on devnet**. The attest button therefore currently shows "not deployed", and the app never prompts for a signature.

Hardening:
- The deployer keys live inside the project folder. A zip, a `vercel` CLI upload without `.vercelignore`, or a future `.gitignore` edit would ship them. **Fix:** move them to `~/.config/solana/qproof/` and point the scripts there. Add a `gitleaks` or `git-secrets` pre-commit hook.
- `.gitignore` catches keypairs only by directory or by the `*-keypair.json` suffix. A `deployer.json` dropped in the repo root would be committed. **Fix:** add `deployer*.json`, `*keypair*.json` and `*-key.json` to `.gitignore`.
- `.gitignore:7` `keys/` has no leading slash, so it also silently ignores any future `src/**/keys/` source folder. **Fix:** use `/keys/`.

## 2. npm audit

**`npm audit --omit=dev`: 6 total (0 critical, 1 high, 5 moderate)**

| Sev | Package (installed) | Path | Reachable at runtime? |
|---|---|---|---|
| high | postcss 8.4.31 (<=8.5.22): `</style>` XSS in stringify, sourceMappingURL file read / path traversal | bundled by next 15.5.27 | No. It runs at build time on first-party CSS only |
| moderate | next 15.5.27 | via postcss | same as above |
| moderate | @solana/web3.js 1.99.0 | via jayson 4.3.0 | see the next two rows |
| moderate | jayson 4.3.0 | stream-json, uuid | |
| moderate | stream-json 1.9.1: O(depth²) DoS | jayson | No. Only jayson's server-side JSON streaming uses it, not the browser client |
| moderate | uuid 8.3.2: buffer bounds in v3/v5/v6 with `buf` | jayson | No. jayson calls v4 without `buf` |

**Full `npm audit`: 12 total (0 critical, 6 high, 6 moderate).** It adds these dev-only items:
- high: eslint-config-next, @next/eslint-plugin-next, fast-glob, micromatch, braces (braces stack-exhaustion DoS from nested patterns). Lint-time only.
- moderate: litesvm 0.3.3 (via web3.js). Test-only.

Fixes:
- **postcss:** add `"overrides": { "postcss": "^8.5.28" }` to `package.json`, then run `npm install` and confirm `next build` still passes. The alternative is upgrading to next 16.3.8, which bundles postcss 8.5.23 but is a major bump.
- **web3.js / jayson:** do not apply npm's suggested "fix" (web3.js 3.0.0 is semver-major). Accept and document these as not reachable, or test `"overrides": { "jayson": { "uuid": "^11.1.1" } }`. The long-term route is migrating to `@solana/kit`.
- **eslint-config-next:** npm suggests downgrading to 14.2.35, which goes the wrong way. Upgrade it together with next 16, or accept it as dev-only.

## 3. Risky dependencies and supply chain

- Lockfile v3: 625 entries, all resolved from `registry.npmjs.org`, all with integrity hashes. `e2e/package-lock.json` also uses only `registry.npmjs.org`.
- Packages with install scripts: `bufferutil` and `utf-8-validate` (prod; optional native ws accelerators), plus `fsevents` and `unrs-resolver` (dev). All are well known.
- `@solana/web3.js` was hit by a supply-chain compromise in Dec 2024 (1.95.6 and 1.95.7 were malicious). The lock pins 1.99.0, which is fine. **Fix:** pin the key-handling packages exactly (no `^`): `@solana/web3.js` and `@solana/wallet-adapter-*`. Use `npm ci` in CI, and consider `npm ci --ignore-scripts` (the native ws packages fall back to JS).
- `.npmrc:1` sets `legacy-peer-deps=true`, which hides peer-dependency conflicts (for example wallet-adapter-react-ui against React 19.3) for every contributor and CI run. **Fix:** remove it and resolve the conflicts. If it has to stay, add a comment saying why.

## 4. XSS and injection: none found

- There is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` anywhere in `src/`.
- Pasted source, uploaded files, on-chain IDL names (`ix.name`, `a.name`, `arg.name` in `src/lib/scanner/idl.ts:46,60,70`), RPC error messages and decoded attestations are all rendered as React text nodes, so they are auto-escaped (`src/app/scan/page.tsx:211-218,226,317`; `src/app/attestations/page.tsx:113-137`).
- Every `href` is either a hardcoded `REPO_URL` or `explorer()` built from base58 or hex values (`src/lib/chain.ts:18-19`).
- Regexes built from identifiers in user source go through `esc()` (`src/lib/scanner/rust.ts:116,141,307,344,367`).

## 5. SSRF: no attack surface

There are no `app/api` routes, route handlers, server actions or middleware. Every RPC call goes from the browser to fixed endpoints. If an RPC proxy is added later, hardcode the upstream URL on the server, allowlist JSON-RPC methods, and never accept a URL from the client.

## 6. Can the frontend request a signature the user does not expect?

There is exactly one signing path: `src/app/scan/page.tsx:283-284` (`sendTransaction`).
- It only runs from an explicit "Sign attestation" click, and only when `programDeployed()` returns true.
- The app never calls `signMessage` or `signAllTransactions`, and never signs on load. `autoConnect` (`src/components/providers.tsx:17`) only reconnects a wallet the user already approved.
- The transaction holds a single instruction: attester (writable signer), the PDA, and the System Program.

With the current `program/src/lib.rs`, the only debit is rent for 128 bytes, about 0.00178 SOL plus the fee, which is refundable through Revoke.

Still, the instruction passes a **writable signer plus the System Program**, so whatever code sits at `PROGRAM_ID` can move the signer's SOL. That code is decided by two things:
- the `NEXT_PUBLIC_PROGRAM_ID` build variable (P4)
- whoever holds the upgrade authority (P2)

In addition, P1 makes every attest transaction fail as soon as the current program is deployed, and P5 can send the wallet to the wrong cluster.

---

## Prioritized findings

### P1, High: frontend PDA seeds do not match the program, so attest and verify are broken (integrity risk)
- `src/lib/chain.ts:21-23` derives `[SEED, target, hash]`.
- `program/src/lib.rs:73-75,118-121` requires `[SEED, attester, target, hash]` and rejects anything else with `InvalidSeeds`.
- Effects:
  - every attest transaction fails in the wallet's simulation (`scan/page.tsx:283`)
  - the "already attested" check looks up the wrong address (`scan/page.tsx:274`)
  - the Verify box always reports "not found" (`attestations/page.tsx:53`)
  - if someone deploys an older build that keeps the 3-seed derivation, anyone can squat or front-run a record (the reason given at `lib.rs:17-18`)
- The TS LiteSVM test that would catch this skips on Windows (`tests/program.test.ts:14-19`).
- **Fix:**
  - `attestationPda(attester, target, hash)` → `findProgramAddressSync([SEED, attester.toBuffer(), target.toBuffer(), hash], PROGRAM_ID)`. Pass `attester` from `attestIx`.
  - `fetchAttestation(conn, attester, target, hash)`. In `AttestPanel`, run the check only when `publicKey` is set, and add it to the effect deps.
  - For Verify, either add an attester input, or call `getProgramAccounts` with `memcmp` filters `{offset:48, bytes: target.toBase58()}` and `{offset:80, bytes: bs58.encode(hash)}` and list every attester.
  - Run `tests/program.test.ts` in Linux CI so this cannot regress.

### P2, High (before any deploy): the upgrade authority is a hot key inside the project tree
- The program is upgradeable, and the deployer keypair sits at `.devnet-keys/` and `keys/`. A leaked authority key lets an attacker upgrade the program to drain every wallet that signs an attestation (see section 6).
- **Fix:**
  - move the keys out of the repo folder (section 1)
  - after deploying, set the upgrade authority to a Squads multisig, or freeze it with `solana program set-upgrade-authority <PID> --final`
  - never reuse the devnet deployer key on mainnet

### P3, Medium: no CSP or security headers (`next.config.mjs:2-5`)
- This is a wallet-connected dApp. Without `frame-ancestors`, the "Sign attestation" button can be clickjacked, and there is no script or connect allowlist.
- **Fix:** add this to `next.config.mjs`:
  ```js
  const isDev = process.env.NODE_ENV !== "production";
  const rpc = [process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
               process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"]
    .map((u) => new URL(u).origin);
  const ws = rpc.map((o) => o.replace(/^http/, "ws"));
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`, // Next inline RSC scripts; use a nonce via middleware to drop 'unsafe-inline'
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",            // wallet icons are data: URIs
    "font-src 'self'",                        // next/font self-hosts
    `connect-src 'self' ${[...rpc, ...ws].join(" ")}`,
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join("; ");
  const nextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    eslint: { ignoreDuringBuilds: false },
    async headers() {
      return [{ source: "/(.*)", headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ]}];
    },
  };
  ```
- If Mobile Wallet Adapter on Android is supported, test it after adding the CSP. Its local association uses a localhost WebSocket and may need `ws://localhost:*` in `connect-src`. I did not verify this.

### P4, Medium: build-time public env vars control the RPC key and which program users sign for
- `src/lib/chain.ts:9,11`: `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_MAINNET_RPC_URL` are inlined into the public JS. A keyed provider URL (Helius, QuickNode and so on) put there would be visible to every visitor.
- `src/lib/chain.ts:7`: `NEXT_PUBLIC_PROGRAM_ID` silently changes the program the user signs a writable-signer instruction for.
- **Fix:**
  - use only origin-restricted RPC keys, or proxy through a fixed server route as described in section 5
  - hardcode `PROGRAM_ID`, or honor the override only when `NODE_ENV !== "production"`
  - next to the button, show the program ID, the cluster and "cost ≈ 0.0018 SOL rent (refundable) + fee"
  - run `connection.simulateTransaction` before calling the wallet, so a failing transaction never opens a wallet prompt
  - document all three variables in `.env.example`

### P5, Medium: the wallet may be sent to mainnet when a custom devnet RPC is used
- `src/components/providers.tsx:16` passes `RPC_URL` to `ConnectionProvider`. Wallet-standard picks the chain from the endpoint string (`node_modules/@solana/wallet-standard-util/lib/esm/endpoint.js:13-21`). Any URL without the word `devnet` is treated as **mainnet**. The transaction then gets a devnet blockhash while the wallet simulates and sends on mainnet. It fails, but the user sees a mainnet signing prompt.
- **Fix:**
  - before enabling attest, check `await connection.getGenesisHash() === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"` (the devnet genesis hash)
  - reject at build time any `NEXT_PUBLIC_RPC_URL` that does not match `/\bdevnet\b/`, or document the requirement

### P6, Medium-Low: unbounded zlib inflate of attacker-controlled on-chain IDL
- `src/lib/chain.ts:166-170`: `inflate(compressed)` has no output cap. An IDL account can be up to about 10 MB and inflate at roughly 1000:1, so scanning a malicious program can crash the user's tab. `scanIdl` also emits unbounded findings that all get rendered.
- **Fix:**
  ```ts
  import { Inflate } from "pako";
  function inflateCapped(data: Uint8Array, max = 1 << 20): Uint8Array {
    const inf = new Inflate({ chunkSize: 16384 }); const parts: Uint8Array[] = []; let n = 0;
    inf.onData = (c: Uint8Array) => { n += c.length; if (n > max) throw new Error("IDL exceeds 1 MiB"); parts.push(c); };
    inf.push(data, true); if (inf.err) throw new Error(String(inf.msg));
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  ```
  Check this against the pako 3 API, also cap `len` at 1 MiB, and stop `scanIdl` after about 200 findings.

### P7, Low: dependency advisories (section 2)
- Add the `postcss` override now. Track the web3.js/jayson items as not reachable, and the eslint chain as dev-only.

### P8, Low: attestation scores are self-reported, and the listing can be spammed
- `src/app/attestations/page.tsx:93-121` shows each score as plain registry data. The program cannot check the score (`lib.rs:99-103`), so anyone can attest 100/A for any target.
- `src/lib/chain.ts:93-95` runs `getProgramAccounts` without a limit.
- **Fix:**
  - label each score "claimed by <attester>" and explain the recompute-and-compare-hash check
  - add a `memcmp` filter on the `QPATTEST` discriminator at offset 0
  - paginate or cap the rows, and optionally let users filter by a trusted-attester list

### P9, Low: a mainnet scan gets attested on devnet with no cluster recorded
- `src/app/scan/page.tsx:98-99,249,283`: a report from a mainnet scan is attested through the devnet connection, and the 128-byte record has no field for the cluster.
- **Fix:** hide or disable attest when `network === "mainnet"`, or put the cluster into `canonicalReport` (`src/lib/scanner/index.ts:56-64`).

### P10, Low: file upload has no size limit
- `src/app/scan/page.tsx:107-110`: `f.text()` reads any size, and the regex scanner runs on the main thread, so a large file freezes the tab (self-DoS).
- **Fix:** `if (f.size > 512 * 1024) return setError("File too large")`, and consider running the scan in a Web Worker.

### P11, Info: hygiene before publishing
- `tests/_probe.test.ts` is a scratch perf probe and would be committed. Delete it.
- `src/lib/chain.ts:5` and `src/lib/i18n.tsx:81` refer to `REPORT.md` and the README, neither of which exists in the repo.
- `.env.example` documents only `NEXT_PUBLIC_RPC_URL`.
- `scripts/` is empty, yet `package.json` defines `attest:sample` → `scripts/attest-sample.mjs`, which does not exist.
