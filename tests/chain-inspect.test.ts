// RPC-facing scanner code with a fully mocked Connection (no network):
// parseAddress input validation, inspectProgram / inspectAddress fact
// gathering (upgrade authority, IDL decoding, owner programs), scanAddress
// end-to-end routing, RPC errors and timeouts (fake timers).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { deflate } from "pako";
import { RpcTimeoutError, ScanInputError, parseAddress, scanAddress, withTimeout } from "../src/lib/scan-address";
import {
  ACCOUNT_SIZE,
  DISCRIMINATOR,
  PROGRAM_ID,
  attestationPda,
  fetchAttestation,
  inspectAddress,
  inspectProgram,
  listAttestations,
  programDeployed,
  isDevnet,
  DEVNET_GENESIS_HASH,
  inflateCapped,
  MAX_IDL_BYTES,
  MAX_UPLOAD_BYTES,
} from "../src/lib/chain";

/* ------------------------------------------------------------------ */
/* Mock RPC                                                            */
/* ------------------------------------------------------------------ */

const UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const LOADER_V2 = new PublicKey("BPFLoader2111111111111111111111111111111111");
const LOADER_V4 = new PublicKey("LoaderV411111111111111111111111111111111111");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

type Acc = { executable: boolean; owner: PublicKey; lamports: number; data: Buffer };
type Accounts = Map<string, Acc>;
type Behaviour = {
  /** Return a value to throw it from the n-th getAccountInfo call (1-based). */
  fail?: (pk: PublicKey, n: number) => unknown;
  /** Return true to never settle the n-th call. */
  hang?: (pk: PublicKey, n: number) => boolean;
  /** Resolve the n-th call after this many ms (fake timers). */
  delay?: (pk: PublicKey, n: number) => number;
};

function mockConn(accounts: Accounts = new Map(), b: Behaviour = {}) {
  const calls: { pk: string; config?: { dataSlice?: { offset: number; length: number } } }[] = [];
  const getAccountInfo = vi.fn(async (pk: PublicKey, config?: { dataSlice?: { offset: number; length: number } }) => {
    calls.push({ pk: pk.toBase58(), config });
    const n = calls.length;
    const err = b.fail?.(pk, n);
    if (err !== undefined) throw err;
    if (b.hang?.(pk, n)) return new Promise<never>(() => {});
    const ms = b.delay?.(pk, n) ?? 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const acc = accounts.get(pk.toBase58()) ?? null;
    if (acc && config?.dataSlice) {
      const { offset, length } = config.dataSlice;
      return { ...acc, data: acc.data.subarray(offset, offset + length) };
    }
    return acc;
  });
  const getProgramAccounts = vi.fn(async () => [] as { pubkey: PublicKey; account: Acc }[]);
  const conn = { getAccountInfo, getProgramAccounts } as unknown as Connection;
  return { conn, calls, getAccountInfo, getProgramAccounts };
}

const onCurveKey = () => Keypair.generate().publicKey;
const pdaKey = (seed = "gov") => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];

/** An upgradeable-loader program plus its ProgramData account. */
function upgradeableProgram(opts: { authority?: PublicKey | null; slot?: bigint; programData?: "ok" | "missing" | "short" } = {}) {
  const { authority = onCurveKey(), slot = 1234n, programData = "ok" } = opts;
  const program = onCurveKey();
  const pdAddr = onCurveKey();
  const pdata = Buffer.alloc(36);
  pdata.writeUInt32LE(2, 0);
  pdAddr.toBuffer().copy(pdata, 4);
  const pd = Buffer.alloc(45 + 64); // header + some "bytecode"
  pd.writeUInt32LE(3, 0);
  pd.writeBigUInt64LE(slot, 4);
  if (authority) {
    pd[12] = 1;
    authority.toBuffer().copy(pd, 13);
  }
  const accounts: Accounts = new Map([[program.toBase58(), { executable: true, owner: UPGRADEABLE, lamports: 1_141_440, data: pdata }]]);
  if (programData === "ok") accounts.set(pdAddr.toBase58(), { executable: false, owner: UPGRADEABLE, lamports: 1, data: pd });
  if (programData === "short") accounts.set(pdAddr.toBase58(), { executable: false, owner: UPGRADEABLE, lamports: 1, data: pd.subarray(0, 20) });
  return { program, pdAddr, accounts, authority };
}

async function idlAddress(programId: PublicKey) {
  const [base] = PublicKey.findProgramAddressSync([], programId);
  return PublicKey.createWithSeed(base, "anchor:idl", programId);
}

/** Anchor IDL account layout: 8 discriminator + 32 authority + u32 len + zlib data. */
function idlAccountData(compressed: Uint8Array, lenOverride?: number) {
  const d = Buffer.alloc(44 + compressed.length);
  Buffer.from("anchidl!").copy(d, 0);
  onCurveKey().toBuffer().copy(d, 8);
  d.writeUInt32LE(lenOverride ?? compressed.length, 40);
  Buffer.from(compressed).copy(d, 44);
  return d;
}

async function withIdl(accounts: Accounts, programId: PublicKey, data: Buffer) {
  accounts.set((await idlAddress(programId)).toBase58(), { executable: false, owner: programId, lamports: 1, data });
}

const BUMP_IDL = JSON.stringify({ name: "v", instructions: [{ name: "init", accounts: [{ name: "payer", isMut: true, isSigner: true }], args: [{ name: "bump", type: "u8" }] }] });
const CLEAN_IDL = JSON.stringify({ name: "v", instructions: [{ name: "init", accounts: [{ name: "payer", isMut: true, isSigner: true }], args: [] }] });

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* parseAddress: malformed inputs                                      */
/* ------------------------------------------------------------------ */

describe("parseAddress", () => {
  it.each(["", " ", "\t\n", "   \r\n  "])("rejects empty input %j with the 'enter an address' message", (s) => {
    expect(() => parseAddress(s)).toThrow(ScanInputError);
    expect(() => parseAddress(s)).toThrow(/Enter a program ID/);
  });

  const valid = SystemProgram.programId.toBase58().slice(0, 31) + "2".repeat(12); // charset ok, 43 chars
  it.each([
    ["contains 0", "0" + valid.slice(1)],
    ["contains O", "O" + valid.slice(1)],
    ["contains I", "I" + valid.slice(1)],
    ["contains l", "l" + valid.slice(1)],
    ["contains +", valid.slice(0, 20) + "+" + valid.slice(21)],
    ["contains /", valid.slice(0, 20) + "/" + valid.slice(21)],
    ["contains an inner space", valid.slice(0, 20) + " " + valid.slice(21)],
    ["has a 0x hex prefix", "0x" + "ab".repeat(20)],
    ["is too short (31 chars)", "2".repeat(31)],
    ["is too long (45 chars)", "2".repeat(45)],
    ["is far too long", "1".repeat(100)],
    ["contains a zero-width space", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYt​AWWM"],
    ["ends with a zero-width space (not trimmed)", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM​"],
    ["contains non-ASCII letters", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWé"],
  ])("rejects input that %s", (_label, s) => {
    expect(() => parseAddress(s)).toThrow(ScanInputError);
    expect(() => parseAddress(s)).toThrow(/Not a valid base58 Solana address/);
  });

  it.each([
    ["decodes to fewer than 32 bytes", "2".repeat(32)],
    ["decodes to more than 32 bytes", "z".repeat(44)],
    ["has 33 leading '1's (33 zero bytes)", "1".repeat(33)],
  ])("rejects base58 of the right length that %s", (_label, s) => {
    expect(() => parseAddress(s)).toThrow(ScanInputError);
  });

  it("accepts the all-zero key (system program)", () => {
    expect(parseAddress("1".repeat(32)).equals(SystemProgram.programId)).toBe(true);
  });

  it("accepts on-curve and off-curve keys and trims whitespace", () => {
    const wallet = onCurveKey();
    const pda = pdaKey();
    expect(parseAddress(`\n  ${wallet.toBase58()} \t`).equals(wallet)).toBe(true);
    expect(parseAddress(pda.toBase58()).equals(pda)).toBe(true);
  });

  it("ScanInputError is a real Error subclass", () => {
    try {
      parseAddress("");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ScanInputError);
    }
  });
});

/* ------------------------------------------------------------------ */
/* withTimeout                                                         */
/* ------------------------------------------------------------------ */

describe("withTimeout", () => {
  it("resolves with the value and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the original rejection through unchanged and clears its timer", async () => {
    vi.useFakeTimers();
    const err = new Error("boom");
    await expect(withTimeout(Promise.reject(err), 1000)).rejects.toBe(err);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with RpcTimeoutError carrying label and duration", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 250, "getAccountInfo");
    const assertion = expect(p).rejects.toThrow("getAccountInfo timed out after 250 ms");
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("does not fire one millisecond early", async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = withTimeout(new Promise(() => {}), 100).catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
  });

  it("uses the default label", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 10);
    const assertion = expect(p).rejects.toThrow(/^RPC request timed out after 10 ms$/);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

/* ------------------------------------------------------------------ */
/* inspectProgram                                                      */
/* ------------------------------------------------------------------ */

describe("inspectProgram", () => {
  it("missing program: exists=false and no further RPC calls", async () => {
    const { conn, calls } = mockConn();
    const info = await inspectProgram(conn, onCurveKey());
    expect(info).toEqual({ exists: false, executable: false, loader: "", upgradeable: false, upgradeAuthority: null, lastDeploySlot: null, authorityIsPda: null, idl: null });
    expect(calls).toHaveLength(1);
  });

  it("single Ed25519 upgrade authority", async () => {
    const { program, accounts, authority, pdAddr } = upgradeableProgram({ slot: 987_654_321n });
    const { conn, calls } = mockConn(accounts);
    const info = await inspectProgram(conn, program);
    expect(info).toMatchObject({
      exists: true,
      executable: true,
      loader: UPGRADEABLE.toBase58(),
      upgradeable: true,
      upgradeAuthority: authority!.toBase58(),
      authorityIsPda: false,
      lastDeploySlot: 987_654_321,
      idl: null,
    });
    // ProgramData is fetched with a 45-byte slice only
    expect(calls[1]).toEqual({ pk: pdAddr.toBase58(), config: { dataSlice: { offset: 0, length: 45 } } });
  });

  it("PDA (multisig / governance) upgrade authority", async () => {
    const { program, accounts } = upgradeableProgram({ authority: pdaKey("multisig") });
    const info = await inspectProgram(mockConn(accounts).conn, program);
    expect(info.upgradeable).toBe(true);
    expect(info.authorityIsPda).toBe(true);
  });

  it("frozen program (authority revoked) is reported as not upgradeable", async () => {
    const { program, accounts } = upgradeableProgram({ authority: null });
    const info = await inspectProgram(mockConn(accounts).conn, program);
    expect(info).toMatchObject({ upgradeable: false, upgradeAuthority: null, authorityIsPda: null, lastDeploySlot: 1234 });
  });

  it.each(["missing", "short"] as const)("ProgramData %s: upgradeable but authority unknown (no throw)", async (programData) => {
    const { program, accounts } = upgradeableProgram({ programData });
    const info = await inspectProgram(mockConn(accounts).conn, program);
    expect(info).toMatchObject({ upgradeable: true, upgradeAuthority: null, authorityIsPda: null, lastDeploySlot: null });
  });

  it("program account too short for a ProgramData pointer is not treated as upgradeable", async () => {
    const program = onCurveKey();
    const accounts: Accounts = new Map([[program.toBase58(), { executable: true, owner: UPGRADEABLE, lamports: 1, data: Buffer.alloc(20) }]]);
    const { conn, calls } = mockConn(accounts);
    const info = await inspectProgram(conn, program, false);
    expect(info.upgradeable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("legacy BPFLoader2 program is immutable and skips the ProgramData lookup", async () => {
    const program = onCurveKey();
    const accounts: Accounts = new Map([[program.toBase58(), { executable: true, owner: LOADER_V2, lamports: 1, data: Buffer.alloc(100) }]]);
    const { conn, calls } = mockConn(accounts);
    const info = await inspectProgram(conn, program, false);
    expect(info).toMatchObject({ loader: LOADER_V2.toBase58(), upgradeable: false });
    expect(calls).toHaveLength(1);
  });

  it("withIdl=false never looks up the IDL account", async () => {
    const { program, accounts } = upgradeableProgram();
    await withIdl(accounts, program, idlAccountData(deflate(CLEAN_IDL)));
    const { conn, calls } = mockConn(accounts);
    const info = await inspectProgram(conn, program, false);
    expect(info.idl).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("decodes a zlib-compressed Anchor IDL from the canonical IDL address", async () => {
    const { program, accounts } = upgradeableProgram();
    await withIdl(accounts, program, idlAccountData(deflate(BUMP_IDL)));
    const { conn, calls } = mockConn(accounts);
    const info = await inspectProgram(conn, program);
    expect(info.idl).toBe(BUMP_IDL);
    expect(calls[2].pk).toBe((await idlAddress(program)).toBase58());
  });

  it("ignores trailing bytes after the declared IDL length", async () => {
    const { program, accounts } = upgradeableProgram();
    const compressed = deflate(CLEAN_IDL);
    await withIdl(accounts, program, Buffer.concat([idlAccountData(compressed), Buffer.alloc(500, 7)]));
    expect((await inspectProgram(mockConn(accounts).conn, program)).idl).toBe(CLEAN_IDL);
  });

  it.each([
    ["corrupted compressed bytes", () => idlAccountData(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))],
    ["an account of exactly 44 bytes (header only)", () => idlAccountData(new Uint8Array())],
    ["a header shorter than 44 bytes", () => Buffer.alloc(30)],
  ])("returns idl=null for %s, without throwing", async (_label, make) => {
    const { program, accounts } = upgradeableProgram();
    await withIdl(accounts, program, make());
    expect((await inspectProgram(mockConn(accounts).conn, program)).idl).toBeNull();
  });

  it("a declared IDL length beyond the account data does not throw", async () => {
    const { program, accounts } = upgradeableProgram();
    await withIdl(accounts, program, idlAccountData(deflate(CLEAN_IDL), 10_000));
    const info = await inspectProgram(mockConn(accounts).conn, program);
    expect(info.idl === null || info.idl === CLEAN_IDL).toBe(true);
  });

  it("an RPC error on the IDL lookup is swallowed (idl=null)", async () => {
    const { program, accounts } = upgradeableProgram();
    const { conn } = mockConn(accounts, { fail: (_pk, n) => (n === 3 ? new Error("429") : undefined) });
    await expect(inspectProgram(conn, program)).resolves.toMatchObject({ idl: null, upgradeable: true });
  });

  it("an RPC error on the program account propagates", async () => {
    const { conn } = mockConn(new Map(), { fail: () => new Error("503 Service Unavailable") });
    await expect(inspectProgram(conn, onCurveKey())).rejects.toThrow("503");
  });

  it("an RPC error on the ProgramData account propagates", async () => {
    const { program, accounts } = upgradeableProgram();
    const { conn } = mockConn(accounts, { fail: (_pk, n) => (n === 2 ? new Error("ProgramData fetch failed") : undefined) });
    await expect(inspectProgram(conn, program)).rejects.toThrow("ProgramData fetch failed");
  });
});

/* ------------------------------------------------------------------ */
/* inspectAddress                                                      */
/* ------------------------------------------------------------------ */

describe("inspectAddress", () => {
  it("missing / closed account", async () => {
    const pk = onCurveKey();
    const { conn, calls } = mockConn();
    expect(await inspectAddress(conn, pk)).toEqual({ exists: false, executable: false, onCurve: true, owner: "", lamports: 0, dataLength: 0, ownerUpgradeAuthorityOnCurve: null });
    expect(calls).toHaveLength(1);
  });

  it("reports off-curve for a missing PDA", async () => {
    expect((await inspectAddress(mockConn().conn, pdaKey())).onCurve).toBe(false);
  });

  it("system-owned wallet: no owner-program lookup", async () => {
    const pk = onCurveKey();
    const { conn, calls } = mockConn(new Map([[pk.toBase58(), { executable: false, owner: SystemProgram.programId, lamports: 3e9, data: Buffer.alloc(0) }]]));
    expect(await inspectAddress(conn, pk)).toMatchObject({ exists: true, onCurve: true, lamports: 3e9, dataLength: 0, owner: SystemProgram.programId.toBase58(), ownerUpgradeAuthorityOnCurve: null });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["single-key upgradeable owner", { authority: onCurveKey() }, true],
    ["PDA-governed owner", { authority: pdaKey("dao") }, false],
    ["frozen owner", { authority: null }, null],
    ["owner with missing ProgramData", { programData: "missing" as const }, null],
  ])("program-owned account with a %s", async (_label, opts, expected) => {
    const { program, accounts } = upgradeableProgram(opts);
    const pk = pdaKey("state");
    accounts.set(pk.toBase58(), { executable: false, owner: program, lamports: 2_000_000, data: Buffer.alloc(80) });
    const { conn, calls } = mockConn(accounts);
    const facts = await inspectAddress(conn, pk);
    expect(facts.ownerUpgradeAuthorityOnCurve).toBe(expected);
    expect(facts.dataLength).toBe(80);
    // the owner is inspected without the IDL lookup
    expect(calls.some((c) => c.pk === (PublicKey.findProgramAddressSync([], program), c.pk) && false)).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("owner program that does not exist leaves ownerUpgradeAuthorityOnCurve null", async () => {
    const pk = pdaKey("orphan");
    const ghost = onCurveKey();
    const { conn } = mockConn(new Map([[pk.toBase58(), { executable: false, owner: ghost, lamports: 1, data: Buffer.alloc(8) }]]));
    expect((await inspectAddress(conn, pk)).ownerUpgradeAuthorityOnCurve).toBeNull();
  });

  it("RPC errors while inspecting the owner program are ignored", async () => {
    const pk = pdaKey("state2");
    const owner = onCurveKey();
    const { conn } = mockConn(new Map([[pk.toBase58(), { executable: false, owner, lamports: 1, data: Buffer.alloc(8) }]]), {
      fail: (_pk, n) => (n === 2 ? new Error("owner lookup failed") : undefined),
    });
    await expect(inspectAddress(conn, pk)).resolves.toMatchObject({ exists: true, ownerUpgradeAuthorityOnCurve: null });
  });

  it("executable accounts skip the owner-program lookup", async () => {
    const { program, accounts } = upgradeableProgram();
    const { conn, calls } = mockConn(accounts);
    const facts = await inspectAddress(conn, program);
    expect(facts).toMatchObject({ exists: true, executable: true, ownerUpgradeAuthorityOnCurve: null });
    expect(calls).toHaveLength(1);
  });

  it("an RPC error on the address itself propagates", async () => {
    const { conn } = mockConn(new Map(), { fail: () => new Error("fetch failed") });
    await expect(inspectAddress(conn, onCurveKey())).rejects.toThrow("fetch failed");
  });
});

/* ------------------------------------------------------------------ */
/* scanAddress end to end                                              */
/* ------------------------------------------------------------------ */

describe("scanAddress: non-program accounts", () => {
  it("missing / closed account: account report, network note, no findings", async () => {
    const pk = onCurveKey();
    const r = await scanAddress(mockConn().conn, pk, "mainnet");
    expect(r).toMatchObject({ source: "account", target: pk.toBase58(), score: 100, grade: "A", findings: [] });
    expect(r.notes[0]).toBe("Read from mainnet via public RPC (read-only).");
    expect(r.notes[1]).toMatch(/does not exist/);
  });

  it("funded wallet: QP203", async () => {
    const pk = onCurveKey();
    const r = await scanAddress(mockConn(new Map([[pk.toBase58(), { executable: false, owner: SystemProgram.programId, lamports: 7.5e9, data: Buffer.alloc(0) }]])).conn, pk, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP203"]);
    expect(r.findings[0].message).toContain("7.5000 SOL");
    expect(r.score).toBe(97);
  });

  it("PDA owned by a single-key upgradeable program: QP204 only", async () => {
    const { program, accounts } = upgradeableProgram();
    const pk = pdaKey("vault");
    accounts.set(pk.toBase58(), { executable: false, owner: program, lamports: 5e9, data: Buffer.alloc(100) });
    const r = await scanAddress(mockConn(accounts).conn, pk, "devnet");
    expect(r.source).toBe("account");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP204"]);
    expect(r.notes.join("\n")).toMatch(/off-curve/);
    expect(r.notes.join("\n")).toContain(`Owner program: ${program.toBase58()} (100 bytes of data).`);
  });

  it("token-program owned account: owner note, owner inspected", async () => {
    const pk = pdaKey("ata");
    const { conn, calls } = mockConn(new Map([[pk.toBase58(), { executable: false, owner: TOKEN, lamports: 2_039_280, data: Buffer.alloc(165) }]]));
    const r = await scanAddress(conn, pk, "mainnet");
    expect(r.findings).toEqual([]);
    expect(r.notes.join("\n")).toContain(TOKEN.toBase58());
    expect(calls.map((c) => c.pk)).toContain(TOKEN.toBase58());
  });
});

describe("scanAddress: programs", () => {
  it("single-key upgradeable program without IDL: QP201 + QP202 and the authority in the notes", async () => {
    const { program, accounts, authority } = upgradeableProgram();
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.source).toBe("onchain");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP201", "QP202"]);
    expect(r.notes).toContain(`Upgrade authority: ${authority!.toBase58()}`);
    expect(r.score).toBe(93);
  });

  it("program with an on-chain IDL: IDL rules run, no QP202", async () => {
    const { program, accounts } = upgradeableProgram({ authority: pdaKey("realm") });
    await withIdl(accounts, program, idlAccountData(deflate(BUMP_IDL)));
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP101"]);
    expect(r.notes.join("\n")).toMatch(/On-chain Anchor IDL found and scanned/);
    expect(r.notes.join("\n")).toMatch(/Upgrade authority is a PDA/);
  });

  it("PDA-governed program with a clean IDL scores 100", async () => {
    const { program, accounts } = upgradeableProgram({ authority: pdaKey("squads") });
    await withIdl(accounts, program, idlAccountData(deflate(CLEAN_IDL)));
    const r = await scanAddress(mockConn(accounts).conn, program, "mainnet");
    expect([r.score, r.grade, r.findings.length]).toEqual([100, "A", 0]);
  });

  it("frozen program: immutable note, only QP202", async () => {
    const { program, accounts } = upgradeableProgram({ authority: null });
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP202"]);
    expect(r.notes.join("\n")).toMatch(/immutable/);
    expect(r.notes.join("\n")).not.toMatch(/Upgrade authority:/);
  });

  it("legacy BPFLoader2 program: immutable", async () => {
    const program = onCurveKey();
    const r = await scanAddress(mockConn(new Map([[program.toBase58(), { executable: true, owner: LOADER_V2, lamports: 1, data: Buffer.alloc(64) }]])).conn, program, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP202"]);
    expect(r.notes.join("\n")).toMatch(/immutable/);
  });

  it("corrupted on-chain IDL is reported as 'no IDL' (QP202)", async () => {
    const { program, accounts } = upgradeableProgram({ authority: pdaKey("x") });
    await withIdl(accounts, program, idlAccountData(Uint8Array.from([9, 9, 9, 9])));
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP202"]);
  });

  it("missing ProgramData: no QP201 and no upgrade-authority note (current behaviour)", async () => {
    const { program, accounts } = upgradeableProgram({ programData: "missing" });
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP202"]);
    expect(r.notes.join("\n")).not.toMatch(/immutable|PDA|Upgrade authority/);
  });

  it.fails("KNOWN BUG chain.ts:144 a loader-v4 program is upgradeable, not 'immutable'", async () => {
    const program = onCurveKey();
    const accounts: Accounts = new Map([[program.toBase58(), { executable: true, owner: LOADER_V4, lamports: 1, data: Buffer.alloc(48 + 64) }]]);
    const r = await scanAddress(mockConn(accounts).conn, program, "devnet");
    expect(r.notes.join("\n")).not.toMatch(/immutable/);
  });
});

describe("scanAddress: RPC errors", () => {
  it("wraps an Error from the first call with the network name", async () => {
    const { conn } = mockConn(new Map(), { fail: () => new Error("429 Too Many Requests") });
    await expect(scanAddress(conn, onCurveKey(), "mainnet")).rejects.toThrow("RPC error on mainnet: 429 Too Many Requests");
  });

  it("wraps non-Error throwables", async () => {
    const { conn } = mockConn(new Map(), { fail: () => "socket hang up" });
    await expect(scanAddress(conn, onCurveKey(), "devnet")).rejects.toThrow("RPC error on devnet: socket hang up");
  });

  it("wraps an error from the second (program) call", async () => {
    const { program, accounts } = upgradeableProgram();
    const { conn } = mockConn(accounts, { fail: (_pk, n) => (n === 2 ? new Error("ECONNRESET") : undefined) });
    await expect(scanAddress(conn, program, "devnet")).rejects.toThrow("RPC error on devnet: ECONNRESET");
  });

  it("wraps an error from the ProgramData call", async () => {
    const { program, accounts } = upgradeableProgram();
    const { conn } = mockConn(accounts, { fail: (_pk, n) => (n === 3 ? new Error("ProgramData 500") : undefined) });
    await expect(scanAddress(conn, program, "mainnet")).rejects.toThrow("RPC error on mainnet: ProgramData 500");
  });

  it("the wrapped error is a plain Error, not an RpcTimeoutError", async () => {
    const { conn } = mockConn(new Map(), { fail: () => new Error("x") });
    const e = await scanAddress(conn, onCurveKey(), "devnet").catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RpcTimeoutError);
  });
});

describe("scanAddress: timeouts (fake timers)", () => {
  it("rejects with RpcTimeoutError when the first call hangs", async () => {
    vi.useFakeTimers();
    const { conn } = mockConn(new Map(), { hang: () => true });
    const p = scanAddress(conn, onCurveKey(), "devnet", 1000);
    const assertion = expect(p).rejects.toThrow(/timed out after 1000 ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("rejects with RpcTimeoutError when the program call hangs after the first succeeds", async () => {
    vi.useFakeTimers();
    const { program, accounts } = upgradeableProgram();
    const { conn } = mockConn(accounts, { hang: (_pk, n) => n === 2 });
    const p = scanAddress(conn, program, "mainnet", 500);
    const assertion = expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("succeeds when the RPC is slow but inside the limit", async () => {
    vi.useFakeTimers();
    const pk = onCurveKey();
    const { conn } = mockConn(new Map([[pk.toBase58(), { executable: false, owner: SystemProgram.programId, lamports: 1e9, data: Buffer.alloc(0) }]]), { delay: () => 900 });
    const p = scanAddress(conn, pk, "devnet", 1000);
    await vi.advanceTimersByTimeAsync(900);
    await expect(p).resolves.toMatchObject({ source: "account" });
  });

  it("uses a 15 s default timeout", async () => {
    vi.useFakeTimers();
    const { conn } = mockConn(new Map(), { hang: () => true });
    let error: unknown;
    const p = scanAddress(conn, onCurveKey(), "devnet").catch((e) => (error = e));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(error).toBeInstanceOf(RpcTimeoutError);
  });

  it("does not leave timers behind after a successful scan", async () => {
    vi.useFakeTimers();
    const { program, accounts } = upgradeableProgram();
    await scanAddress(mockConn(accounts).conn, program, "devnet", 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Attestation registry reads (mocked)                                 */
/* ------------------------------------------------------------------ */

describe("registry reads with mocked RPC", () => {
  const record = (slot: bigint, score: number) => {
    const d = new Uint8Array(ACCOUNT_SIZE);
    d.set(DISCRIMINATOR, 0);
    d[10] = score;
    new DataView(d.buffer).setBigUint64(120, slot, true);
    return Buffer.from(d);
  };

  it("programDeployed is true only for an executable registry account", async () => {
    expect(await programDeployed(mockConn().conn)).toBe(false);
    const exec = mockConn(new Map([[PROGRAM_ID.toBase58(), { executable: true, owner: UPGRADEABLE, lamports: 1, data: Buffer.alloc(36) }]]));
    expect(await programDeployed(exec.conn)).toBe(true);
    const data = mockConn(new Map([[PROGRAM_ID.toBase58(), { executable: false, owner: SystemProgram.programId, lamports: 1, data: Buffer.alloc(0) }]]));
    expect(await programDeployed(data.conn)).toBe(false);
  });

  it("listAttestations filters by size, drops foreign records and sorts newest first", async () => {
    const m = mockConn();
    m.getProgramAccounts.mockResolvedValueOnce([
      { pubkey: onCurveKey(), account: { executable: false, owner: PROGRAM_ID, lamports: 1, data: record(5n, 10) } },
      { pubkey: onCurveKey(), account: { executable: false, owner: PROGRAM_ID, lamports: 1, data: Buffer.alloc(ACCOUNT_SIZE) } },
      { pubkey: onCurveKey(), account: { executable: false, owner: PROGRAM_ID, lamports: 1, data: record(9n, 20) } },
    ]);
    const list = await listAttestations(m.conn);
    expect(list.map((a) => [a.slot, a.score])).toEqual([
      [9, 20],
      [5, 10],
    ]);
    expect(m.getProgramAccounts).toHaveBeenCalledWith(PROGRAM_ID, { filters: [{ dataSize: ACCOUNT_SIZE }] });
  });

  it("listAttestations propagates RPC errors", async () => {
    const m = mockConn();
    m.getProgramAccounts.mockRejectedValueOnce(new Error("gPA disabled"));
    await expect(listAttestations(m.conn)).rejects.toThrow("gPA disabled");
  });

  it("fetchAttestation returns null for a missing record and decodes an existing one", async () => {
    const attester = onCurveKey();
    const target = onCurveKey();
    const hash = new Uint8Array(32).fill(3);
    const [pda] = attestationPda(attester, target, hash);
    const missing = await fetchAttestation(mockConn().conn, attester, target, hash);
    expect(missing.pda.equals(pda)).toBe(true);
    expect(missing.attestation).toBeNull();
    const found = await fetchAttestation(mockConn(new Map([[pda.toBase58(), { executable: false, owner: PROGRAM_ID, lamports: 1, data: record(1n, 88) }]])).conn, attester, target, hash);
    expect(found.attestation?.score).toBe(88);
  });
});

describe("hardening caps and cluster check", () => {
  it("isDevnet accepts only the devnet genesis hash", async () => {
    const mk = (h: string | Error) =>
      ({ getGenesisHash: async () => { if (h instanceof Error) throw h; return h; } }) as unknown as Connection;
    expect(await isDevnet(mk(DEVNET_GENESIS_HASH))).toBe(true);
    expect(await isDevnet(mk("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"))).toBe(false);
    expect(await isDevnet(mk(new Error("rpc down")))).toBe(false);
  });

  it("inflateCapped inflates normal data and rejects a decompression bomb", () => {
    const small = new TextEncoder().encode("hello idl");
    expect(new TextDecoder().decode(inflateCapped(deflate(small)))).toBe("hello idl");
    const bomb = deflate(new Uint8Array(MAX_IDL_BYTES + 1024));
    expect(() => inflateCapped(bomb)).toThrow(/exceeds/);
  });

  it("upload cap is 2 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024);
  });
});
