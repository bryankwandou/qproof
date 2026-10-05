"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, FileCode2, Fingerprint, KeyRound, Link2, ScanLine, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Ticks } from "@/components/ticks";
import { useI18n } from "@/lib/i18n";
import { VULNERABLE_VAULT } from "@/lib/samples";
import { scanText } from "@/lib/scanner";

const ease = [0.22, 1, 0.36, 1] as const;
const icons = [ShieldAlert, Fingerprint, KeyRound, FileCode2, ScanLine, Link2];

function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The hero panel is not a mock-up: it runs the real scanner on the bundled
 * vulnerable vault and shows the QP001 finding, its source lines and the score.
 * The scan is pure and deterministic, so server and client render the same thing.
 */
const DEMO = (() => {
  const report = scanText(VULNERABLE_VAULT, "vulnerable-vault");
  const finding = report.findings.find((f) => f.ruleId === "QP001") ?? report.findings[0];
  const src = VULNERABLE_VAULT.split("\n");
  const at = finding?.line ?? 1;
  let callEnd = at;
  while (callEnd < src.length && !src[callEnd - 1].includes(";")) callEnd++;
  const first = Math.max(1, at - 3);
  const shown = src.slice(first - 1, callEnd);
  const indent = Math.min(...shown.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  const lines = shown.map((text, i) => {
    const n = first + i;
    return { n, text: text.slice(indent), hl: n >= at && n <= Math.min(at + 1, callEnd) };
  });
  const summary = finding ? finding.message.split(/(?<=\.)\s/)[0] : "";
  return { report, finding, lines, summary };
})();

const SCORE_CLASS = (s: number) =>
  s >= 90 ? "text-primary" : s >= 60 ? "text-sev-medium" : s >= 40 ? "text-sev-high" : "text-sev-critical";

function CodePanel() {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const { report, finding, lines, summary } = DEMO;
  const counts = (["critical", "high", "medium", "low"] as const).filter((k) => report.counts[k] > 0);
  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease, delay: 0.25 }}
      className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/40"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span className="truncate font-mono">vault/src/withdraw.rs</span>
        <span className="shrink-0 font-mono">{report.rulesVersion}</span>
      </div>
      <pre className="overflow-x-auto py-3 font-mono text-[12.5px] leading-6">
        {lines.map((l) => (
          <div key={l.n} className={l.hl ? "bg-sev-critical/10" : ""}>
            <span className="inline-block w-10 select-none pr-3 text-right text-muted-foreground" aria-hidden="true">
              {l.n}
            </span>
            <span className={l.hl ? "text-foreground" : "text-muted-foreground"}>{l.text || " "}</span>
          </div>
        ))}
      </pre>
      {finding && (
        <motion.div
          initial={reduce ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.45, ease, delay: 0.9 }}
          // overflow-hidden: while height animates from 0 the text must not spill onto the score row.
          className="overflow-hidden border-t bg-sev-critical/5"
        >
          <div className="flex items-start gap-3 px-4 py-3 text-sm">
            <span className="mt-0.5 rounded border border-sev-critical/40 px-1.5 py-px font-mono text-[11px] text-sev-critical">
              {finding.ruleId}
            </span>
            <div className="min-w-0">
              <div className="font-medium">
                {finding.title} · {finding.severity}
              </div>
              <div className="mt-0.5 text-muted-foreground">
                <Ticks text={summary} />
              </div>
            </div>
          </div>
        </motion.div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <div>
          <span className="text-xs text-muted-foreground">{t.scan.score}</span>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {counts.map((k) => `${report.counts[k]} ${k}`).join(" · ")}
          </div>
        </div>
        <span className={`font-mono text-lg font-semibold tabular-nums ${SCORE_CLASS(report.score)}`}>
          {report.score} / 100 · {report.grade}
        </span>
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>{t.hero.demoCaption}</span>
        <Link href="/scan?sample=vulnerable" className="inline-flex items-center gap-1 text-primary hover:underline">
          {t.hero.demoOpen} <ArrowRight className="size-3.5" />
        </Link>
      </figcaption>
    </motion.figure>
  );
}

export default function Home() {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  return (
    <div>
      <section className="relative overflow-hidden border-b">
        <div className="grid-bg pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-20 md:grid-cols-[1.1fr_1fr] md:py-28">
          <div className="flex min-w-0 flex-col justify-center">
            <motion.p
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
              className="mb-5 font-mono text-xs uppercase tracking-[0.18em] text-primary"
            >
              {t.hero.eyebrow}
            </motion.p>
            <motion.h1
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease }}
              className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight md:text-5xl"
            >
              {t.hero.title}
            </motion.h1>
            <motion.p
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease, delay: 0.08 }}
              className="mt-5 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground md:text-lg"
            >
              {t.hero.body}
            </motion.p>
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease, delay: 0.16 }}
              className="mt-8 flex flex-wrap gap-3"
            >
              <Button asChild size="lg">
                <Link href="/scan">
                  {t.hero.ctaScan} <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/docs">{t.hero.ctaDocs}</Link>
              </Button>
            </motion.div>
          </div>
          <CodePanel />
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 md:grid-cols-[1fr_1.4fr]">
          <Reveal>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{t.story.label}</p>
            <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight md:text-3xl">{t.story.title}</h2>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="text-pretty leading-relaxed text-muted-foreground">{t.story.body}</p>
            <p className="mt-5 border-l-2 border-primary pl-4 text-sm leading-relaxed">{t.story.note}</p>
          </Reveal>
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <Reveal>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{t.features.label}</p>
          </Reveal>
          <div className="mt-8 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {t.features.items.map((f, i) => {
              const Icon = icons[i];
              return (
                <Reveal key={f.t} delay={i * 0.04} className="bg-background p-6">
                  <Icon className="size-5 text-primary" strokeWidth={1.6} />
                  <h3 className="mt-4 font-medium">{f.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.d}</p>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <Reveal>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{t.how.label}</p>
          </Reveal>
          <ol className="mt-8 grid gap-8 md:grid-cols-4">
            {t.how.steps.map((s, i) => (
              // <li> must be a direct child of <ol>, so the animation wrapper goes inside it.
              <li key={s.t} className="list-none">
                <Reveal delay={i * 0.06}>
                  <span className="font-mono text-sm text-primary">0{i + 1}</span>
                  <h3 className="mt-2 font-medium">{s.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-6xl px-4 py-20">
          <Reveal className="flex flex-col items-start justify-between gap-6 rounded-xl border bg-card p-8 md:flex-row md:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{t.cta.title}</h2>
              <p className="mt-1.5 text-muted-foreground">{t.cta.body}</p>
            </div>
            <Button asChild size="lg">
              <Link href="/scan">
                {t.cta.button} <ArrowRight />
              </Link>
            </Button>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
