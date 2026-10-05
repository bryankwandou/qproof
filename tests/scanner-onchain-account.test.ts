// Decision-table tests for the on-chain program rules (QP201, QP202) in
// src/lib/scanner/onchain.ts and the account rules (QP203, QP204) in
// src/lib/scanner/account.ts. Pure functions, no RPC.
import { describe, expect, it } from "vitest";
import { accountFindings, onchainFindings } from "../src/lib/scanner";
import type { AccountFacts } from "../src/lib/scanner/account";
import type { OnchainFacts } from "../src/lib/scanner/onchain";
import { RULES } from "../src/lib/scanner/rules";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGCPFXBDvGgEmhGtrnLwBT1q";
const AUTH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CLEAN_IDL = JSON.stringify({ instructions: [{ name: "a", accounts: [{ name: "user", isMut: true, isSigner: true }], args: [] }] });
const DIRTY_IDL = JSON.stringify({ instructions: [{ name: "init", accounts: [{ name: "state", isMut: true }], args: [{ name: "bump", type: "u8" }] }] });

const program = (o: Partial<OnchainFacts> = {}): OnchainFacts => ({
  executable: true,
  upgradeable: true,
  upgradeAuthority: AUTH,
  authorityIsPda: false,
  idl: CLEAN_IDL,
  ...o,
});
const ruleIds = (r: { findings: { ruleId: string }[] }) => r.findings.map((f) => f.ruleId);

describe("onchainFindings: upgrade authority status (QP201)", () => {
  it("flags a single Ed25519 upgrade key", () => {
    const r = onchainFindings(program());
    expect(ruleIds(r)).toEqual(["QP201"]);
    const [f] = r.findings;
    expect(f.severity).toBe("medium");
    expect(f.title).toBe(RULES.QP201.title);
    expect(f.message).toContain(AUTH);
    expect(f.fix).toMatch(/multisig|governance/);
  });

  it("does not flag a PDA (multisig / governance) authority and notes it", () => {
    const r = onchainFindings(program({ authorityIsPda: true }));
    expect(ruleIds(r)).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/Upgrade authority is a PDA/);
  });

  it("does not flag an immutable program and notes it", () => {
    const r = onchainFindings(program({ upgradeable: false, upgradeAuthority: null, authorityIsPda: null }));
    expect(ruleIds(r)).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/immutable/);
  });

  it("requires an authority string before flagging", () => {
    expect(ruleIds(onchainFindings(program({ upgradeAuthority: null })))).not.toContain("QP201");
    expect(ruleIds(onchainFindings(program({ upgradeAuthority: "" })))).not.toContain("QP201");
  });

  it("requires authorityIsPda to be exactly false", () => {
    expect(ruleIds(onchainFindings(program({ authorityIsPda: null })))).not.toContain("QP201");
  });

  it.fails("KNOWN BUG onchain.ts:28-34 says something when an upgradeable program's authority status is unknown", () => {
    // inspectProgram returns this shape when the ProgramData account is missing or short.
    const r = onchainFindings(program({ upgradeAuthority: null, authorityIsPda: null, idl: CLEAN_IDL }));
    expect(r.notes.join("\n")).toMatch(/upgrade authority/i);
  });
});

describe("onchainFindings: IDL handling (QP202 + IDL rules)", () => {
  it("adds QP202 when no IDL is published", () => {
    const r = onchainFindings(program({ upgradeable: false, upgradeAuthority: null, authorityIsPda: null, idl: null }));
    expect(ruleIds(r)).toEqual(["QP202"]);
    expect(r.findings[0].severity).toBe("info");
  });

  it("treats an empty IDL string as missing", () => {
    expect(ruleIds(onchainFindings(program({ authorityIsPda: true, idl: "" })))).toEqual(["QP202"]);
  });

  it("scans an on-chain IDL and appends its findings after QP201", () => {
    const r = onchainFindings(program({ idl: DIRTY_IDL }));
    expect(ruleIds(r)).toEqual(["QP201", "QP101", "QP103"]);
    expect(r.notes.join("\n")).toMatch(/On-chain Anchor IDL found and scanned/);
  });

  it.each([
    ["garbage text", "garbage"],
    ["IDL without instructions", JSON.stringify({ name: "x", instructions: [] })],
    ["JSON null", "null"],
    ["malformed instruction entry", JSON.stringify({ instructions: [null] })],
  ])("turns an unparseable IDL (%s) into a note, without QP202", (_label, idl) => {
    const r = onchainFindings(program({ authorityIsPda: true, idl }));
    expect(ruleIds(r)).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/could not be parsed/);
  });

  it("always ends with the bytecode note for executables", () => {
    for (const facts of [program(), program({ idl: null }), program({ upgradeable: false, authorityIsPda: true })]) {
      const notes = onchainFindings(facts).notes;
      expect(notes[notes.length - 1]).toMatch(/Bytecode-level checks are not run/);
    }
  });
});

describe("onchainFindings: non-program input", () => {
  it("returns a single note and no findings for a non-executable address", () => {
    const r = onchainFindings(program({ executable: false, idl: DIRTY_IDL }));
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual(["The address is not an executable program on this cluster."]);
  });
});

/* ------------------------------------------------------------------ */

const account = (o: Partial<AccountFacts> = {}): AccountFacts => ({
  exists: true,
  onCurve: true,
  owner: SYSTEM,
  lamports: 5_000_000_000,
  dataLength: 0,
  ownerUpgradeAuthorityOnCurve: null,
  ...o,
});

describe("accountFindings: Ed25519-only key exposure (QP203)", () => {
  it("flags a funded on-curve wallet", () => {
    const r = accountFindings(account());
    expect(ruleIds(r)).toEqual(["QP203"]);
    expect(r.findings[0].severity).toBe("low");
    expect(r.findings[0].title).toBe(RULES.QP203.title);
    expect(r.findings[0].message).toContain("5.0000 SOL");
    expect(r.notes).toEqual([]);
  });

  it.each([
    [1_000_000_000, "1.0000 SOL"],
    [1_234_567_890, "1.2346 SOL"],
    [120_000, "0.0001 SOL"],
    [123_456_789_000_000_000, "123456789.0000 SOL"],
  ])("formats %i lamports as %s", (lamports, text) => {
    expect(accountFindings(account({ lamports })).findings[0].message).toContain(text);
  });

  it("notes an empty on-curve wallet instead of flagging it", () => {
    const r = accountFindings(account({ lamports: 0 }));
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual(["Address is an Ed25519 key but holds no lamports."]);
  });

  it("notes that an off-curve address (PDA) has no private key", () => {
    const r = accountFindings(account({ onCurve: false }));
    expect(r.findings).toEqual([]);
    expect(r.notes[0]).toMatch(/off-curve \(a PDA\)/);
  });

  it.fails("KNOWN BUG account.ts:28 shows a non-zero amount for dust balances (1 lamport prints 0.0000 SOL)", () => {
    expect(accountFindings(account({ lamports: 1 })).findings[0].message).not.toContain(" 0.0000 SOL");
  });

  it.fails("KNOWN BUG account.ts:28 a program-owned account at a keypair address is not a 'plain wallet'", () => {
    // Classic (non-ATA) SPL token account: on-curve address, owned by the token program.
    const r = accountFindings(account({ owner: TOKEN, lamports: 2_039_280, dataLength: 165 }));
    expect(ruleIds(r)).not.toContain("QP203");
  });
});

describe("accountFindings: owner program (notes + QP204)", () => {
  it("adds an owner note for non-system owners, with data length", () => {
    const r = accountFindings(account({ onCurve: false, owner: TOKEN, dataLength: 165 }));
    expect(r.notes).toContain(`Owner program: ${TOKEN} (165 bytes of data).`);
  });

  it("adds no owner note for system-owned accounts", () => {
    expect(accountFindings(account({ lamports: 0 })).notes.join()).not.toMatch(/Owner program/);
  });

  it("flags QP204 when the owner program has a single-key upgrade authority", () => {
    const r = accountFindings(account({ onCurve: false, owner: TOKEN, ownerUpgradeAuthorityOnCurve: true }));
    expect(ruleIds(r)).toEqual(["QP204"]);
    expect(r.findings[0].severity).toBe("info");
    expect(r.findings[0].message).toContain(TOKEN);
  });

  it.each([false, null])("does not flag QP204 when ownerUpgradeAuthorityOnCurve is %s", (v) => {
    expect(ruleIds(accountFindings(account({ onCurve: false, owner: TOKEN, ownerUpgradeAuthorityOnCurve: v })))).toEqual([]);
  });

  it("reports QP203 before QP204 when both apply", () => {
    expect(ruleIds(accountFindings(account({ owner: TOKEN, ownerUpgradeAuthorityOnCurve: true })))).toEqual(["QP203", "QP204"]);
  });
});

describe("accountFindings: closed / missing accounts", () => {
  it("returns only the 'does not exist' note, whatever the other facts say", () => {
    const r = accountFindings(account({ exists: false, onCurve: true, lamports: 9e9, ownerUpgradeAuthorityOnCurve: true, owner: TOKEN }));
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual(["Account does not exist on this cluster."]);
  });

  it("matches the facts inspectAddress returns for a missing account", () => {
    const r = accountFindings({ exists: false, onCurve: true, owner: "", lamports: 0, dataLength: 0, ownerUpgradeAuthorityOnCurve: null });
    expect(r.findings).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });
});
