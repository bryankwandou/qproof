# Andi Pratama - qproof frontend (src/, package.json, configs, README) (IN PROGRESS)

Start: 2026-10-04T18:33:02+08:00 (resumed 2026-10-05T00:11:39+08:00 after the limit reset)

## REQUEST TO FAJAR NUGROHO (tests/)

The registry program in `program/src/lib.rs` now derives the record PDA from
`["attest", attester, target, report_hash]` (attester added to the seeds, plus a
Revoke instruction, tag 1). `src/lib/chain.ts` is being updated to match, so the
helper signature changes:

- `attestationPda(target, hash)` becomes `attestationPda(attester, target, hash)`
- `fetchAttestation(conn, target, hash)` becomes `fetchAttestation(conn, attester, target, hash)`
- new: `revokeIx(attester, record)`, `findAttestations(conn, target, hash)` (all attesters of one report)

`tests/program.test.ts` lines 51 and 82 call `attestationPda(target, h)`. Please
change them to `attestationPda(payer.publicKey, target, h)`. Until then
`npm run typecheck` reports TS2554 in that file only (next build ignores *.test.ts).

(Final report follows when the task is done.)

## Final (completed by coordinator after the agent hit the session limit)
End: 2026-10-05T14:17:39+08:00
- Pages: / , /scan , /attestations , /docs , 404 — all prerender as static.
- `npm run build`: pass (Next 15.5, first-load JS 103–233 kB).
- `npm run typecheck`: pass, after fixing tests/program.test.ts to call `attestationPda(payer.publicKey, target, h)`.
- `npm run lint`: pass, no warnings.
- Open: the `attest:sample` script points to a missing scripts/attest-sample.mjs; there is no README; CSP/frame headers are not set (see lina-marlina.md).
