import { Connection, PublicKey } from "@solana/web3.js";
import { inspectAddress, inspectProgram, type Network } from "./chain";
import { accountFindings, buildReport, onchainFindings, type ScanReport } from "./scanner";

export class ScanInputError extends Error {}
export class RpcTimeoutError extends Error {}

/** Parse a user-entered address. Throws ScanInputError on anything that is not a 32-byte base58 key. */
export function parseAddress(input: string): PublicKey {
  const s = input.trim();
  if (!s) throw new ScanInputError("Enter a program ID or account address.");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new ScanInputError("Not a valid base58 Solana address.");
  try {
    return new PublicKey(s);
  } catch {
    throw new ScanInputError("Not a valid base58 Solana address.");
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = "RPC request"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new RpcTimeoutError(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Read-only scan of a program or account. Only getAccountInfo is called, so it is
 * safe against mainnet. RPC failures are rethrown with a readable message.
 */
export async function scanAddress(conn: Connection, pk: PublicKey, network: Network, timeoutMs = 15_000): Promise<ScanReport> {
  const netNote = `Read from ${network} via public RPC (read-only).`;
  try {
    const facts = await withTimeout(inspectAddress(conn, pk), timeoutMs);
    if (facts.executable) {
      const info = await withTimeout(inspectProgram(conn, pk), timeoutMs);
      const { findings, notes } = onchainFindings(info);
      const extra = info.upgradeAuthority ? [`Upgrade authority: ${info.upgradeAuthority}`] : [];
      return buildReport("onchain", pk.toBase58(), findings, [netNote, ...extra, ...notes]);
    }
    const { findings, notes } = accountFindings(facts);
    return buildReport("account", pk.toBase58(), findings, [netNote, ...notes]);
  } catch (e) {
    if (e instanceof RpcTimeoutError) throw e;
    throw new Error(`RPC error on ${network}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
