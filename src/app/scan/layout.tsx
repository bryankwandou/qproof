import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scanner",
  description: "Scan Solana program source, an Anchor IDL, or an on-chain address for post-quantum readiness issues.",
};

export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return children;
}
