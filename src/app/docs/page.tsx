import type { Metadata } from "next";
import Link from "next/link";
import { RULES, RULES_VERSION, WEIGHTS } from "@/lib/scanner/rules";
import { ACCOUNT_SIZE, PROGRAM_ID } from "@/lib/chain";

export const metadata: Metadata = {
  title: "Docs",
  description: "Inputs, rules, scoring and the on-chain attestation format used by qproof.",
};

const SEV_CLASS: Record<string, string> = {
  critical: "text-sev-critical",
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-sev-low",
  info: "text-sev-info",
};

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 leading-relaxed">
      <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-3 text-muted-foreground">
        qproof is a static readiness scanner for Solana programs. It is a set of heuristics, not an audit. A clean
        report means these rules did not match, nothing more.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Inputs</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
        <li><b className="text-foreground">Rust source</b> (native solana-program, Anchor or Pinocchio). Pattern rules QP001 to QP007 run on the text, in your browser.</li>
        <li><b className="text-foreground">Anchor IDL JSON</b> (pre-0.30 and 0.30+ shapes). Rules QP101 to QP103.</li>
        <li><b className="text-foreground">Program ID</b>. Reads the program account, its ProgramData (upgrade authority) and the on-chain Anchor IDL if one exists. Rules QP201, QP202 plus the IDL rules.</li>
        <li><b className="text-foreground">Any other account</b>. Checks whether the address is an on-curve Ed25519 key holding lamports, and whether its owner program has a single-key upgrade authority. Rules QP203, QP204.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold">Networks</h2>
      <p className="mt-3 text-muted-foreground">
        Reads use Solana devnet by default (<code className="font-mono text-sm">NEXT_PUBLIC_RPC_URL</code> overrides it). Mainnet can be selected
        for address scans, but only public read calls (<code className="font-mono text-sm">getAccountInfo</code>) are made against it. Attestations are
        always written to devnet.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Rules ({RULES_VERSION})</h2>
      <div className="mt-4 divide-y rounded-lg border">
        {Object.values(RULES).map((r) => (
          <div key={r.id} className="p-4">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm">{r.id}</span>
              <span className="font-medium">{r.title}</span>
              <span className={`ml-auto text-xs ${SEV_CLASS[r.severity]}`}>{r.severity}</span>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{r.summary}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-xl font-semibold">Scoring</h2>
      <p className="mt-3 text-muted-foreground">
        Score starts at 100. Each finding subtracts:{" "}
        {Object.entries(WEIGHTS)
          .map(([sev, w]) => `${sev} ${w}`)
          .join(", ")}
        . The score never goes below 0. Grades: A at 90+, B at 75+, C at 60+, D at 40+, otherwise F.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Report hash and attestation</h2>
      <p className="mt-3 text-muted-foreground">
        The report hash is SHA-256 over a canonical JSON of the rules version, source type, target, score and the
        (rule, severity, line) of each finding. The registry program stores it in a PDA derived from
        <code className="font-mono text-sm"> [&quot;attest&quot;, attester, target, hash]</code>. The program derives the bump itself
        with find_program_address and never accepts one from the caller. Because the attester is part of the seeds,
        nobody can occupy someone else&apos;s record for the same report, and several people can attest the same report.
      </p>
      <p className="mt-3 text-muted-foreground">
        For pasted source without a program ID, the target is the SHA-256 of the source text read as a public key, so the
        same file always maps to the same target.
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border bg-card p-4 font-mono text-xs">{`Instruction Attest (70 bytes)
  [0]      tag = 0
  [1..33]  target pubkey
  [33..65] report hash
  [65]     score (0..=100)
  [66..70] counts: critical, high, medium, low
Accounts: attester (signer, writable), record PDA (writable), system program

Instruction Revoke (1 byte)
  [0]      tag = 1
Accounts: attester (signer, writable), record PDA (writable)
Only the attester stored in the record can close it; the rent goes back to them.

Record account (${ACCOUNT_SIZE} bytes)
  "QPATTEST" | version | bump | score | counts[4] | pad
  attester(32) | target(32) | hash(32) | unix_ts(i64) | slot(u64)`}</pre>
      <p className="mt-3 text-sm text-muted-foreground">
        Registry program ID: <span className="break-all font-mono">{PROGRAM_ID.toBase58()}</span>
      </p>

      <h2 className="mt-10 text-xl font-semibold">Verifying a report</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
        <li>Run the same input through the <Link className="text-foreground underline underline-offset-2" href="/scan">scanner</Link> with the same rules version, or take the downloaded JSON report.</li>
        <li>Copy the report hash and the target.</li>
        <li>On <Link className="text-foreground underline underline-offset-2" href="/attestations">Attestations</Link>, enter both. Leave the attester empty to see every record for that report, or fill it in to check one specific PDA.</li>
      </ol>

      <h2 className="mt-10 text-xl font-semibold">Limits</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
        <li>Source rules are regex and scope heuristics. They miss checks hidden behind helper functions and can fire on code that is safe for reasons the scanner cannot see.</li>
        <li>No bytecode analysis of deployed programs. Without source or a public IDL, only upgrade-authority facts are available.</li>
        <li>&quot;Quantum exposure&quot; findings describe a long-term risk model, not a present-day exploit.</li>
        <li>Attestations need the registry program on devnet. While it is not deployed, the scanner still works and the attest and verify buttons stay disabled.</li>
      </ul>
    </div>
  );
}
