export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  line?: number;
  snippet?: string;
  message: string;
  fix: string;
}

export interface RuleMeta {
  id: string;
  title: string;
  severity: Severity;
  summary: string;
}

export interface ScanReport {
  rulesVersion: string;
  source: "rust" | "idl" | "onchain" | "account";
  target: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  counts: Record<Severity, number>;
  findings: Finding[];
  notes: string[];
}
