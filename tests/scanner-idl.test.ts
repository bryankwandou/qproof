// Positive / negative fixtures for the IDL rules (QP101-QP103) and the IDL
// parser in src/lib/scanner/idl.ts, including malformed input.
import { describe, expect, it } from "vitest";
import { scanIdl } from "../src/lib/scanner";
import { parseIdl } from "../src/lib/scanner/idl";
import { RULES } from "../src/lib/scanner/rules";

type Acc = { name: string; isMut?: boolean; isSigner?: boolean; writable?: boolean; signer?: boolean; accounts?: Acc[]; pda?: unknown };
const ix = (name: string, accounts: Acc[] = [], args: { name: string; type: unknown }[] = []) => ({ name, accounts, args });
const idl = (...instructions: unknown[]) => JSON.stringify({ name: "t", instructions });
const ids = (text: string) => scanIdl(text).map((f) => f.ruleId);

describe("QP101 bump accepted as an instruction argument", () => {
  it.each(["bump", "vaultBump", "BUMP", "bump_seed", "pdaBumpSeed"])("flags argument `%s`", (arg) => {
    const fs = scanIdl(idl(ix("init", [{ name: "payer", isMut: true, isSigner: true }], [{ name: arg, type: "u8" }])));
    expect(fs.map((f) => [f.ruleId, f.severity])).toEqual([["QP101", "critical"]]);
    expect(fs[0].message).toContain("`init`");
    expect(fs[0].message).toContain(`\`${arg}\``);
    expect(fs[0].title).toBe(RULES.QP101.title);
    expect(fs[0].line).toBeUndefined();
  });

  it("flags every bump argument separately", () => {
    const text = idl(ix("init", [], [{ name: "vaultBump", type: "u8" }, { name: "amount", type: "u64" }, { name: "recordBump", type: "u8" }]));
    expect(ids(text)).toEqual(["QP101", "QP101"]);
  });

  it.each(["amount", "seed", "nonce", "authority", "bum"])("is quiet for argument `%s`", (arg) => {
    expect(scanIdl(idl(ix("x", [], [{ name: arg, type: "u64" }])))).toHaveLength(0);
  });

  it("accepts instructions without args or accounts keys", () => {
    expect(scanIdl(idl({ name: "noop" }))).toHaveLength(0);
  });
});

describe("QP102 authority account not marked signer", () => {
  it.each([
    "authority",
    "admin",
    "owner",
    "withdrawer",
    "operator",
    "manager",
    "governor",
    "Authority",
    "mintAuthority",
    "mint_authority",
    "poolAdmin",
    "pool_admin",
    "tokenOwner",
    "token_owner",
  ])("flags `%s` without the signer flag", (name) => {
    const fs = scanIdl(idl(ix("set", [{ name, isMut: false, isSigner: false }, { name: "payer", isMut: false, isSigner: true }])));
    expect(fs.map((f) => [f.ruleId, f.severity])).toEqual([["QP102", "high"]]);
    expect(fs[0].message).toContain(`\`${name}\``);
    expect(fs[0].message).toContain("`set`");
  });

  it.each([
    ["legacy isSigner: false", { name: "admin", isSigner: false }],
    ["0.30 signer: false", { name: "admin", signer: false }],
    ["no signer flag at all", { name: "admin" }],
  ])("flags %s", (_label, acc) => {
    expect(ids(idl(ix("a", [acc as Acc])))).toEqual(["QP102"]);
  });

  it("legacy isSigner takes precedence over the 0.30 signer flag", () => {
    expect(ids(idl(ix("a", [{ name: "admin", isSigner: false, signer: true }])))).toEqual(["QP102"]);
  });

  it("finds authorities inside nested account groups", () => {
    const nested: Acc = { name: "outer", accounts: [{ name: "inner", accounts: [{ name: "admin", isMut: false, isSigner: false }] }] };
    expect(ids(idl(ix("a", [nested, { name: "payer", isSigner: true }])))).toEqual(["QP102"]);
  });

  it.each([
    ["isSigner: true", { name: "authority", isSigner: true }],
    ["signer: true", { name: "authority", signer: true }],
  ])("is quiet when marked %s", (_label, acc) => {
    expect(scanIdl(idl(ix("a", [acc as Acc])))).toHaveLength(0);
  });

  it.each(["vault", "payer", "user", "authorityTokenAccount", "ownerRecord", "owners", "systemProgram", "ADMIN"])(
    "is quiet for non-authority name `%s`",
    (name) => {
      expect(scanIdl(idl(ix("a", [{ name, isSigner: false }])))).toHaveLength(0);
    },
  );

  it.fails("KNOWN BUG idl.ts:51 an Anchor 0.30 PDA authority (has `pda`) cannot sign and should not be flagged", () => {
    const text = idl(ix("withdraw", [{ name: "vaultAuthority", pda: { seeds: [{ kind: "const", value: [118] }] } }, { name: "user", signer: true, writable: true }]));
    expect(ids(text)).not.toContain("QP102");
  });
});

describe("QP103 writable instruction without any signer", () => {
  it.each([
    ["legacy isMut", { name: "state", isMut: true, isSigner: false }],
    ["0.30 writable", { name: "state", writable: true }],
  ])("flags a %s account with no signer", (_label, acc) => {
    const fs = scanIdl(idl(ix("crank", [acc as Acc])));
    expect(fs.map((f) => [f.ruleId, f.severity])).toEqual([["QP103", "medium"]]);
    expect(fs[0].message).toContain("`crank`");
  });

  it("flags writable accounts inside nested groups", () => {
    expect(ids(idl(ix("a", [{ name: "g", accounts: [{ name: "state", writable: true }] }])))).toEqual(["QP103"]);
  });

  it.each([
    ["read-only accounts", [{ name: "state" }, { name: "clock" }]],
    ["writable plus signer", [{ name: "state", writable: true }, { name: "user", signer: true }]],
    ["a writable signer", [{ name: "user", isMut: true, isSigner: true }]],
    ["no accounts", []],
  ])("is quiet for %s", (_label, accounts) => {
    expect(scanIdl(idl(ix("a", accounts as Acc[])))).toHaveLength(0);
  });

  it("counts a signer from a nested group", () => {
    expect(scanIdl(idl(ix("a", [{ name: "state", writable: true }, { name: "g", accounts: [{ name: "user", signer: true }] }])))).toHaveLength(0);
  });
});

describe("IDL scanning across instructions", () => {
  it("orders findings per instruction: QP101, then QP102, then QP103", () => {
    const text = idl(
      ix("first", [{ name: "admin", isMut: true, isSigner: false }], [{ name: "bump", type: "u8" }]),
      ix("second", [{ name: "user", isMut: false, isSigner: true }]),
      ix("third", [{ name: "state", isMut: true }]),
    );
    expect(ids(text)).toEqual(["QP101", "QP102", "QP103", "QP103"]);
    expect(scanIdl(text).map((f) => f.message.match(/`(\w+)`/)?.[1])).toEqual(["first", "first", "first", "third"]);
  });

  it("returns [] for a clean multi-instruction IDL", () => {
    const text = idl(ix("a", [{ name: "authority", isMut: true, isSigner: true }]), ix("b", [{ name: "config" }], [{ name: "amount", type: "u64" }]));
    expect(scanIdl(text)).toEqual([]);
  });

  it("is deterministic", () => {
    const text = idl(ix("a", [{ name: "admin" }, { name: "state", writable: true }], [{ name: "bump", type: "u8" }]));
    expect(scanIdl(text)).toEqual(scanIdl(text));
  });
});

describe("parseIdl", () => {
  it("reads the legacy top-level name", () => {
    expect(parseIdl(JSON.stringify({ name: "vault", instructions: [ix("a")] })).name).toBe("vault");
  });

  it("reads the Anchor 0.30 metadata.name", () => {
    expect(parseIdl(JSON.stringify({ metadata: { name: "vault30" }, instructions: [ix("a")] })).name).toBe("vault30");
  });

  it("falls back to 'program'", () => {
    expect(parseIdl(JSON.stringify({ instructions: [ix("a")] })).name).toBe("program");
  });

  it("returns the instruction list", () => {
    expect(parseIdl(idl(ix("a"), ix("b"))).instructions.map((i) => i.name)).toEqual(["a", "b"]);
  });

  it.each([
    ["an empty instructions array", JSON.stringify({ instructions: [] })],
    ["a missing instructions key", JSON.stringify({ name: "x" })],
    ["instructions as an object", JSON.stringify({ instructions: { a: 1 } })],
    ["instructions as a string", JSON.stringify({ instructions: "a" })],
    ["a JSON array", "[1,2,3]"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseIdl(text)).toThrow(/no instructions/);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["empty string", ""],
    ["truncated JSON", '{"instructions":[{"name":"a"'],
  ])("throws a SyntaxError for %s", (_label, text) => {
    expect(() => parseIdl(text)).toThrow(SyntaxError);
  });

  it("throws (TypeError) for JSON null instead of returning garbage", () => {
    expect(() => parseIdl("null")).toThrow(TypeError);
  });
});

describe("scanIdl on malformed entries", () => {
  it("tolerates accounts and args without names", () => {
    const text = JSON.stringify({ instructions: [{ name: "a", accounts: [{ isMut: true, isSigner: true }], args: [{ type: "u8" }] }] });
    expect(scanIdl(text)).toEqual([]);
  });

  // These currently surface as raw TypeErrors rather than a clear "invalid IDL"
  // message; see the report. Pinned so a behaviour change is noticed.
  it.each([
    ["a null instruction", JSON.stringify({ instructions: [null] })],
    ["accounts as an object", JSON.stringify({ instructions: [{ name: "a", accounts: {} }] })],
    ["a null account", JSON.stringify({ instructions: [{ name: "a", accounts: [null] }] })],
    ["a null arg", JSON.stringify({ instructions: [{ name: "a", args: [null] }] })],
  ])("throws for %s", (_label, text) => {
    expect(() => scanIdl(text)).toThrow(TypeError);
  });
});
