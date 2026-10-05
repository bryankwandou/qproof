"use client";

import type { ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { I18nProvider } from "@/lib/i18n";
import { RPC_URL } from "@/lib/chain";
import "@solana/wallet-adapter-react-ui/styles.css";

// Phantom, Solflare, Backpack and other Wallet Standard wallets register
// themselves, so no explicit adapter list is needed.
const WALLETS: never[] = [];

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={WALLETS} autoConnect>
        <WalletModalProvider>
          <I18nProvider>{children}</I18nProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
