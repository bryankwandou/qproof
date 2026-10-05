import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Inflate } from "pako";

// Program ID reserved from a keypair generated locally for this project
// (.devnet-keys/, gitignored). See README.md for deploy status.
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "81k7uatyydQboYd5oSDzjE7xzNfnwu53FnzocoGbrUsT",
);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
/** Mainnet is only ever used for public read queries (getAccountInfo). Nothing is signed or sent there. */
export const MAINNET_READ_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
export type Network = "devnet" | "mainnet";
export const readConnection = (n: Network) => new Connection(n === "mainnet" ? MAINNET_READ_RPC : RPC_URL, "confirmed");
export const SEED = new TextEncoder().encode("attest");
export const DISCRIMINATOR = new TextEncoder().encode("QPATTEST");
export const ACCOUNT_SIZE = 128;
export const IX_ATTEST = 0;
export const IX_REVOKE = 1;

/** Byte offsets inside a 128-byte record (mirrors program/src/lib.rs). */
export const OFFSETS = { version: 8, bump: 9, score: 10, counts: 11, attester: 16, target: 48, hash: 80, ts: 112, slot: 120 } as const;

export const explorer = (kind: "address" | "tx", v: string) =>
  `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

/**
 * Canonical record address for (attester, target, report hash), the same seeds as
 * `record_address` in the program. The attester is part of the seeds, so nobody can
 * squat someone else's record for the same report.
 */
export function attestationPda(attester: PublicKey, target: PublicKey, hash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED, attester.toBuffer(), target.toBuffer(), hash], PROGRAM_ID);
}

export function attestIx(
  attester: PublicKey,
  target: PublicKey,
  hash: Uint8Array,
  score: number,
  counts: [number, number, number, number],
): TransactionInstruction {
  const data = new Uint8Array(70);
  data[0] = IX_ATTEST;
  data.set(target.toBytes(), 1);
  data.set(hash, 33);
  data[65] = Math.max(0, Math.min(100, Math.round(score)));
  counts.forEach((c, i) => (data[66 + i] = Math.max(0, Math.min(255, c))));
  const [pda] = attestationPda(attester, target, hash);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: attester, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** Close a record. Only the attester stored in the record can do this; rent goes back to them. */
export function revokeIx(attester: PublicKey, record: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: attester, isSigner: true, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([IX_REVOKE]),
  });
}

export interface Attestation {
  address: string;
  bump: number;
  score: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  attester: string;
  target: string;
  hash: string;
  timestamp: number;
  slot: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function decodeAttestation(address: string, d: Uint8Array): Attestation | null {
  if (d.length < ACCOUNT_SIZE) return null;
  for (let i = 0; i < 8; i++) if (d[i] !== DISCRIMINATOR[i]) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    address,
    bump: d[9],
    score: d[10],
    critical: d[11],
    high: d[12],
    medium: d[13],
    low: d[14],
    attester: new PublicKey(d.slice(16, 48)).toBase58(),
    target: new PublicKey(d.slice(48, 80)).toBase58(),
    hash: hex(d.slice(80, 112)),
    timestamp: Number(view.getBigInt64(112, true)),
    slot: Number(view.getBigUint64(120, true)),
  };
}

/** Upload size cap for the scanner (2 MB). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Genesis hash of Solana devnet. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** True only when the RPC behind `conn` really is devnet (the URL text is not trusted). */
export async function isDevnet(conn: Connection): Promise<boolean> {
  try {
    return (await conn.getGenesisHash()) === DEVNET_GENESIS_HASH;
  } catch {
    return false;
  }
}

export async function programDeployed(conn: Connection): Promise<boolean> {
  const info = await conn.getAccountInfo(PROGRAM_ID);
  return Boolean(info?.executable);
}

export async function listAttestations(conn: Connection): Promise<Attestation[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: ACCOUNT_SIZE }],
  });
  return accounts
    .map((a) => decodeAttestation(a.pubkey.toBase58(), a.account.data))
    .filter((a): a is Attestation => a !== null)
    .sort((a, b) => b.slot - a.slot);
}

export function hexToBytes(h: string): Uint8Array {
  const clean = h.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("Report hash must be 64 hex characters");
  return Uint8Array.from(clean.match(/../g)!.map((x) => parseInt(x, 16)));
}

/** Look up the record one attester wrote for (target, hash). */
export async function fetchAttestation(conn: Connection, attester: PublicKey, target: PublicKey, hash: Uint8Array) {
  const [pda] = attestationPda(attester, target, hash);
  const info = await conn.getAccountInfo(pda);
  const attestation = info && info.owner.equals(PROGRAM_ID) ? decodeAttestation(pda.toBase58(), info.data) : null;
  return { pda, attestation };
}

/** Every record for one report, whoever attested it (memcmp on target and hash). */
export async function findAttestations(conn: Connection, target: PublicKey, hash: Uint8Array): Promise<Attestation[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: ACCOUNT_SIZE },
      { memcmp: { offset: OFFSETS.target, bytes: target.toBase58() } },
      { memcmp: { offset: OFFSETS.hash, bytes: new PublicKey(hash).toBase58() } },
    ],
  });
  return accounts
    .map((a) => decodeAttestation(a.pubkey.toBase58(), a.account.data))
    .filter((a): a is Attestation => a !== null)
    .sort((a, b) => b.slot - a.slot);
}

/* ------------------------------------------------------------------ */
/* On-chain inspection of an arbitrary program id                      */
/* ------------------------------------------------------------------ */

/** Maximum size of an on-chain IDL, compressed or decompressed (1 MiB). */
export const MAX_IDL_BYTES = 1 << 20;

/** Inflate with a hard cap on the output so a zip bomb cannot exhaust memory. */
export function inflateCapped(data: Uint8Array, max = MAX_IDL_BYTES): Uint8Array {
  const inf = new Inflate();
  const parts: Uint8Array[] = [];
  let n = 0;
  inf.onData = (chunk: Uint8Array) => {
    n += chunk.length;
    if (n > max) throw new Error(`IDL exceeds ${max} bytes after decompression`);
    parts.push(chunk);
  };
  inf.push(data, true);
  if (inf.err) throw new Error(String(inf.msg || "invalid IDL data"));
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export interface ProgramInfo {
  exists: boolean;
  executable: boolean;
  loader: string;
  upgradeable: boolean;
  upgradeAuthority: string | null;
  lastDeploySlot: number | null;
  authorityIsPda: boolean | null;
  idl: string | null;
}

export async function inspectProgram(conn: Connection, programId: PublicKey, withIdl = true): Promise<ProgramInfo> {
  const info = await conn.getAccountInfo(programId);
  const result: ProgramInfo = {
    exists: Boolean(info),
    executable: Boolean(info?.executable),
    loader: info?.owner.toBase58() ?? "",
    upgradeable: false,
    upgradeAuthority: null,
    lastDeploySlot: null,
    authorityIsPda: null,
    idl: null,
  };
  if (!info) return result;
  if (info.owner.equals(UPGRADEABLE_LOADER) && info.data.length >= 36) {
    result.upgradeable = true;
    const programData = new PublicKey(info.data.slice(4, 36));
    const pd = await conn.getAccountInfo(programData, { dataSlice: { offset: 0, length: 45 } });
    if (pd && pd.data.length >= 45) {
      const view = new DataView(pd.data.buffer, pd.data.byteOffset, pd.data.byteLength);
      result.lastDeploySlot = Number(view.getBigUint64(4, true));
      if (pd.data[12] === 1) {
        const auth = new PublicKey(pd.data.slice(13, 45));
        result.upgradeAuthority = auth.toBase58();
        result.authorityIsPda = !PublicKey.isOnCurve(auth.toBytes());
      } else {
        result.upgradeable = false;
      }
    }
  }
  if (!withIdl) return result;
  // Anchor IDL account: createWithSeed(base = PDA([], program), "anchor:idl", program)
  try {
    const [base] = PublicKey.findProgramAddressSync([], programId);
    const idlAddr = await PublicKey.createWithSeed(base, "anchor:idl", programId);
    const idlAcc = await conn.getAccountInfo(idlAddr);
    if (idlAcc && idlAcc.data.length > 44) {
      const view = new DataView(idlAcc.data.buffer, idlAcc.data.byteOffset, idlAcc.data.byteLength);
      const len = view.getUint32(40, true);
      if (len > MAX_IDL_BYTES) throw new Error("IDL too large");
      const compressed = idlAcc.data.slice(44, 44 + len);
      result.idl = new TextDecoder().decode(inflateCapped(compressed));
    }
  } catch {
    result.idl = null;
  }
  return result;
}

export interface AccountInfoFacts {
  exists: boolean;
  executable: boolean;
  onCurve: boolean;
  owner: string;
  lamports: number;
  dataLength: number;
  ownerUpgradeAuthorityOnCurve: boolean | null;
}

/** Read-only facts about any address. Safe against mainnet: only getAccountInfo is called. */
export async function inspectAddress(conn: Connection, address: PublicKey): Promise<AccountInfoFacts> {
  const info = await conn.getAccountInfo(address);
  const facts: AccountInfoFacts = {
    exists: Boolean(info),
    executable: Boolean(info?.executable),
    onCurve: PublicKey.isOnCurve(address.toBytes()),
    owner: info?.owner.toBase58() ?? "",
    lamports: info?.lamports ?? 0,
    dataLength: info?.data.length ?? 0,
    ownerUpgradeAuthorityOnCurve: null,
  };
  if (info && !info.executable) {
    if (!info.owner.equals(SystemProgram.programId)) {
      try {
        const p = await inspectProgram(conn, info.owner, false);
        if (p.upgradeable && p.upgradeAuthority) facts.ownerUpgradeAuthorityOnCurve = p.authorityIsPda === false;
      } catch {
        /* ignore */
      }
    }
  }
  return facts;
}
