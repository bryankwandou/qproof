// Runs the compiled registry program (program/target/deploy/qproof_registry.so)
// inside LiteSVM, an in-process Solana VM. Build it first with:
//   cd program && cargo-build-sbf
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, attestIx, attestationPda, decodeAttestation } from "../src/lib/chain";

const SO = resolve(__dirname, "../program/target/deploy/qproof_registry.so");
const haveSo = existsSync(SO);
// litesvm ships native builds for Linux and macOS only; on Windows these tests skip
// and the Rust host tests in program/tests cover the same cases.
let lite: typeof import("litesvm") | null = null;
try {
  lite = await import("litesvm");
} catch {
  console.warn("[program.test] litesvm native binding unavailable on this platform, skipping");
}
type LiteSVM = import("litesvm").LiteSVM;
if (!haveSo) console.warn(`[program.test] ${SO} missing, run cargo-build-sbf in program/ first`);

function setup() {
  const svm = new lite!.LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, SO);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(10_000_000_000));
  return { svm, payer };
}

function send(svm: LiteSVM, payer: Keypair, ix: TransactionInstruction, signers: Keypair[] = [payer]) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res;
}

const failed = (r: unknown) => r instanceof lite!.FailedTransactionMetadata;
const hash = (n: number) => new Uint8Array(32).fill(n);

describe.skipIf(!haveSo || !lite)("attestation registry program (LiteSVM)", () => {
  it("records an attestation at the canonical PDA", () => {
    const { svm, payer } = setup();
    const target = Keypair.generate().publicKey;
    const h = hash(7);
    const res = send(svm, payer, attestIx(payer.publicKey, target, h, 55, [1, 2, 3, 4]));
    expect(failed(res)).toBe(false);
    const [pda, bump] = attestationPda(payer.publicKey, target, h);
    const acc = svm.getAccount(pda);
    expect(acc).not.toBeNull();
    expect(new PublicKey(acc!.owner).equals(PROGRAM_ID)).toBe(true);
    const a = decodeAttestation(pda.toBase58(), Uint8Array.from(acc!.data))!;
    expect(a).toMatchObject({ score: 55, critical: 1, high: 2, medium: 3, low: 4, bump });
    expect(a.attester).toBe(payer.publicKey.toBase58());
    expect(a.target).toBe(target.toBase58());
    expect(a.hash).toBe("07".repeat(32));
  });

  it("rejects a duplicate attestation for the same target and hash", () => {
    const { svm, payer } = setup();
    const target = Keypair.generate().publicKey;
    expect(failed(send(svm, payer, attestIx(payer.publicKey, target, hash(1), 90, [0, 0, 0, 0])))).toBe(false);
    expect(failed(send(svm, payer, attestIx(payer.publicKey, target, hash(1), 90, [0, 0, 0, 0])))).toBe(true);
  });

  it("rejects a score above 100", () => {
    const { svm, payer } = setup();
    const ix = attestIx(payer.publicKey, Keypair.generate().publicKey, hash(2), 50, [0, 0, 0, 0]);
    ix.data[65] = 101;
    expect(failed(send(svm, payer, ix))).toBe(true);
  });

  it("rejects a record account that is not the canonical PDA", () => {
    const { svm, payer } = setup();
    const target = Keypair.generate().publicKey;
    const h = hash(3);
    const ix = attestIx(payer.publicKey, target, h, 50, [0, 0, 0, 0]);
    // try a non-canonical bump for the same seeds
    const [, canon] = attestationPda(payer.publicKey, target, h);
    let alt: PublicKey | null = null;
    for (let b = canon - 1; b >= 0 && !alt; b--) {
      try {
        alt = PublicKey.createProgramAddressSync([Buffer.from("attest"), target.toBuffer(), Buffer.from(h), Buffer.from([b])], PROGRAM_ID);
      } catch {
        /* off-curve requirement not met, try next */
      }
    }
    expect(alt).not.toBeNull();
    ix.keys[1].pubkey = alt!;
    expect(failed(send(svm, payer, ix))).toBe(true);
  });

  it("rejects when the attester did not sign", () => {
    const { svm, payer } = setup();
    const other = Keypair.generate();
    svm.airdrop(other.publicKey, BigInt(1_000_000_000));
    const ix = attestIx(other.publicKey, Keypair.generate().publicKey, hash(4), 50, [0, 0, 0, 0]);
    ix.keys[0].isSigner = false;
    expect(failed(send(svm, payer, ix))).toBe(true);
  });

  it("rejects malformed instruction data and a fake system program", () => {
    const { svm, payer } = setup();
    const ix = attestIx(payer.publicKey, Keypair.generate().publicKey, hash(5), 50, [0, 0, 0, 0]);
    const short = new TransactionInstruction({ programId: PROGRAM_ID, keys: ix.keys, data: ix.data.subarray(0, 40) });
    expect(failed(send(svm, payer, short))).toBe(true);
    const fake = attestIx(payer.publicKey, Keypair.generate().publicKey, hash(6), 50, [0, 0, 0, 0]);
    fake.keys[2] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false };
    expect(failed(send(svm, payer, fake))).toBe(true);
    expect(SystemProgram.programId).toBeDefined();
  });
});
