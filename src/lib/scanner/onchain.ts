import type { Finding } from "./types";
import { RULES } from "./rules";
import { scanIdl } from "./idl";

export interface OnchainFacts {
  executable: boolean;
  upgradeable: boolean;
  upgradeAuthority: string | null;
  authorityIsPda: boolean | null;
  idl: string | null;
}

const mk = (id: string, message: string, fix: string): Finding => ({
  ruleId: id,
  title: RULES[id].title,
  severity: RULES[id].severity,
  message,
  fix,
});

export function onchainFindings(f: OnchainFacts): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  if (!f.executable) {
    notes.push("The address is not an executable program on this cluster.");
    return { findings, notes };
  }
  if (f.upgradeable && f.upgradeAuthority && f.authorityIsPda === false) {
    findings.push(
      mk(
        "QP201",
        `Upgrade authority ${f.upgradeAuthority} is a plain Ed25519 key. Whoever controls it can replace the program, and its public key is already on-chain for a future quantum attacker to work on.`,
        "Move the upgrade authority to a multisig or governance PDA, and plan a hash-based approval step for upgrades. Freeze the program if it no longer needs upgrades.",
      ),
    );
  } else if (f.upgradeable && f.authorityIsPda) {
    notes.push("Upgrade authority is a PDA (multisig or governance). Good.");
  } else if (!f.upgradeable) {
    notes.push("Program is immutable. No upgrade-key exposure.");
  }
  if (f.idl) {
    try {
      findings.push(...scanIdl(f.idl));
      notes.push("On-chain Anchor IDL found and scanned.");
    } catch {
      notes.push("An IDL account exists but could not be parsed.");
    }
  } else {
    findings.push(
      mk("QP202", "No Anchor IDL is published on-chain for this program.", "Upload the Rust source or IDL on the Source tab for instruction-level checks."),
    );
  }
  notes.push("Bytecode-level checks are not run. Source and IDL scans catch more.");
  return { findings, notes };
}
