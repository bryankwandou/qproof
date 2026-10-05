# Fajar Nugroho - qproof scanner unit tests (IN PROGRESS)

Start: 2026-10-04T18:33:08+08:00

DEPENDENCY REQUEST: add `@vitest/coverage-v8@5.0.3` (exact match for vitest 5.0.3) to devDependencies in qproof/package.json so `npx vitest run --coverage` works without extra flags. Not installed in the project; meanwhile coverage is measured with a copy installed in my scratchpad (no change to package.json, package-lock.json or project node_modules).

(Report will be completed at the end of the task.)

## Final (completed by coordinator after the agent hit the session limit)
End: 2026-10-05T14:17:39+08:00
- Command: `npx vitest run`
- Result: 9 files passed, 1 skipped; 602 tests passed, 31 expected-fail, 6 skipped, 0 failed.
- Fixes applied: the Token Program ID typo in tests/chain-inspect.test.ts; the fetchAttestation test updated to the new PDA seeds [seed, attester, target, hash]; the scratch file tests/_probe.test.ts removed.
- Coverage: not measured, because @vitest/coverage-v8 is not in devDependencies (dependency request above still open).
- tests/program.test.ts skips on Windows (needs a built .so plus a local validator).
