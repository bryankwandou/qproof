// RPC-layer tests with a mocked Connection: invalid input, missing / closed
// accounts, non-program accounts, upgradeable programs, RPC errors and timeouts.
import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { parseAddress, scanAddress, withTimeout, RpcTimeoutError, ScanInputError } from "../src/lib/scan-address";
import { ACCOUNT_SIZE, DISCRIMINATOR, PROGRAM_ID, attestIx, decodeAttestation, hexToBytes, inspectProgram, listAttestations } from "../src/lib/chain";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

type Info = { executable: boolean; owner: PublicKey; lamports: number; data: Buffer } | null;
function mockConn(map: Map<string, Info>, opts: { fail?: Error; hang?: boolean } = {}) {
  return {
    getAccountInfo: vi.fn(async (pk: PublicKey) => {
      if (opts.hang) return new Promise(() => {});
      if (opts.fail) throw opts.fail;
      return map.get(pk.toBase58()) ?? null;
    }),
    getProgramAccounts: vi.fn(async () => []),
  } as unknown as Connection;
}

function programWithAuthority(authority: PublicKey | null) {
  const program = Keypair.generate().publicKey;
  const programData = Keypair.generate().publicKey;
  const pdata = Buffer.alloc(4 + 32);
  pdata.writeUInt32LE(2, 0);
  programData.toBuffer().copy(pdata, 4);
  const pd = Buffer.alloc(45);
  pd.writeUInt32LE(3, 0);
  pd.writeBigUInt64LE(1234n, 4);
  if (authority) {
    pd[12] = 1;
    authority.toBuffer().copy(pd, 13);
  }
  const map = new Map<string, Info>([
    [program.toBase58(), { executable: true, owner: LOADER, lamports: 1, data: pdata }],
    [programData.toBase58(), { executable: false, owner: LOADER, lamports: 1, data: pd }],
  ]);
  return { program, map };
}

describe("parseAddress", () => {
  it.each(["", "   ", "not-base58!", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", "abc", "1".repeat(60), "0x1234"])("rejects %j", (s) => {
    expect(() => parseAddress(s)).toThrow(ScanInputError);
  });
  it("accepts and trims a valid key", () => {
    expect(parseAddress(`  ${SystemProgram.programId.toBase58()}\n`).equals(SystemProgram.programId)).toBe(true);
  });
});

describe("scanAddress with mocked RPC", () => {
  it("missing / closed account: no findings, explanatory note", async () => {
    const pk = Keypair.generate().publicKey;
    const r = await scanAddress(mockConn(new Map()), pk, "devnet");
    expect(r.source).toBe("account");
    expect(r.findings).toHaveLength(0);
    expect(r.notes.join()).toMatch(/does not exist/);
  });
  it("funded wallet (non-program) gets QP203", async () => {
    const pk = Keypair.generate().publicKey;
    const r = await scanAddress(mockConn(new Map([[pk.toBase58(), { executable: false, owner: SystemProgram.programId, lamports: 2e9, data: Buffer.alloc(0) }]])), pk, "mainnet");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP203"]);
    expect(r.notes[0]).toMatch(/mainnet .*read-only/);
  });
  it("upgradeable program with single-key authority gets QP201 + QP202", async () => {
    const { program, map } = programWithAuthority(Keypair.generate().publicKey);
    const r = await scanAddress(mockConn(map), program, "devnet");
    expect(r.source).toBe("onchain");
    expect(r.findings.map((f) => f.ruleId).sort()).toEqual(["QP201", "QP202"]);
  });
  it("program whose authority is a PDA is not flagged QP201", async () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("gov")], PROGRAM_ID);
    const { program, map } = programWithAuthority(pda);
    const info = await inspectProgram(mockConn(map), program);
    expect(info.authorityIsPda).toBe(true);
    expect(info.lastDeploySlot).toBe(1234);
  });
  it("frozen (authority revoked) program is reported immutable", async () => {
    const { program, map } = programWithAuthority(null);
    const info = await inspectProgram(mockConn(map), program);
    expect(info.upgradeable).toBe(false);
  });
  it("RPC errors are wrapped with the network name", async () => {
    await expect(scanAddress(mockConn(new Map(), { fail: new Error("429 Too Many Requests") }), Keypair.generate().publicKey, "devnet")).rejects.toThrow(/RPC error on devnet: 429/);
  });
  it("RPC timeouts reject with RpcTimeoutError", async () => {
    await expect(scanAddress(mockConn(new Map(), { hang: true }), Keypair.generate().publicKey, "devnet", 50)).rejects.toBeInstanceOf(RpcTimeoutError);
  });
  it("withTimeout passes through fast results", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });
});

describe("attestation encoding", () => {
  const target = Keypair.generate().publicKey;
  it("builds a 70-byte instruction, clamps score and counts", () => {
    const ix = attestIx(Keypair.generate().publicKey, target, new Uint8Array(32).fill(9), 250, [300, 1, 2, 3]);
    expect(ix.data).toHaveLength(70);
    expect(ix.data[65]).toBe(100);
    expect(ix.data[66]).toBe(255);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].isSigner).toBe(false);
  });
  it("decodes a record and rejects short / wrong-discriminator data", () => {
    const d = new Uint8Array(ACCOUNT_SIZE);
    d.set(DISCRIMINATOR, 0);
    d[10] = 77;
    d.set(target.toBytes(), 48);
    expect(decodeAttestation("x", d)?.score).toBe(77);
    expect(decodeAttestation("x", d.slice(0, 100))).toBeNull();
    const bad = d.slice();
    bad[0] = 0;
    expect(decodeAttestation("x", bad)).toBeNull();
  });
  it("hexToBytes validates", () => {
    expect(hexToBytes("0x" + "ab".repeat(32))).toHaveLength(32);
    expect(() => hexToBytes("zz")).toThrow();
    expect(() => hexToBytes("ab".repeat(31))).toThrow();
  });
  it("listAttestations returns [] for an empty registry", async () => {
    expect(await listAttestations(mockConn(new Map()))).toEqual([]);
  });
});
