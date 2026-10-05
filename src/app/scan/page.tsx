"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ticks } from "@/components/ticks";
import { useI18n } from "@/lib/i18n";
import { cn, short } from "@/lib/utils";
import { FIXED_VAULT, SAMPLE_IDL, VULNERABLE_VAULT } from "@/lib/samples";
import { parseAddress, scanAddress } from "@/lib/scan-address";
import { reportHash, scanText, toHex, type ScanReport, type Severity } from "@/lib/scanner";
import {
  PROGRAM_ID,
  attestIx,
  explorer,
  fetchAttestation,
  MAX_UPLOAD_BYTES,
  isDevnet,
  programDeployed,
  readConnection,
  type Network,
} from "@/lib/chain";

const SEV: Record<Severity, string> = {
  critical: "text-sev-critical border-sev-critical/40",
  high: "text-sev-high border-sev-high/40",
  medium: "text-sev-medium border-sev-medium/40",
  low: "text-sev-low border-sev-low/40",
  info: "text-sev-info border-sev-info/40",
};

const SAMPLES = { vulnerable: VULNERABLE_VAULT, fixed: FIXED_VAULT, idl: SAMPLE_IDL } as const;
type SampleName = keyof typeof SAMPLES;

const EXAMPLE_ADDRESSES = {
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  registry: PROGRAM_ID.toBase58(),
} as const;

function scoreColor(s: number) {
  if (s >= 90) return "text-primary";
  if (s >= 60) return "text-sev-medium";
  if (s >= 40) return "text-sev-high";
  return "text-sev-critical";
}

/** Attestation key for pasted source with no program ID: SHA-256 of the text, read as a public key. */
async function sourceKey(text: string): Promise<PublicKey> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new PublicKey(new Uint8Array(d));
}

export default function ScanPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"source" | "chain">("source");
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState<Network>("devnet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState<ScanReport | null>(null);
  const [attestTarget, setAttestTarget] = useState<PublicKey | null>(null);
  const [hash, setHash] = useState<Uint8Array | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setHash(null);
    if (report) reportHash(report).then((h) => live && setHash(h));
    return () => {
      live = false;
    };
  }, [report]);

  async function runSource(source = text, targetInput = target) {
    setError("");
    if (!source.trim()) return setError(t.scan.empty);
    let key: PublicKey;
    if (targetInput.trim()) {
      try {
        key = parseAddress(targetInput);
      } catch {
        return setError(t.scan.invalidPk);
      }
    } else key = await sourceKey(source);
    try {
      setReport(scanText(source, key.toBase58()));
      setAttestTarget(key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runChain() {
    setError("");
    let pk: PublicKey;
    try {
      pk = parseAddress(address);
    } catch {
      return setError(t.scan.invalidPk);
    }
    setBusy(true);
    try {
      setReport(await scanAddress(readConnection(network), pk, network));
      setAttestTarget(pk);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Deep links: /scan?sample=vulnerable|fixed|idl loads and scans a bundled sample
  // (local only, no network). /scan?address=<pk>&network=devnet|mainnet prefills the
  // address tab but does not query the chain until the user presses Inspect.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const sample = q.get("sample");
    if (sample && sample in SAMPLES) {
      const src = SAMPLES[sample as SampleName];
      setText(src);
      void runSource(src, "");
      return;
    }
    const addr = q.get("address");
    if (addr) {
      setTab("chain");
      setAddress(addr);
      if (q.get("network") === "mainnet") setNetwork("mainnet");
    }
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadSample(name: SampleName) {
    setText(SAMPLES[name]);
    setFileName("");
    setError("");
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(t.scan.fileTooLarge);
      return;
    }
    f.text().then(
      (content) => {
        setText(content);
        setFileName(f.name);
        setError("");
      },
      () => setError(t.scan.fileError),
    );
  }

  function onSourceSubmit(e: FormEvent) {
    e.preventDefault();
    void runSource();
  }

  function onChainSubmit(e: FormEvent) {
    e.preventDefault();
    if (!busy) void runChain();
  }

  function download() {
    if (!report) return;
    const blob = new Blob([JSON.stringify({ ...report, hash: hash ? toHex(hash) : null }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `qproof-${short(report.target)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{t.scan.title}</h1>
      <p className="mt-2 text-muted-foreground">{t.scan.sub}</p>

      <div className="mt-8 flex gap-1 rounded-lg border p-1 text-sm sm:w-fit" role="tablist" aria-label={t.scan.tabsLabel}>
        {(["source", "chain"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={tab === k ? `panel-${k}` : undefined}
            onClick={() => setTab(k)}
            className={cn(
              "flex-1 rounded-md px-4 py-1.5 transition-colors sm:flex-none",
              tab === k ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {k === "source" ? t.scan.tabSource : t.scan.tabChain}
          </button>
        ))}
      </div>

      {tab === "source" ? (
        <div id="panel-source" role="tabpanel" aria-labelledby="tab-source">
        <form className="mt-4 space-y-3" onSubmit={onSourceSubmit}>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => loadSample("vulnerable")}>
              {t.scan.loadVuln}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => loadSample("fixed")}>
              {t.scan.loadFixed}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => loadSample("idl")}>
              {t.scan.loadIdl}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload /> {t.scan.upload}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".rs,.json,.txt"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {fileName && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {t.scan.fileLoaded}: <span className="font-mono">{fileName}</span>
              </span>
            )}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.scan.placeholder}
            aria-label={t.scan.placeholder}
            spellCheck={false}
            className="h-80 w-full resize-y rounded-lg border bg-card p-4 font-mono text-[12.5px] leading-6 outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="block text-sm">
              <span className="text-muted-foreground">{t.scan.targetLabel}</span>
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="mt-1 font-mono"
                placeholder={t.scan.targetPlaceholder}
                aria-describedby="target-help"
              />
              <span id="target-help" className="mt-1 block text-xs text-muted-foreground">
                {t.scan.targetHelp}
              </span>
            </label>
            <Button type="submit" size="lg">
              {t.scan.run}
            </Button>
          </div>
        </form>
        </div>
      ) : (
        <div id="panel-chain" role="tabpanel" aria-labelledby="tab-chain">
        <form className="mt-4 space-y-3" onSubmit={onChainSubmit}>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t.scan.programId}</span>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 font-mono"
              placeholder={t.scan.addressPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t.scan.examples}:</span>
            {(Object.keys(EXAMPLE_ADDRESSES) as (keyof typeof EXAMPLE_ADDRESSES)[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setAddress(EXAMPLE_ADDRESSES[k])}
                className="rounded border px-2 py-1 hover:bg-accent hover:text-foreground"
              >
                {k === "token" ? t.scan.exToken : t.scan.exRegistry}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label={t.scan.network}>
              {(["devnet", "mainnet"] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNetwork(n)}
                  aria-pressed={network === n}
                  className={cn("rounded px-3 py-1", network === n ? "bg-secondary text-foreground" : "text-muted-foreground")}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{t.scan.mainnetNote}</span>
            <Button type="submit" disabled={busy} className="md:ml-auto">
              {busy ? (
                <>
                  <Loader2 className="animate-spin" /> {t.scan.inspecting}
                </>
              ) : (
                t.scan.inspect
              )}
            </Button>
          </div>
        </form>
        </div>
      )}

      {error && (
        <p className="mt-4 break-words text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {report && (
        <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <h2 className="text-lg font-medium">
              {t.scan.findings} ({report.findings.length})
            </h2>
            {report.findings.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t.scan.noFindings}</p>}
            <ul className="mt-3 space-y-3">
              {report.findings.map((f, i) => (
                <li key={`${f.ruleId}-${f.line ?? "x"}-${i}`} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded border px-1.5 py-px font-mono text-[11px]", SEV[f.severity])}>{f.ruleId}</span>
                    <span className="font-medium">{f.title}</span>
                    <span className={cn("text-xs", SEV[f.severity].split(" ")[0])}>{f.severity}</span>
                    {f.line && (
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {t.scan.line} {f.line}
                      </span>
                    )}
                  </div>
                  {f.snippet && <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{f.snippet}</pre>}
                  <p className="mt-2 text-sm text-muted-foreground">
                    <Ticks text={f.message} />
                  </p>
                  <p className="mt-2 text-sm">
                    <span className="text-primary">{t.scan.fix}:</span> <Ticks text={f.fix} />
                  </p>
                </li>
              ))}
            </ul>
            {report.notes.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium">{t.scan.notes}</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {report.notes.map((n, i) => (
                    <li key={i} className="break-all">
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <aside className="min-w-0 space-y-4">
            <div className="rounded-lg border bg-card p-5">
              <div className="text-xs text-muted-foreground">{t.scan.score}</div>
              <div className={cn("mt-1 font-mono text-4xl font-semibold tabular-nums", scoreColor(report.score))}>
                {report.score}
                <span className="text-lg text-muted-foreground"> / 100 · {report.grade}</span>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center font-mono text-xs">
                {(["critical", "high", "medium", "low"] as const).map((s) => (
                  <div key={s} className={cn("rounded border py-1", SEV[s])}>
                    {report.counts[s]}
                    <div className="text-[10px]">{s}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 text-xs text-muted-foreground">{t.scan.hash}</div>
              <div className="break-all font-mono text-xs">{hash ? toHex(hash) : "…"}</div>
              <div className="mt-1 break-all text-xs text-muted-foreground">
                {t.scan.targetMeta} {short(report.target, 6)} · {report.rulesVersion}
              </div>
              <Button type="button" size="sm" variant="outline" className="mt-4 w-full" onClick={download}>
                <Download /> {t.scan.download}
              </Button>
            </div>
            {attestTarget && hash && <AttestPanel report={report} target={attestTarget} hash={hash} />}
          </aside>
        </section>
      )}
    </div>
  );
}

function AttestPanel({ report, target, hash }: { report: ScanReport; target: PublicKey; hash: Uint8Array }) {
  const { t } = useI18n();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "exists">("idle");
  const [sig, setSig] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    // Do not trust the RPC URL text: attest only on a cluster whose genesis hash is devnet.
    isDevnet(connection)
      .then((ok) => (ok ? programDeployed(connection) : false))
      .then((d) => live && setDeployed(d))
      .catch(() => live && setDeployed(false));
    return () => {
      live = false;
    };
  }, [connection]);

  // The record PDA includes the attester, so "already attested" is per connected wallet.
  useEffect(() => {
    let live = true;
    setStatus("idle");
    setSig("");
    setErr("");
    if (!deployed || !publicKey) return;
    fetchAttestation(connection, publicKey, target, hash)
      .then((r) => live && r.attestation && setStatus("exists"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connection, publicKey, target, hash, deployed]);

  async function attest() {
    if (!publicKey) return;
    setErr("");
    setStatus("sending");
    try {
      const c = report.counts;
      const tx = new Transaction().add(attestIx(publicKey, target, hash, report.score, [c.critical, c.high, c.medium, c.low]));
      const s = await sendTransaction(tx, connection);
      await connection.confirmTransaction(s, "confirmed");
      setSig(s);
      setStatus("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("idle");
    }
  }

  const recordLink = `/attestations?target=${target.toBase58()}&hash=${toHex(hash)}${publicKey ? `&attester=${publicKey.toBase58()}` : ""}`;

  return (
    <div className="rounded-lg border bg-card p-5">
      <h3 className="font-medium">{t.attest.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t.attest.body}</p>
      {deployed === false ? (
        <p className="mt-3 text-sm text-sev-medium">{t.attest.notDeployed}</p>
      ) : status === "exists" ? (
        <p className="mt-3 text-sm text-primary">
          {t.attest.exists}{" "}
          <Link className="underline" href={recordLink}>
            {t.attest.viewRecord}
          </Link>
        </p>
      ) : status === "done" ? (
        <p className="mt-3 text-sm text-primary">
          {t.attest.done} ·{" "}
          <a className="underline" href={explorer("tx", sig)} target="_blank" rel="noreferrer">
            {short(sig, 6)}
          </a>{" "}
          ·{" "}
          <Link className="underline" href={recordLink}>
            {t.attest.viewRecord}
          </Link>
        </p>
      ) : !publicKey ? (
        <p className="mt-3 text-sm text-muted-foreground">{t.attest.connect}</p>
      ) : (
        <>
          <Button type="button" className="mt-3 w-full" onClick={attest} disabled={status === "sending" || deployed === null}>
            {status === "sending" ? t.attest.sending : t.attest.button}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t.attest.devnetHint}</p>
        </>
      )}
      {err && <p className="mt-2 break-all text-xs text-destructive">{err}</p>}
    </div>
  );
}
