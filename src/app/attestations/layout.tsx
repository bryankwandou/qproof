import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Attestations",
  description: "Scan reports recorded in the qproof registry on Solana devnet, read live from the chain.",
};

export default function AttestationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
