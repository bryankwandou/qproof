import type { Finding } from "./types";
import { RULES } from "./rules";

export interface AccountFacts {
  exists: boolean;
  onCurve: boolean;
  owner: string;
  lamports: number;
  dataLength: number;
  ownerUpgradeAuthorityOnCurve: boolean | null;
}

const SYSTEM = "11111111111111111111111111111111";

const mk = (id: string, message: string, fix: string): Finding => ({
  ruleId: id,
  title: RULES[id].title,
  severity: RULES[id].severity,
  message,
  fix,
});

/** Findings for a non-executable account (wallet, PDA, token account...). */
export function accountFindings(f: AccountFacts): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  if (!f.exists) {
    notes.push("Account does not exist on this cluster.");
    return { findings, notes };
  }
  if (f.onCurve) {
    if (f.lamports > 0) {
      findings.push(
        mk(
          "QP203",
          `This address is an Ed25519 public key holding ${(f.lamports / 1e9).toFixed(4)} SOL. Its public key is already on-chain, so the only protection is the hardness of the elliptic-curve discrete log.`,
          "Keep long-term holdings behind a multisig or a program-controlled vault that can add a hash-based (for example Winternitz) approval step.",
        ),
      );
    } else {
      notes.push("Address is an Ed25519 key but holds no lamports.");
    }
  } else {
    notes.push("Address is off-curve (a PDA). No private key exists for it, so it has no direct Ed25519 exposure.");
  }
  if (f.owner !== SYSTEM) notes.push(`Owner program: ${f.owner} (${f.dataLength} bytes of data).`);
  if (f.ownerUpgradeAuthorityOnCurve) {
    findings.push(
      mk(
        "QP204",
        `Owner program ${f.owner} is upgradeable by a single Ed25519 key.`,
        "Scan the owner program itself for the upgrade-authority details.",
      ),
    );
  }
  return { findings, notes };
}
