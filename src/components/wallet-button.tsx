"use client";

import dynamic from "next/dynamic";

export const WalletButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-9 w-32 rounded-md bg-muted" /> },
);
