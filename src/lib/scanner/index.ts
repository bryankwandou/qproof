import { RULES_VERSION, WEIGHTS } from "./rules";
import { scanRust } from "./rust";
import { scanIdl } from "./idl";
import type { Finding, ScanReport, Severity } from "./types";

export * from "./types";
export { RULES, RULES_VERSION } from "./rules";
export { scanRust } from "./rust";
export { scanIdl } from "./idl";

const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function score(findings: Finding[]): number {
  const penalty = findings.reduce((s, f) => s + WEIGHTS[f.severity], 0);
  return Math.max(0, 100 - penalty);
}

export function grade(s: number): ScanReport["grade"] {
  if (s >= 90) return "A";
  if (s >= 75) return "B";
  if (s >= 60) return "C";
  if (s >= 40) return "D";
  return "F";
}

export function buildReport(source: ScanReport["source"], target: string, findings: Finding[], notes: string[] = []): ScanReport {
  const sorted = [...findings].sort(
    (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || (a.line ?? 0) - (b.line ?? 0),
  );
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of sorted) counts[f.severity]++;
  const s = score(sorted);
  return { rulesVersion: RULES_VERSION, source, target, score: s, grade: grade(s), counts, findings: sorted, notes };
}

export function looksLikeIdl(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t);
    return Array.isArray(j.instructions);
  } catch {
    return false;
  }
}

export function scanText(text: string, target = "source"): ScanReport {
  if (looksLikeIdl(text)) return buildReport("idl", target, scanIdl(text));
  return buildReport("rust", target, scanRust(text));
}

/**
 * Canonical string the report hash is computed over. Only stable fields are
 * included so the same input always gives the same hash.
 */
export function canonicalReport(r: ScanReport): string {
  return JSON.stringify({
    v: r.rulesVersion,
    source: r.source,
    target: r.target,
    score: r.score,
    findings: r.findings.map((f) => [f.ruleId, f.severity, f.line ?? null]),
  });
}

export async function reportHash(r: ScanReport): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalReport(r));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export { onchainFindings } from "./onchain";
export { accountFindings } from "./account";
