// Positive and negative fixtures for every rule, plus malformed inputs.
import { describe, expect, it } from "vitest";
import { RULES, scanIdl, scanRust, scanText, onchainFindings, accountFindings, score, grade } from "../src/lib/scanner";
import { looksLikeIdl } from "../src/lib/scanner";

const has = (src: string, id: string) => scanRust(src).some((f) => f.ruleId === id);
const idl = (instructions: unknown[]) => JSON.stringify({ instructions });

const rustCases: { id: string; pos: string[]; neg: string[] }[] = [
  {
    id: "QP001",
    pos: [
      `fn f(p: &Pubkey, data: &[u8]) { let k = Pubkey::create_program_address(&[b"a", &[data[0]]], p); }`,
      `fn f(p: &Pubkey, ix: Ix) { let bump = ix.bump; let k = Pubkey::create_program_address(&[b"a", &[bump]], p); }`,
      `fn f(p: &Pubkey, data: &[u8]) { let bump = data[64]; let seeds = [b"a".as_ref(), &[bump]]; let k = Pubkey::create_program_address(&seeds, p); }`,
    ],
    neg: [
      `fn f(p: &Pubkey) { let (_k, bump) = Pubkey::find_program_address(&[b"a"], p); }`,
      `fn f(p: &Pubkey) { let (_k, b) = Pubkey::find_program_address(&[b"a"], p); let k = Pubkey::create_program_address(&[b"a", &[b]], p); }`,
      `/* Pubkey::create_program_address(&[&[data[0]]], p) */ fn f() {}`,
      `fn f() { let s = "create_program_address(&[&[data[0]]])"; }`.replace("create_program_address(", "create_program_addres("),
    ],
  },
  {
    id: "QP002",
    pos: [
      `fn f(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let admin = next_account_info(it)?; }`,
      `fn f(accounts: &[AccountInfo]) { let [vault, authority] = accounts else { return }; }`,
    ],
    neg: [
      `fn f(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let admin = next_account_info(it)?; if !admin.is_signer { return } }`,
      `fn f(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let vault = next_account_info(it)?; }`,
      `#[derive(Accounts)]\npub struct A<'info> {\n    pub authority: Signer<'info>,\n}`,
    ],
  },
  {
    id: "QP003",
    pos: [`fn f(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let state = next_account_info(it)?; let d = state.try_borrow_data()?; }`],
    neg: [
      `fn f(p: &Pubkey, accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let state = next_account_info(it)?; if state.owner != p { return } let d = state.try_borrow_data()?; }`,
      `fn f(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let state = next_account_info(it)?; }`,
    ],
  },
  {
    id: "QP004",
    pos: [`fn verify(data: &[u8]) { if data.len() < 2 { return } wots_verify(&data[1..]); }`],
    neg: [
      `fn verify(data: &[u8], rec: &mut Rec) { if data.len() < 2 { return } wots_verify(&data[1..]); rec.used = true; }`,
      `fn verify() { ed25519_verify(); }`,
    ],
  },
  {
    id: "QP005",
    pos: [`fn f(data: &[u8]) { let a = data[0]; }`, `fn f(input: &[u8]) { let a = &input[1..33]; }`],
    neg: [`fn f(data: &[u8]) { if data.len() < 33 { return } let a = &data[1..33]; }`, `fn f(data: &[u8]) { let a = data.get(1..33); }`],
  },
  {
    id: "QP006",
    pos: [`use solana_program::secp256k1_recover::secp256k1_recover; fn f() {}`, `use ed25519_dalek::Verifier; fn f() {}`],
    neg: [`fn f() {}`, `use ed25519_dalek; use sphincs; fn f() {}`],
  },
  {
    id: "QP007",
    pos: [`fn f(a: &AccountInfo) { **a.lamports.borrow_mut() -= 5; }`],
    neg: [`fn f(a: &AccountInfo) { let x = a.lamports().checked_sub(5); }`],
  },
];

describe.each(rustCases)("$id fixtures", ({ id, pos, neg }) => {
  it.each(pos.map((s, i) => [i, s]))("positive #%i fires", (_i, s) => {
    expect(has(s as string, id)).toBe(true);
  });
  it.each(neg.map((s, i) => [i, s]))("negative #%i stays quiet", (_i, s) => {
    expect(has(s as string, id)).toBe(false);
  });
});

describe("IDL rule fixtures", () => {
  it("QP101 positive / negative", () => {
    expect(scanIdl(idl([{ name: "a", accounts: [], args: [{ name: "vaultBump", type: "u8" }] }])).map((f) => f.ruleId)).toContain("QP101");
    expect(scanIdl(idl([{ name: "a", accounts: [], args: [{ name: "amount", type: "u64" }] }]))).toHaveLength(0);
  });
  it("QP102 positive / negative, including nested account groups", () => {
    expect(scanIdl(idl([{ name: "a", accounts: [{ name: "g", accounts: [{ name: "admin", isMut: false, isSigner: false }] }] }])).map((f) => f.ruleId)).toContain("QP102");
    expect(scanIdl(idl([{ name: "a", accounts: [{ name: "admin", signer: true }] }]))).toHaveLength(0);
  });
  it("QP103 positive / negative", () => {
    expect(scanIdl(idl([{ name: "crank", accounts: [{ name: "state", writable: true }] }])).map((f) => f.ruleId)).toEqual(["QP103"]);
    expect(scanIdl(idl([{ name: "read", accounts: [{ name: "state" }] }]))).toHaveLength(0);
  });
  it("rejects malformed IDL", () => {
    expect(() => scanIdl("{not json")).toThrow();
    expect(() => scanIdl(JSON.stringify({ instructions: [] }))).toThrow(/no instructions/);
    expect(looksLikeIdl("[1,2]")).toBe(false);
    expect(looksLikeIdl("{bad")).toBe(false);
  });
});

describe("on-chain rule fixtures", () => {
  const base = { executable: true, upgradeable: true, upgradeAuthority: "A", authorityIsPda: false, idl: "{}" };
  it("QP201 fires only for a single-key authority", () => {
    expect(onchainFindings({ ...base, idl: null }).findings.map((f) => f.ruleId)).toContain("QP201");
    expect(onchainFindings({ ...base, authorityIsPda: true, idl: null }).findings.map((f) => f.ruleId)).not.toContain("QP201");
    expect(onchainFindings({ ...base, upgradeable: false, upgradeAuthority: null, idl: null }).notes.join()).toMatch(/immutable/);
  });
  it("QP202 fires only without IDL; unparseable IDL becomes a note", () => {
    expect(onchainFindings({ ...base, idl: null }).findings.map((f) => f.ruleId)).toContain("QP202");
    const r = onchainFindings({ ...base, idl: "garbage" });
    expect(r.findings.map((f) => f.ruleId)).not.toContain("QP202");
    expect(r.notes.join()).toMatch(/could not be parsed/);
  });
  it("non-executable input yields no program findings", () => {
    expect(onchainFindings({ ...base, executable: false }).findings).toHaveLength(0);
  });
  it("QP203 / QP204 account fixtures", () => {
    const a = { exists: true, onCurve: true, owner: "11111111111111111111111111111111", lamports: 1, dataLength: 0, ownerUpgradeAuthorityOnCurve: false };
    expect(accountFindings(a).findings.map((f) => f.ruleId)).toEqual(["QP203"]);
    expect(accountFindings({ ...a, lamports: 0 }).findings).toHaveLength(0);
    expect(accountFindings({ ...a, onCurve: false, ownerUpgradeAuthorityOnCurve: true }).findings.map((f) => f.ruleId)).toEqual(["QP204"]);
    expect(accountFindings({ ...a, onCurve: false, ownerUpgradeAuthorityOnCurve: false }).findings).toHaveLength(0);
  });
});

describe("edge inputs", () => {
  it("every rule id has metadata", () => {
    for (const id of ["QP001", "QP002", "QP003", "QP004", "QP005", "QP006", "QP007", "QP101", "QP102", "QP103", "QP201", "QP202", "QP203", "QP204"]) {
      expect(RULES[id]?.title).toBeTruthy();
    }
  });
  it("empty, whitespace, binary-ish and huge inputs do not throw", () => {
    expect(scanText("").findings).toHaveLength(0);
    expect(scanText("   \n\t").score).toBe(100);
    expect(() => scanText("\u0000\u0001fn {{{{ ((( /* unterminated")).not.toThrow();
    const big = "fn f(data: &[u8]) { let a = data[0]; }\n".repeat(2000);
    const r = scanText(big);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
  it("score floors at 0 and grades map correctly", () => {
    expect(score(Array(50).fill({ ruleId: "QP001", title: "", severity: "critical", message: "", fix: "" }))).toBe(0);
    expect([grade(95), grade(80), grade(65), grade(45), grade(10)]).toEqual(["A", "B", "C", "D", "F"]);
  });
});
