# Siti Nurhaliza - qproof program/ (attestation registry) security review, tests, devnet deploy (IN PROGRESS)

Start: 2026-10-04T18:33:23+08:00

Scope: program/ only. (Report will be completed at the end of the task.)

## Final (completed by coordinator after the agent hit the session limit)
End: 2026-10-05T14:17:39+08:00
- Command: `cargo test` in program/
- Result: 42 passed, 0 failed. Against the original binary the agent saw 33 of 42 fail, so the suite does tell old and new behaviour apart.
- The program now uses [seed, attester, target, hash] PDA seeds with a canonical bump; attest and revoke are covered.
- Devnet deploy: NOT done. The devnet faucet returned HTTP 429 (rate limit); no program ID is live on devnet.
- Before any deploy: move the keypairs out of qproof/keys and .devnet-keys, and hand the upgrade authority to a multisig or freeze it (lina-marlina.md, High #2).
