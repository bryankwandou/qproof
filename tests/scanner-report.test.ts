// Scoring, grading, report building, hashing and input routing in
// src/lib/scanner/index.ts, plus rule metadata consistency.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RULES,
  RULES_VERSION,
  buildReport,
  canonicalReport,
  grade,
  looksLikeIdl,
  reportHash,
  scanRust,
  scanText,
  score,
  toHex,
  type Finding,
  type Severity,
} from "../src/lib/scanner";
import { WEIGHTS } from "../src/lib/scanner/rules";
import { FIXED_VAULT, SAMPLE_IDL, VULNERABLE_VAULT } from "../src/lib/samples";
import { short } from "../src/lib/utils";

const finding = (severity: Severity, ruleId = "QP001", line?: number): Finding => ({ ruleId, title: "t", severity, line, message: "m", fix: "f" });

describe("rule metadata", () => {
  const all = Object.entries(RULES);
  it("has 14 rules with matching ids, titles and summaries", () => {
    expect(all).toHaveLength(14);
    for (const [key, meta] of all) {
      expect(meta.id).toBe(key);
      expect(meta.title.length).toBeGreaterThan(5);
      expect(meta.summary.length).toBeGreaterThan(20);
      expect(Object.keys(WEIGHTS)).toContain(meta.severity);
    }
  });
  it("uses QP0xx for source, QP1xx for IDL, QP2xx for on-chain rules", () => {
    expect(Object.keys(RULES).sort()).toEqual(["QP001", "QP002", "QP003", "QP004", "QP005", "QP006", "QP007", "QP101", "QP102", "QP103", "QP201", "QP202", "QP203", "QP204"]);
  });
  it("weights decrease with severity and info is free", () => {
    expect(WEIGHTS.critical).toBeGreaterThan(WEIGHTS.high);
    expect(WEIGHTS.high).toBeGreaterThan(WEIGHTS.medium);
    expect(WEIGHTS.medium).toBeGreaterThan(WEIGHTS.low);
    expect(WEIGHTS.low).toBeGreaterThan(WEIGHTS.info);
    expect(WEIGHTS.info).toBe(0);
  });
  it("has a versioned rule set", () => {
    expect(RULES_VERSION).toMatch(/^qp-rules-\d+\.\d+\.\d+$/);
  });
});

describe("score", () => {
  it("is 100 with no findings", () => {
    expect(score([])).toBe(100);
  });
  it.each([
    ["critical", 70],
    ["high", 85],
    ["medium", 93],
    ["low", 97],
    ["info", 100],
  ] as [Severity, number][])("one %s finding scores %i", (s, expected) => {
    expect(score([finding(s)])).toBe(expected);
  });
  it("sums penalties", () => {
    expect(score([finding("critical"), finding("high"), finding("medium"), finding("low"), finding("info")])).toBe(100 - 30 - 15 - 7 - 3);
  });
  it("never goes below 0", () => {
    expect(score([finding("critical"), finding("critical"), finding("critical"), finding("critical")])).toBe(0);
  });
});

describe("grade", () => {
  it.each([
    [100, "A"],
    [90, "A"],
    [89, "B"],
    [75, "B"],
    [74, "C"],
    [60, "C"],
    [59, "D"],
    [40, "D"],
    [39, "F"],
    [0, "F"],
  ] as const)("score %i -> %s", (s, g) => {
    expect(grade(s)).toBe(g);
  });
});

describe("buildReport", () => {
  it("sorts by severity, then by line (missing line first)", () => {
    const r = buildReport("rust", "t", [finding("low", "QP006", 1), finding("high", "QP002", 9), finding("critical", "QP001", 5), finding("high", "QP003", 2), finding("high", "QP102")]);
    expect(r.findings.map((f) => `${f.severity}:${f.line ?? "-"}`)).toEqual(["critical:5", "high:-", "high:2", "high:9", "low:1"]);
  });

  it("counts every severity, including zeros", () => {
    const r = buildReport("idl", "t", [finding("high"), finding("high"), finding("info")]);
    expect(r.counts).toEqual({ critical: 0, high: 2, medium: 0, low: 0, info: 1 });
  });

  it("computes score and grade from the findings", () => {
    const r = buildReport("onchain", "Prog", [finding("medium"), finding("info")]);
    expect(r.score).toBe(93);
    expect(r.grade).toBe("A");
    expect(r.rulesVersion).toBe(RULES_VERSION);
    expect(r.source).toBe("onchain");
    expect(r.target).toBe("Prog");
  });

  it("does not mutate the caller's array", () => {
    const input = [finding("low"), finding("critical")];
    buildReport("rust", "t", input);
    expect(input.map((f) => f.severity)).toEqual(["low", "critical"]);
  });

  it("defaults notes to [] and passes notes through", () => {
    expect(buildReport("account", "a", []).notes).toEqual([]);
    expect(buildReport("account", "a", [], ["n1", "n2"]).notes).toEqual(["n1", "n2"]);
  });

  it("an empty report is a perfect A", () => {
    const r = buildReport("rust", "t", []);
    expect([r.score, r.grade, r.findings.length]).toEqual([100, "A", 0]);
  });
});

describe("canonicalReport / reportHash / toHex", () => {
  it("includes only stable fields (not messages, titles or notes)", () => {
    const a = buildReport("rust", "t", [finding("high", "QP002", 3)], ["note A"]);
    const b = buildReport("rust", "t", [{ ...finding("high", "QP002", 3), message: "other", title: "other", fix: "other", snippet: "x" }], ["note B"]);
    expect(canonicalReport(a)).toBe(canonicalReport(b));
    expect(JSON.parse(canonicalReport(a))).toEqual({ v: RULES_VERSION, source: "rust", target: "t", score: 85, findings: [["QP002", "high", 3]] });
  });

  it("encodes a missing line as null", () => {
    expect(JSON.parse(canonicalReport(buildReport("idl", "t", [finding("critical", "QP101")]))).findings).toEqual([["QP101", "critical", null]]);
  });

  it("changes with the target, source and findings", () => {
    const base = canonicalReport(buildReport("rust", "t", [finding("low", "QP006", 1)]));
    expect(canonicalReport(buildReport("rust", "u", [finding("low", "QP006", 1)]))).not.toBe(base);
    expect(canonicalReport(buildReport("idl", "t", [finding("low", "QP006", 1)]))).not.toBe(base);
    expect(canonicalReport(buildReport("rust", "t", [finding("low", "QP006", 2)]))).not.toBe(base);
  });

  it("hashes the canonical string with SHA-256", async () => {
    const r = scanText(VULNERABLE_VAULT, "target");
    const expected = createHash("sha256").update(canonicalReport(r)).digest("hex");
    const h = await reportHash(r);
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h).toHaveLength(32);
    expect(toHex(h)).toBe(expected);
  });

  it("toHex pads single digits and handles empty input", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
    expect(toHex(new Uint8Array())).toBe("");
  });
});

describe("looksLikeIdl", () => {
  it.each([
    ['{"instructions":[]}', true],
    ['  \n {"instructions":[{"name":"a"}]}  ', true],
    [SAMPLE_IDL, true],
    ['{"instructions":{}}', false],
    ['{"name":"x"}', false],
    ["[]", false],
    ["{not json", false],
    ["", false],
    ["fn main() {}", false],
    ["{ fn weird() {} }", false],
  ])("%j -> %s", (text, expected) => {
    expect(looksLikeIdl(text)).toBe(expected);
  });
});

describe("scanText", () => {
  it("routes IDL JSON to the IDL scanner and anything else to the Rust scanner", () => {
    expect(scanText(SAMPLE_IDL).source).toBe("idl");
    expect(scanText(VULNERABLE_VAULT).source).toBe("rust");
    expect(scanText('{"name":"no-instructions"}').source).toBe("rust");
  });

  it("defaults the target to 'source'", () => {
    expect(scanText("fn f() {}").target).toBe("source");
    expect(scanText("fn f() {}", "Prog1").target).toBe("Prog1");
  });

  it("returns a clean report for empty and whitespace input", () => {
    for (const t of ["", " ", "\n\n\t"]) {
      const r = scanText(t);
      expect([r.source, r.score, r.grade, r.findings.length]).toEqual(["rust", 100, "A", 0]);
    }
  });

  it("throws for IDL-shaped JSON with an empty instructions array (UI catches it)", () => {
    expect(() => scanText('{"instructions":[]}')).toThrow(/no instructions/);
  });

  it("matches the vulnerable sample's expected rule set", () => {
    const r = scanText(VULNERABLE_VAULT);
    const got = r.findings.map((f) => `${f.ruleId}:${f.severity}`);
    for (const id of ["QP001:critical", "QP002:high", "QP003:high", "QP004:critical", "QP005:medium", "QP007:medium"]) {
      expect(got).toContain(id);
    }
    expect(r.grade).toBe("F");
    expect(r.counts.critical).toBeGreaterThanOrEqual(2);
  });

  it("the fixed sample has no critical/high/medium findings", () => {
    const r = scanText(FIXED_VAULT);
    expect(r.findings.filter((f) => ["critical", "high", "medium"].includes(f.severity))).toEqual([]);
    expect(r.grade).toBe("A");
  });

  it("the sample IDL triggers each IDL rule", () => {
    const got = new Set(scanText(SAMPLE_IDL).findings.map((f) => f.ruleId));
    expect([...got].sort()).toEqual(["QP101", "QP102", "QP103"]);
  });

  it("produces identical reports and hashes for identical input", async () => {
    const a = scanText(VULNERABLE_VAULT, "x");
    const b = scanText(VULNERABLE_VAULT, "x");
    expect(a).toEqual(b);
    expect(toHex(await reportHash(a))).toBe(toHex(await reportHash(b)));
  });

  it("scanRust on samples agrees with scanText", () => {
    expect(scanText(VULNERABLE_VAULT).findings.length).toBe(scanRust(VULNERABLE_VAULT).length);
  });
});

describe("utils.short", () => {
  it.each([
    ["", 4, ""],
    ["abcdefghi", 4, "abcdefghi"],
    ["abcdefghij", 4, "abcd…ghij"],
    ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", 6, "9WzDXw…YtAWWM"],
  ])("short(%j, %i) = %j", (s, n, out) => {
    expect(short(s, n)).toBe(out);
  });
});
