"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { WalletButton } from "./wallet-button";

export const REPO_URL = "https://github.com/nayrbryanGaming/qproof";

function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Language">
      {(["en", "id"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={cn(
            "h-7 min-w-8 rounded px-2 font-medium uppercase transition-colors",
            lang === l ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function SiteHeader() {
  const { t } = useI18n();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const links = [
    { href: "/scan", label: t.nav.scan },
    { href: "/attestations", label: t.nav.attestations },
    { href: "/docs", label: t.nav.docs },
  ];
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="size-5 text-primary" />
          qproof
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path?.startsWith(l.href) ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                path?.startsWith(l.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {l.label}
            </Link>
          ))}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            {t.nav.github}
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LangSwitch />
          <div className="hidden sm:block">
            <WalletButton />
          </div>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            onClick={() => setOpen(!open)}
            aria-label={t.nav.menu}
            aria-expanded={open}
            aria-controls={open ? "mobile-nav" : undefined}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" className="border-t px-4 py-3 md:hidden">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              aria-current={path?.startsWith(l.href) ? "page" : undefined}
              className="block py-2 text-sm"
            >
              {l.label}
            </Link>
          ))}
          <div className="pt-2 sm:hidden">
            <WalletButton />
          </div>
        </nav>
      )}
    </header>
  );
}

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Logo className="size-4" />
          <span>{t.footer.line}</span>
        </div>
        <div className="flex gap-4">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="hover:text-foreground">GitHub</a>
          <span>{t.footer.rights}</span>
        </div>
      </div>
    </footer>
  );
}
