"use client";

import { useI18n } from "@/lib/i18n";

export function SkipLink() {
  const { t } = useI18n();
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50"
    >
      {t.nav.skip}
    </a>
  );
}
