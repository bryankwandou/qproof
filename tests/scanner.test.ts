import { describe, expect, it } from "vitest";
import { buildReport, canonicalReport, scanIdl, scanRust, scanText, reportHash, toHex } from "../src/lib/scanner";
import { stripComments } from "../src/lib/scanner/rust";
import { FIXED_VAULT, SAMPLE_IDL, VULNERABLE_VAULT } from "../src/lib/samples";

const ids = (src: string) => scanRust(src).map((f) => `${f.ruleId}:${f.severity}`);

describe("QP001 non-canonical bump", () => {
  it("flags a bump read from instruction data", () => {
    const f = scanRust(VULNERABLE_VAULT).find((x) => x.ruleId === "QP001");
    expect(f?.severity).toBe("critical");
    expect(f?.snippet).toContain("create_program_address");
  });

  it("flags a bump passed as a function parameter", () => {
    const src = `fn check(program_id: &Pubkey, seed: &[u8], bump: u8) -> Result<Pubkey, ProgramError> {
      Pubkey::create_program_address(&[seed, &[bump]], program_id).map_err(|_| ProgramError::InvalidSeeds)
    }`;
    expect(ids(src)).toContain("QP001:critical");
  });

  it("flags args.bump directly", () => {
    const src = `fn f(program_id: &Pubkey, args: Args) { let k = Pubkey::create_program_address(&[b"x", &[args.bump]], program_id); }`;
    expect(ids(src)).toContain("QP001:critical");
  });

  it("accepts a bump from find_program_address", () => {
    const src = `fn f(program_id: &Pubkey) {
      let (_pda, bump) = Pubkey::find_program_address(&[b"x"], program_id);
      let k = Pubkey::create_program_address(&[b"x", &[bump]], program_id);
    }`;
    expect(scanRust(src).filter((f) => f.ruleId === "QP001")).toHaveLength(0);
  });

  it("accepts a bump compared against the canonical one", () => {
    const src = `fn f(program_id: &Pubkey, data: &[u8]) {
      let bump = data[0];
      let (_p, canonical) = Pubkey::find_program_address(&[b"x"], program_id);
      if bump != canonical { return; }
      let k = Pubkey::create_program_address(&[b"x", &[bump]], program_id);
    }`;
    expect(scanRust(src).filter((f) => f.ruleId === "QP001" && f.severity === "critical")).toHaveLength(0);
  });

  it("marks stored bumps as info", () => {
    const src = `fn f(program_id: &Pubkey, vault: &Vault) { let k = Pubkey::create_program_address(&[b"v", &[vault.bump]], program_id); }`;
    expect(ids(src)).toContain("QP001:info");
  });

  it("flags Anchor bump = <instruction arg>", () => {
    const src = `#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 8 + 32, seeds = [b"v"], bump = bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub payer: Signer<'info>,
}`;
    expect(ids(src)).toContain("QP001:critical");
  });

  it("does not flag Anchor bare bump or stored bump", () => {
    const src = `#[derive(Accounts)]
pub struct Use<'info> {
    #[account(seeds = [b"v"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = payer, space = 8, seeds = [b"w"], bump)]
    pub w: Account<'info, W>,
    pub payer: Signer<'info>,
}`;
    expect(scanRust(src).filter((f) => f.ruleId === "QP001")).toHaveLength(0);
  });

  it("ignores create_program_address inside comments", () => {
    expect(scanRust(`// Pubkey::create_program_address(&[&[data[0]]], id)\nfn f() {}`)).toHaveLength(0);
  });
});

describe("QP002 missing signer", () => {
  it("flags an authority account without is_signer", () => {
    expect(ids(VULNERABLE_VAULT)).toContain("QP002:high");
  });
  it("passes when is_signer is checked", () => {
    expect(scanRust(FIXED_VAULT).filter((f) => f.ruleId === "QP002")).toHaveLength(0);
  });
  it("flags Anchor UncheckedAccount authority", () => {
    const src = `#[derive(Accounts)]
pub struct SetAuth<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// CHECK: trust me
    pub authority: UncheckedAccount<'info>,
}`;
    expect(ids(src)).toContain("QP002:high");
  });
});

describe("QP003 missing owner", () => {
  it("flags data read without owner check", () => {
    expect(ids(VULNERABLE_VAULT)).toContain("QP003:high");
  });
  it("passes with owner comparison", () => {
    expect(scanRust(FIXED_VAULT).filter((f) => f.ruleId === "QP003")).toHaveLength(0);
  });
});

describe("QP004 one-time key reuse", () => {
  it("escalates WOTS + user bump to critical", () => {
    const f = scanRust(VULNERABLE_VAULT).filter((x) => x.ruleId === "QP004");
    expect(f.some((x) => x.severity === "critical")).toBe(true);
  });
  it("flags WOTS verification with no usage tracking", () => {
    const src = `fn f(data: &[u8]) -> ProgramResult { if data.len() < 1 { return Ok(()) } verify_winternitz(&data[1..], &[0u8; 32]) }`;
    expect(ids(src)).toContain("QP004:high");
  });
  it("does not fire on the fixed vault", () => {
    expect(scanRust(FIXED_VAULT).filter((f) => f.ruleId === "QP004")).toHaveLength(0);
  });
});

describe("QP005 unchecked reads", () => {
  it("flags slicing without a length check", () => {
    expect(ids(VULNERABLE_VAULT)).toContain("QP005:medium");
  });
  it("passes when length is checked", () => {
    expect(scanRust(FIXED_VAULT).filter((f) => f.ruleId === "QP005")).toHaveLength(0);
  });
});

describe("QP006 classical-only signatures", () => {
  it("flags ed25519-only verification", () => {
    expect(ids(`use solana_program::ed25519_program; fn f() {}`)).toContain("QP006:low");
  });
  it("is quiet when a hash-based scheme is present", () => {
    expect(ids(`use solana_program::ed25519_program; fn verify_winternitz() { let used = true; }`)).not.toContain("QP006:low");
  });
});

describe("QP007 lamport arithmetic", () => {
  it("flags plain -= on lamports", () => {
    expect(ids(VULNERABLE_VAULT)).toContain("QP007:medium");
  });
  it("passes checked math", () => {
    expect(scanRust(FIXED_VAULT).filter((f) => f.ruleId === "QP007")).toHaveLength(0);
  });
});

describe("IDL rules", () => {
  it("flags bump args, non-signer authority and signerless writes", () => {
    const r = scanIdl(SAMPLE_IDL).map((f) => f.ruleId);
    expect(r).toContain("QP101");
    expect(r).toContain("QP102");
    expect(r).toContain("QP103");
  });
  it("understands the Anchor 0.30+ IDL shape", () => {
    const idl = JSON.stringify({
      instructions: [{ name: "x", accounts: [{ name: "authority", writable: true, signer: true }], args: [] }],
    });
    expect(scanIdl(idl)).toHaveLength(0);
  });
});

describe("report", () => {
  it("scores the vulnerable vault low and the fixed one high", () => {
    const bad = scanText(VULNERABLE_VAULT);
    const good = scanText(FIXED_VAULT);
    expect(bad.score).toBeLessThan(20);
    expect(bad.grade).toBe("F");
    expect(good.score).toBeGreaterThanOrEqual(90);
  });
  it("routes JSON IDL input to the IDL scanner", () => {
    expect(scanText(SAMPLE_IDL).source).toBe("idl");
  });
  it("produces a stable 32-byte hash", async () => {
    const a = await reportHash(scanText(VULNERABLE_VAULT, "t"));
    const b = await reportHash(scanText(VULNERABLE_VAULT, "t"));
    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(a)).not.toBe(toHex(await reportHash(scanText(FIXED_VAULT, "t"))));
  });
  it("sorts findings by severity", () => {
    const r = buildReport("rust", "t", [
      { ruleId: "QP006", title: "", severity: "low", message: "", fix: "" },
      { ruleId: "QP001", title: "", severity: "critical", message: "", fix: "" },
    ]);
    expect(r.findings[0].severity).toBe("critical");
    expect(canonicalReport(r)).toContain("QP001");
  });
  it("strips block comments but keeps line count", () => {
    const s = "a\n/* x\ny */b";
    expect(stripComments(s).split("\n")).toHaveLength(3);
    expect(stripComments(s)).not.toContain("x");
  });
});

import { onchainFindings } from "../src/lib/scanner";

describe("on-chain facts", () => {
  it("flags a single-key upgrade authority and missing IDL", () => {
    const r = onchainFindings({ executable: true, upgradeable: true, upgradeAuthority: "x", authorityIsPda: false, idl: null });
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP201", "QP202"]);
  });
  it("is clean for an immutable program with a clean IDL", () => {
    const idl = JSON.stringify({ instructions: [{ name: "a", accounts: [{ name: "user", isMut: true, isSigner: true }], args: [] }] });
    const r = onchainFindings({ executable: true, upgradeable: false, upgradeAuthority: null, authorityIsPda: null, idl });
    expect(r.findings).toHaveLength(0);
  });
});

import { accountFindings } from "../src/lib/scanner";

describe("account facts", () => {
  const base = { exists: true, onCurve: true, owner: "11111111111111111111111111111111", lamports: 5e9, dataLength: 0, ownerUpgradeAuthorityOnCurve: null };
  it("flags a funded Ed25519 wallet", () => {
    expect(accountFindings(base).findings.map((f) => f.ruleId)).toEqual(["QP203"]);
  });
  it("is quiet for an empty wallet and for PDAs", () => {
    expect(accountFindings({ ...base, lamports: 0 }).findings).toHaveLength(0);
    expect(accountFindings({ ...base, onCurve: false }).findings).toHaveLength(0);
  });
  it("notes a single-key upgradeable owner program", () => {
    const r = accountFindings({ ...base, onCurve: false, owner: "Prog111", ownerUpgradeAuthorityOnCurve: true });
    expect(r.findings.map((f) => f.ruleId)).toEqual(["QP204"]);
  });
  it("handles missing accounts", () => {
    expect(accountFindings({ ...base, exists: false }).notes[0]).toMatch(/does not exist/);
  });
});
