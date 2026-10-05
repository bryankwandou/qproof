import type { Finding } from "./types";
import { RULES } from "./rules";

interface IdlAccount {
  name: string;
  isMut?: boolean;
  isSigner?: boolean;
  writable?: boolean;
  signer?: boolean;
  accounts?: IdlAccount[];
}

interface IdlInstruction {
  name: string;
  accounts?: IdlAccount[];
  args?: { name: string; type: unknown }[];
}

const AUTHORITY = /^(authority|admin|owner|withdrawer|operator|manager|governor|.*Authority|.*_authority|.*Admin|.*_admin|.*Owner|.*_owner)$/;

function flatten(accounts: IdlAccount[] = []): IdlAccount[] {
  return accounts.flatMap((a) => (a.accounts ? flatten(a.accounts) : [a]));
}

function f(ruleId: string, message: string, fix: string): Finding {
  const meta = RULES[ruleId];
  return { ruleId, title: meta.title, severity: meta.severity, message, fix };
}

export function parseIdl(text: string): { instructions: IdlInstruction[]; name: string } {
  const json = JSON.parse(text);
  const instructions: IdlInstruction[] = Array.isArray(json.instructions) ? json.instructions : [];
  if (!instructions.length) throw new Error("IDL has no instructions array");
  return { instructions, name: json.name ?? json.metadata?.name ?? "program" };
}

export function scanIdl(text: string): Finding[] {
  const { instructions } = parseIdl(text);
  const out: Finding[] = [];
  for (const ix of instructions) {
    for (const arg of ix.args ?? []) {
      if (/bump/i.test(arg.name)) {
        out.push(
          f(
            "QP101",
            `Instruction \`${ix.name}\` takes \`${arg.name}\` as an argument. If it is passed to create_program_address or used in \`bump = ${arg.name}\`, callers can pick a non-canonical PDA.`,
            "Remove the bump argument and let the program derive it with find_program_address, or compare against a stored canonical bump.",
          ),
        );
      }
    }
    const accounts = flatten(ix.accounts);
    const signer = (a: IdlAccount) => Boolean(a.isSigner ?? a.signer);
    const writable = (a: IdlAccount) => Boolean(a.isMut ?? a.writable);
    for (const a of accounts) {
      if (AUTHORITY.test(a.name) && !signer(a)) {
        out.push(
          f(
            "QP102",
            `\`${ix.name}\` lists \`${a.name}\` without the signer flag. Check that the program verifies authority some other way.`,
            "Mark it as a signer, or document why authority is proven differently (for example by a PDA signer seed).",
          ),
        );
      }
    }
    if (accounts.some(writable) && !accounts.some(signer)) {
      out.push(
        f(
          "QP103",
          `\`${ix.name}\` writes to accounts but no account signs. Anyone can call it.`,
          "Confirm this is intended (cranks, permissionless settlement). Otherwise require a signer.",
        ),
      );
    }
  }
  return out;
}
