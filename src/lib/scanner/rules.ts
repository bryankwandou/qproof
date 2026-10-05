import type { RuleMeta, Severity } from "./types";

export const RULES_VERSION = "qp-rules-1.0.0";

export const RULES: Record<string, RuleMeta> = {
  QP001: {
    id: "QP001",
    title: "Non-canonical PDA bump",
    severity: "critical",
    summary:
      "create_program_address (or an Anchor bump constraint) is fed a bump that the caller controls. Several valid addresses then exist for the same seeds, which breaks any uniqueness the PDA was meant to enforce.",
  },
  QP002: {
    id: "QP002",
    title: "Missing signer check",
    severity: "high",
    summary: "An authority-like account is trusted without verifying that it signed the transaction.",
  },
  QP003: {
    id: "QP003",
    title: "Missing owner check",
    severity: "high",
    summary: "Account data is deserialised without confirming which program owns the account.",
  },
  QP004: {
    id: "QP004",
    title: "One-time key reuse",
    severity: "high",
    summary:
      "A one-time signature (Winternitz, Lamport, XMSS leaf) is verified, but the program does not reliably record that the key was used.",
  },
  QP005: {
    id: "QP005",
    title: "Unchecked data read",
    severity: "medium",
    summary: "Raw instruction or account bytes are indexed without a prior length check.",
  },
  QP006: {
    id: "QP006",
    title: "Classical-only signatures",
    severity: "low",
    summary: "Authorisation relies only on elliptic-curve signatures, with no hash-based fallback.",
  },
  QP007: {
    id: "QP007",
    title: "Unchecked lamport arithmetic",
    severity: "medium",
    summary: "Lamport balances are modified with plain arithmetic instead of checked operations.",
  },
  QP101: {
    id: "QP101",
    title: "Bump accepted as instruction argument",
    severity: "critical",
    summary: "The IDL exposes a bump as an instruction argument, which usually means it reaches create_program_address.",
  },
  QP102: {
    id: "QP102",
    title: "Authority account not marked signer",
    severity: "high",
    summary: "An IDL account named like an authority is not marked as a signer.",
  },
  QP103: {
    id: "QP103",
    title: "Writable instruction without any signer",
    severity: "medium",
    summary: "An instruction mutates accounts but requires no signature at all.",
  },
  QP201: {
    id: "QP201",
    title: "Upgrade authority is a single Ed25519 key",
    severity: "medium",
    summary:
      "The program can be replaced by whoever holds one elliptic-curve key. That key is the first thing a quantum attacker would target.",
  },
  QP202: {
    id: "QP202",
    title: "No public IDL",
    severity: "info",
    summary: "No Anchor IDL account was found, so instruction-level checks could not run. Upload source for a full scan.",
  },
  QP203: {
    id: "QP203",
    title: "Funds held by an Ed25519-only key",
    severity: "low",
    summary:
      "The account is a plain wallet (an on-curve Ed25519 public key). On Solana the address is the public key, so it is permanently exposed; a large enough quantum computer could derive the secret key. There is no hash-based fallback.",
  },
  QP204: {
    id: "QP204",
    title: "Account owned by a single-key upgradeable program",
    severity: "info",
    summary: "The account's owner program can be replaced by one Ed25519 upgrade key, which could rewrite how this account is handled.",
  },
};

export const WEIGHTS: Record<Severity, number> = {
  critical: 30,
  high: 15,
  medium: 7,
  low: 3,
  info: 0,
};
