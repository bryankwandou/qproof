"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { short } from "@/lib/utils";
import { parseAddress } from "@/lib/scan-address";
import {
  PROGRAM_ID,
  explorer,
  fetchAttestation,
  findAttestations,
  hexToBytes,
  listAttestations,
  programDeployed,
  revokeIx,
  type Attestation,
} from "@/lib/chain";

type VerifyResult = { ok: boolean; text: string; rows: Attestation[] };

export default function AttestationsPage() {
  const { t } = useI18n();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Attestation[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [target, setTarget] = useState("");
  const [hash, setHash] = useState("");
  const [attester, setAttester] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setLoadErr("");
    try {
      const d = await programDeployed(connection);
      setDeployed(d);
      setRows(d ? await listAttestations(connection) : []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [connection]);

  useEffect(() => {
    load();
  }, [load]);

  // Prefill from links such as /attestations?target=..&hash=..&attester=.. (sent by the scanner).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setTarget(q.get("target") ?? "");
    setHash(q.get("hash") ?? "");
    setAttester(q.get("attester") ?? "");
  }, []);

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setVerify(null);
    let pk: PublicKey;
    let h: Uint8Array;
    let who: PublicKey | null = null;
    try {
      pk = parseAddress(target);
      if (attester.trim()) who = parseAddress(attester);
    } catch {
      return setVerify({ ok: false, text: t.scan.invalidPk, rows: [] });
    }
    try {
      h = hexToBytes(hash);
    } catch {
      return setVerify({ ok: false, text: t.list.badHash, rows: [] });
    }
    setVerifying(true);
    try {
      if (who) {
        const { pda, attestation } = await fetchAttestation(connection, who, pk, h);
        setVerify(
          attestation
            ? { ok: true, text: `${t.list.found}: ${pda.toBase58()}`, rows: [attestation] }
            : { ok: false, text: `${t.list.notFound} (${pda.toBase58()})`, rows: [] },
        );
      } else {
        const found = await findAttestations(connection, pk, h);
        setVerify(
          found.length
            ? { ok: true, text: `${t.list.found} (${found.length})`, rows: found }
            : { ok: false, text: t.list.notFound, rows: [] },
        );
      }
    } catch (err) {
      setVerify({ ok: false, text: err instanceof Error ? err.message : String(err), rows: [] });
    } finally {
      setVerifying(false);
    }
  }

  async function onRevoke(a: Attestation) {
    if (!publicKey) return;
    setActionMsg(null);
    setRevoking(a.address);
    try {
      const tx = new Transaction().add(revokeIx(publicKey, new PublicKey(a.address)));
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setActionMsg({ ok: true, text: t.list.revoked });
      setVerify(null);
      await load();
    } catch (err) {
      setActionMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRevoking(null);
    }
  }

  const me = publicKey?.toBase58();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t.list.title}</h1>
          <p className="mt-2 text-muted-foreground">{t.list.sub}</p>
        </div>
        <Button type="button" variant="outline" onClick={load} disabled={rows === null}>
          <RefreshCw className={rows === null ? "animate-spin" : ""} /> {t.list.refresh}
        </Button>
      </div>

      <dl className="mt-6 grid gap-4 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t.list.program}</dt>
          <dd className="break-all font-mono">
            <a className="underline-offset-2 hover:underline" href={explorer("address", PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
              {PROGRAM_ID.toBase58()}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t.list.status}</dt>
          <dd className={deployed ? "text-primary" : "text-sev-medium"}>
            {deployed === null ? "…" : deployed ? t.list.live : t.list.offline}
          </dd>
        </div>
      </dl>

      {actionMsg && (
        <p className={`mt-4 break-all text-sm ${actionMsg.ok ? "text-primary" : "text-destructive"}`} role="status">
          {actionMsg.text}
        </p>
      )}

      <div className="mt-8 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t.list.colTarget}</th>
              <th className="px-4 py-2 font-medium">{t.list.colScore}</th>
              <th className="px-4 py-2 font-medium">{t.list.colFindings}</th>
              <th className="px-4 py-2 font-medium">{t.list.colHash}</th>
              <th className="px-4 py-2 font-medium">{t.list.colAttester}</th>
              <th className="px-4 py-2 font-medium">{t.list.colWhen}</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">{t.list.colAction}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-muted-foreground">
                  {t.list.loading}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-muted-foreground">
                  {loadErr || t.list.none}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.address} className="border-b last:border-0">
                  <td className="px-4 py-2 font-mono">
                    <a className="hover:underline" href={explorer("address", r.address)} target="_blank" rel="noreferrer" title={r.target}>
                      {short(r.target, 6)}
                    </a>
                  </td>
                  <td className="px-4 py-2 font-mono tabular-nums">{r.score}</td>
                  <td className="px-4 py-2 font-mono tabular-nums">
                    {r.critical} / {r.high} / {r.medium} / {r.low}
                  </td>
                  <td className="px-4 py-2 font-mono" title={r.hash}>
                    {short(r.hash, 6)}
                  </td>
                  <td className="px-4 py-2 font-mono" title={r.attester}>
                    {r.attester === me ? t.list.you : short(r.attester)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {r.timestamp ? new Date(r.timestamp * 1000).toLocaleString() : `${t.list.slot} ${r.slot}`}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.attester === me && (
                      <Button type="button" size="sm" variant="outline" onClick={() => onRevoke(r)} disabled={revoking !== null}>
                        {revoking === r.address ? t.list.revoking : t.list.revoke}
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <section className="mt-12 max-w-2xl">
        <h2 className="text-lg font-medium">{t.list.verifyTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.list.verifyBody}</p>
        <form className="mt-4 space-y-3" onSubmit={onVerify}>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t.list.target} aria-label={t.list.target} className="font-mono" spellCheck={false} />
          <Input value={hash} onChange={(e) => setHash(e.target.value)} placeholder={t.list.hash} aria-label={t.list.hash} className="font-mono" spellCheck={false} />
          <Input
            value={attester}
            onChange={(e) => setAttester(e.target.value)}
            placeholder={t.list.attester}
            aria-label={t.list.attester}
            aria-describedby="attester-help"
            className="font-mono"
            spellCheck={false}
          />
          <p id="attester-help" className="text-xs text-muted-foreground">
            {t.list.verifyHint}
          </p>
          <Button type="submit" disabled={!deployed || verifying}>
            {t.list.verify}
          </Button>
        </form>
        {verify && (
          <div className="mt-3 text-sm" role="status">
            <p className={`break-all ${verify.ok ? "text-primary" : "text-sev-medium"}`}>{verify.text}</p>
            {verify.rows.length > 0 && (
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {verify.rows.map((a) => (
                  <li key={a.address} className="break-all font-mono text-xs">
                    {t.list.score} {a.score} · {t.list.slot} {a.slot} · {t.list.by} {a.attester === me ? t.list.you : a.attester}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
