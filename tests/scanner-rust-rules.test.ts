// Intensive positive / negative fixtures for every Rust source rule
// (QP001-QP007) in src/lib/scanner/rust.ts.
//
// Tests named "KNOWN BUG ..." use it.fails: they assert the behaviour the rule
// promises and currently fail. Each one names the src location. When a bug is
// fixed vitest flags the test, and it should become a normal `it`.
import { describe, expect, it } from "vitest";
import { scanRust } from "../src/lib/scanner";
import { RULES } from "../src/lib/scanner/rules";
import type { Finding } from "../src/lib/scanner";

const of = (src: string, id: string): Finding[] => scanRust(src).filter((f) => f.ruleId === id);
const sev = (src: string, id: string) => of(src, id).map((f) => f.severity);

/** Wrap a statement list in a native-program style function. */
const native = (body: string, params = "program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]") =>
  `pub fn process(${params}) -> ProgramResult {\n${body}\n}`;

/* ------------------------------------------------------------------ */
/* QP001 non-canonical PDA bump                                        */
/* ------------------------------------------------------------------ */

describe("QP001 non-canonical bump: caller-controlled (critical)", () => {
  const cases: [string, string][] = [
    ["data[N] passed directly", native(`let k = Pubkey::create_program_address(&[b"a", &[data[40]]], program_id)?;`)],
    ["instruction_data[N] passed directly", native(`let k = Pubkey::create_program_address(&[b"a", &[instruction_data[3]]], program_id)?;`, "program_id: &Pubkey, instruction_data: &[u8]")],
    ["ix_data[N] passed directly", native(`let k = Pubkey::create_program_address(&[b"a", &[ix_data[0]]], program_id)?;`, "program_id: &Pubkey, ix_data: &[u8]")],
    ["payload[N] passed directly", native(`let k = Pubkey::create_program_address(&[b"a", &[payload[0]]], program_id)?;`, "program_id: &Pubkey, payload: &[u8]")],
    ["let bump = data[N]", native(`let bump = data[40];\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["let bump: u8 = data[N]", native(`let bump: u8 = data[40];\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["let mut bump = input[N]", native(`let mut bump = input[0];\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`, "program_id: &Pubkey, input: &[u8]")],
    ["args.bump", native(`let k = Pubkey::create_program_address(&[b"a", &[args.bump]], program_id)?;`, "program_id: &Pubkey, args: Args")],
    ["params.bump", native(`let k = Pubkey::create_program_address(&[b"a", &[params.bump]], program_id)?;`, "program_id: &Pubkey, params: Params")],
    ["ix.bump", native(`let k = Pubkey::create_program_address(&[b"a", &[ix.bump]], program_id)?;`, "program_id: &Pubkey, ix: Ix")],
    ["instruction.bump", native(`let k = Pubkey::create_program_address(&[b"a", &[instruction.bump]], program_id)?;`, "program_id: &Pubkey, instruction: Ix")],
    ["let bump = args.bump", native(`let bump = args.bump;\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`, "program_id: &Pubkey, args: Args")],
    ["named vault_bump from data", native(`let vault_bump = data[1];\nlet k = Pubkey::create_program_address(&[b"v", &[vault_bump]], program_id)?;`)],
    ["bump: u8 function parameter", `fn check(program_id: &Pubkey, seed: &[u8], bump: u8) -> Pubkey {\n  Pubkey::create_program_address(&[seed, &[bump]], program_id).unwrap()\n}`],
    ["bump destructured from parsed instruction", native(`let WithdrawArgs { amount, bump } = WithdrawArgs::try_from_slice(data)?;\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["seeds passed through a local variable", native(`let bump = data[64];\nlet seeds = [b"a".as_ref(), &[bump]];\nlet k = Pubkey::create_program_address(&seeds, program_id)?;`)],
    ["try_create_program_address variant", native(`let k = Pubkey::try_create_program_address(&[b"a", &[data[0]]], program_id);`)],
  ];
  it.each(cases)("%s", (_label, src) => {
    expect(sev(src, "QP001")).toEqual(["critical"]);
  });

  it("names the caller-controlled expression in the message and uses rule metadata", () => {
    const [f] = of(native(`let bump = data[40];\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`), "QP001");
    expect(f.message).toContain("`bump`");
    expect(f.message).toMatch(/caller input/);
    expect(f.title).toBe(RULES.QP001.title);
    expect(f.fix).toMatch(/find_program_address/);
  });

  it("reports the line of the create_program_address call, with the original snippet", () => {
    const src = [
      "pub fn process(program_id: &Pubkey, data: &[u8]) -> ProgramResult {", // 1
      "    let bump = data[40];", // 2
      "    // derive the record address", // 3
      "    let expected = Pubkey::create_program_address(", // 4
      '        &[b"wots", &[bump]],', // 5
      "        program_id,", // 6
      "    )?;", // 7
      "}",
    ].join("\n");
    const [f] = of(src, "QP001");
    expect(f.line).toBe(4);
    expect(f.snippet).toBe("let expected = Pubkey::create_program_address(");
  });

  it("the worst candidate wins when canonical and caller bumps are mixed", () => {
    const src = native(`let (_p, good) = Pubkey::find_program_address(&[b"a"], program_id);\nlet k = Pubkey::create_program_address(&[&[good], &[data[0]]], program_id)?;`);
    const fs = of(src, "QP001");
    expect(fs.map((f) => f.severity)).toEqual(["critical"]);
    expect(fs[0].message).toContain("`data[0]`");
  });

  it("emits one finding per call site, each with its own line", () => {
    const src = [
      "fn a(p: &Pubkey, data: &[u8]) { let k = Pubkey::create_program_address(&[&[data[0]]], p); }",
      "fn b(p: &Pubkey, data: &[u8]) {",
      "  let k = Pubkey::create_program_address(&[&[data[1]]], p);",
      "}",
    ].join("\n");
    expect(of(src, "QP001").map((f) => [f.severity, f.line])).toEqual([
      ["critical", 1],
      ["critical", 3],
    ]);
  });
});

describe("QP001 Anchor bump constraints", () => {
  const anchor = (ixAttr: string, accountAttr: string) =>
    `#[derive(Accounts)]\n${ixAttr}\npub struct Init<'info> {\n    #[account(${accountAttr})]\n    pub vault: Account<'info, Vault>,\n    #[account(mut)]\n    pub payer: Signer<'info>,\n}`;

  it.each([
    ["bump = <#[instruction] param>", anchor("#[instruction(bump: u8)]", 'init, payer = payer, space = 8, seeds = [b"v"], bump = bump')],
    ["bump = <second #[instruction] param>", anchor("#[instruction(amount: u64, vault_bump: u8)]", 'seeds = [b"v"], bump = vault_bump')],
    ["bump = args.bump", anchor("", 'seeds = [b"v"], bump = args.bump')],
    ["bump = params.vault_bump", anchor("", 'seeds = [b"v"], bump = params.vault_bump')],
    ["bump = data.bump", anchor("", 'seeds = [b"v"], bump = data.bump')],
    ["multi-line attribute", anchor("#[instruction(bump: u8)]", 'mut,\n        seeds = [b"v", payer.key().as_ref()],\n        bump = bump,\n    ')],
  ])("flags %s as critical", (_label, src) => {
    const fs = of(src, "QP001");
    expect(fs.map((f) => f.severity)).toEqual(["critical"]);
    expect(fs[0].message).toMatch(/Anchor constraint uses `bump = /);
  });

  it("reports the line of the bump constraint", () => {
    const src = anchor("#[instruction(bump: u8)]", 'seeds = [b"v"], bump = bump');
    expect(of(src, "QP001")[0].line).toBe(4);
  });

  it.each([
    ["bare bump", anchor("#[instruction(bump: u8)]", 'init, payer = payer, space = 8, seeds = [b"v"], bump')],
    ["bump = vault.bump (stored)", anchor("", 'seeds = [b"v"], bump = vault.bump')],
    ["bump = ctx.bumps.vault", anchor("", 'seeds = [b"v"], bump = ctx.bumps.vault')],
    ["bump = data_account.bump (prefix is not a word match)", anchor("", 'seeds = [b"v"], bump = data_account.bump')],
    ["constraint comparing bumps", anchor("#[instruction(bump: u8)]", 'seeds = [b"v"], bump, constraint = vault.bump == bump')],
  ])("does not flag %s", (_label, src) => {
    expect(of(src, "QP001")).toHaveLength(0);
  });

  it("ignores `bump = x` outside any #[account(...)] attribute", () => {
    const src = `#[instruction(bump: u8)]\npub struct A<'info> {\n    #[account(mut)]\n    pub v: Account<'info, V>,\n}\nfn f(bump: u8) { let b2 = 1; let s = Cfg { x: b2 }; let bump = bump; }`;
    expect(of(src, "QP001")).toHaveLength(0);
  });

  it("ignores a commented-out constraint", () => {
    const src = anchor("#[instruction(bump: u8)]", 'seeds = [b"v"], bump /* = bump */');
    expect(of(src, "QP001")).toHaveLength(0);
  });
});

describe("QP001 untraceable bump (high) and stored bump (info)", () => {
  it("is high when the bump comes from an opaque helper", () => {
    const src = `fn f(p: &Pubkey, seed: &[u8]) { let bump = compute(seed); let k = Pubkey::create_program_address(&[seed, &[bump]], p); }`;
    const fs = of(src, "QP001");
    expect(fs.map((f) => f.severity)).toEqual(["high"]);
    expect(fs[0].message).toMatch(/could not be traced/);
  });

  it("is high when the seeds arrive as an opaque parameter", () => {
    const src = `fn derive(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey { Pubkey::create_program_address(seeds, program_id).unwrap() }`;
    expect(sev(src, "QP001")).toEqual(["high"]);
  });

  it("is high when the seeds variable is defined without a recognisable bump", () => {
    const src = `fn f(p: &Pubkey) { let seeds = make_seeds(); let k = Pubkey::create_program_address(&seeds, p); }`;
    expect(sev(src, "QP001")).toEqual(["high"]);
  });

  it.each([
    ["account.bump", `fn f(p: &Pubkey, vault: &Vault) { let k = Pubkey::create_program_address(&[b"v", &[vault.bump]], p); }`],
    ["ctx.accounts.x.bump", `fn f(p: &Pubkey, ctx: Ctx) { let k = Pubkey::create_program_address(&[b"v", &[ctx.accounts.vault.bump]], p); }`],
    ["let bump = state.bump", `fn f(p: &Pubkey, state: &State) { let bump = state.bump; let k = Pubkey::create_program_address(&[b"v", &[bump]], p); }`],
  ])("is info for a stored bump: %s", (_label, src) => {
    const fs = of(src, "QP001");
    expect(fs.map((f) => f.severity)).toEqual(["info"]);
    expect(fs[0].message).toMatch(/read from account state/);
  });
});

describe("QP001 negatives", () => {
  it.each([
    ["bump destructured from Pubkey::find_program_address", native(`let (_pda, bump) = Pubkey::find_program_address(&[b"a"], program_id);\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["bump destructured from bare find_program_address", native(`let (_pda, b) = find_program_address(&[b"a"], program_id);\nlet k = Pubkey::create_program_address(&[b"a", &[b]], program_id)?;`)],
    ["let bump = find_program_address(..).1", native(`let bump = Pubkey::find_program_address(&[b"a"], program_id).1;\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["caller bump compared with canonical (bump != canonical)", native(`let bump = data[0];\nlet (_p, canonical) = Pubkey::find_program_address(&[b"a"], program_id);\nif bump != canonical { return Err(ProgramError::InvalidSeeds); }\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["caller bump compared with canonical (canonical_bump == bump)", native(`let bump = data[0];\nif canonical_bump == bump { } else { return Err(ProgramError::InvalidSeeds); }\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`)],
    ["only find_program_address used", native(`let (_k, bump) = Pubkey::find_program_address(&[b"a"], program_id);`)],
    ["call inside a line comment", `// Pubkey::create_program_address(&[&[data[0]]], id)\nfn f() {}`],
    ["call inside a block comment", `/* let k = Pubkey::create_program_address(&[&[data[0]]], id); */ fn f() {}`],
    ["call inside a doc comment", `/// Never use Pubkey::create_program_address(&[&[data[0]]], id)\nfn f() {}`],
    ["empty source", ""],
  ])("%s", (_label, src) => {
    expect(of(src, "QP001")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:169 ignores create_program_address inside a string literal", () => {
    const src = `fn f() { msg!("create_program_address(&[&[data[0]]])"); }`;
    expect(of(src, "QP001")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:143-152 treats ix_data.bump / instruction_data.bump as caller input", () => {
    const a = `fn f(p: &Pubkey, ix_data: Ix) { let k = Pubkey::create_program_address(&[b"a", &[ix_data.bump]], p); }`;
    const b = `fn f(p: &Pubkey, instruction_data: Ix) { let k = Pubkey::create_program_address(&[b"a", &[instruction_data.bump]], p); }`;
    expect([...sev(a, "QP001"), ...sev(b, "QP001")]).toEqual(["critical", "critical"]);
  });

  it.fails("KNOWN BUG rust.ts:151 does not accept a comparison against `noncanonical` as canonical", () => {
    const src = native(`let bump = data[0];\nif bump == noncanonical { }\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;`);
    expect(sev(src, "QP001")).toEqual(["critical"]);
  });

  it.fails("KNOWN BUG rust.ts:151 a canonical comparison made after the call does not protect it", () => {
    const src = native(`let bump = data[0];\nlet k = Pubkey::create_program_address(&[b"a", &[bump]], program_id)?;\nlet ok = bump == canonical;`);
    expect(sev(src, "QP001")).toEqual(["critical"]);
  });

  it.fails("KNOWN BUG rust.ts:162 a bump destructured from stored account state is not caller input", () => {
    const src = native(`let VaultState { bump, .. } = VaultState::try_from_slice(&vault.data.borrow())?;\nlet k = Pubkey::create_program_address(&[b"v", &[bump]], program_id)?;`);
    expect(sev(src, "QP001")).not.toContain("critical");
  });
});

/* ------------------------------------------------------------------ */
/* QP002 missing signer check                                          */
/* ------------------------------------------------------------------ */

describe("QP002 missing signer check: native programs", () => {
  const nextAccount = (name: string, extra = "") =>
    native(`let it = &mut accounts.iter();\nlet ${name} = next_account_info(it)?;\n${extra}`);

  it.each([
    "authority",
    "admin",
    "owner",
    "signer",
    "withdrawer",
    "attester",
    "operator",
    "manager",
    "governor",
    "upgrade_authority",
    "mint_authority",
    "pool_admin",
    "token_owner",
    "ADMIN",
  ])("flags authority-like `%s` as high", (name) => {
    const fs = of(nextAccount(name), "QP002");
    expect(fs.map((f) => f.severity)).toEqual(["high"]);
    expect(fs[0].message).toContain(`\`${name}.is_signer\``);
    expect(fs[0].fix).toContain(`!${name}.is_signer`);
    expect(fs[0].line).toBe(3);
  });

  it.each(["payer", "user", "funder"])("flags `%s` as medium", (name) => {
    expect(sev(nextAccount(name), "QP002")).toEqual(["medium"]);
  });

  it.each([
    ["let [vault, authority] = accounts else", "let [vault, authority] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };"],
    ["let [mut admin, ..] = accounts", "let [mut admin, ..] = accounts else { return Ok(()) };"],
    ["let [ref owner, _] = accounts", "let [ref owner, _] = accounts else { return Ok(()) };"],
  ])("finds destructured accounts: %s", (_label, stmt) => {
    expect(sev(native(stmt), "QP002")).toEqual(["high"]);
  });

  it("flags each unchecked authority separately", () => {
    const src = native(`let it = &mut accounts.iter();\nlet admin = next_account_info(it)?;\nlet payer = next_account_info(it)?;\nif !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }\nlet owner = next_account_info(it)?;`);
    expect(of(src, "QP002").map((f) => f.message.match(/`(\w+)`/)?.[1])).toEqual(["admin", "owner"]);
  });

  it.each([
    ["is_signer field", "if !admin.is_signer { return Err(ProgramError::MissingRequiredSignature); }"],
    ["is_signer() method (pinocchio)", "if !admin.is_signer() { return Err(ProgramError::MissingRequiredSignature); }"],
    ["is_signer with spaces", "if !admin . is_signer { return Ok(()); }"],
  ])("is quiet when checked via %s", (_label, check) => {
    expect(of(nextAccount("admin", check), "QP002")).toHaveLength(0);
  });

  it.each(["vault", "state", "mint", "system_program", "recipient", "authority_record"])(
    "ignores non-authority account `%s`",
    (name) => {
      expect(of(nextAccount(name), "QP002")).toHaveLength(0);
    },
  );

  it("ignores accounts declared only in comments", () => {
    expect(of(native("// let admin = next_account_info(it)?;"), "QP002")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:264 sees `let mut admin = next_account_info(..)`", () => {
    expect(sev(native("let it = &mut accounts.iter();\nlet mut admin = next_account_info(it)?;"), "QP002")).toEqual(["high"]);
  });

  it.fails("KNOWN BUG rust.ts:264 sees typed `let admin: &AccountInfo = next_account_info(..)`", () => {
    expect(sev(native("let it = &mut accounts.iter();\nlet admin: &AccountInfo = next_account_info(it)?;"), "QP002")).toEqual(["high"]);
  });

  it.fails("KNOWN BUG rust.ts:266 sees `let [vault, authority] = &accounts[..]`", () => {
    expect(sev(native("let [vault, authority] = &accounts[..] else { return Ok(()) };"), "QP002")).toEqual(["high"]);
  });

  it.fails("KNOWN BUG rust.ts:308 an is_signer check in another function does not cover this one", () => {
    const src = [
      "fn a(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let admin = next_account_info(it)?; if !admin.is_signer { return } }",
      "fn b(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let admin = next_account_info(it)?; }",
    ].join("\n");
    expect(of(src, "QP002").map((f) => f.line)).toEqual([2]);
  });
});

describe("QP002 missing signer check: Anchor", () => {
  const accounts = (fields: string) => `#[derive(Accounts)]\npub struct Ctx<'info> {\n    #[account(mut)]\n    pub vault: Account<'info, Vault>,\n${fields}\n}`;

  it.each([
    ["UncheckedAccount", "    /// CHECK: trusted\n    pub authority: UncheckedAccount<'info>,", "UncheckedAccount"],
    ["AccountInfo", "    pub admin: AccountInfo<'info>,", "AccountInfo"],
    ["AccountInfo with #[account(mut)]", "    #[account(mut)]\n    pub owner: AccountInfo<'info>,", "AccountInfo"],
    ["AccountInfo with has_one only", "    #[account(constraint = vault.authority == authority.key())]\n    pub authority: AccountInfo<'info>,", "AccountInfo"],
  ])("flags an authority declared as %s", (_label, field, type) => {
    const fs = of(accounts(field), "QP002");
    expect(fs.map((f) => f.severity)).toEqual(["high"]);
    expect(fs[0].message).toContain(`declared as ${type}`);
    expect(fs[0].fix).toMatch(/Signer<'info>/);
  });

  it("points at the line of the field", () => {
    const src = accounts("    /// CHECK: x\n    pub authority: UncheckedAccount<'info>,");
    expect(of(src, "QP002")[0].line).toBe(6);
    expect(of(src, "QP002")[0].snippet).toBe("pub authority: UncheckedAccount<'info>,");
  });

  it("flags a Box<UncheckedAccount> authority", () => {
    expect(sev(accounts("    pub authority: Box<UncheckedAccount<'info>>,"), "QP002")).toEqual(["high"]);
  });

  it.each([
    ["Signer<'info>", "    pub authority: Signer<'info>,"],
    ["#[account(signer)] AccountInfo", "    #[account(signer)]\n    pub authority: AccountInfo<'info>,"],
    ["#[account(mut, signer)] UncheckedAccount", "    /// CHECK: signer\n    #[account(mut, signer)]\n    pub admin: UncheckedAccount<'info>,"],
    ["Account<'info, T> named authority", "    pub authority: Account<'info, AuthorityConfig>,"],
    ["non-authority UncheckedAccount", "    /// CHECK: any\n    pub recipient: UncheckedAccount<'info>,"],
    ["Program<'info, System>", "    pub system_program: Program<'info, System>,"],
  ])("is quiet for %s", (_label, field) => {
    expect(of(accounts(field), "QP002")).toHaveLength(0);
  });

  it("does not take the signer attribute of the previous field", () => {
    const src = accounts("    #[account(signer)]\n    pub payer: AccountInfo<'info>,\n    pub authority: AccountInfo<'info>,");
    expect(of(src, "QP002").map((f) => f.message)).toEqual([expect.stringContaining("`authority`")]);
  });

  it.fails("KNOWN BUG rust.ts:330 names the inner type for Box<UncheckedAccount> (message says `Box`)", () => {
    const [f] = of(accounts("    pub authority: Box<UncheckedAccount<'info>>,"), "QP002");
    expect(f.message).toContain("UncheckedAccount");
  });

  it.fails("KNOWN BUG rust.ts:285 checks Option<UncheckedAccount> authorities", () => {
    expect(sev(accounts("    pub authority: Option<UncheckedAccount<'info>>,"), "QP002")).toEqual(["high"]);
  });
});

/* ------------------------------------------------------------------ */
/* QP003 missing owner check                                           */
/* ------------------------------------------------------------------ */

describe("QP003 missing owner check: native programs", () => {
  const read = (method: string, extra = "") =>
    native(`let it = &mut accounts.iter();\nlet state = next_account_info(it)?;\n${extra}\nlet d = state.${method};`);

  it.each([
    "try_borrow_data()?",
    "try_borrow_mut_data()?",
    "data.borrow()",
    "data.borrow_mut()",
    "borrow_data_unchecked()",
    "borrow_mut_data_unchecked()",
    "try_borrow()?",
    "try_borrow_mut()?",
  ])("flags a read via .%s without an owner check", (method) => {
    const fs = of(read(method), "QP003");
    expect(fs.map((f) => f.severity)).toEqual(["high"]);
    expect(fs[0].message).toContain("`state.owner`");
    expect(fs[0].fix).toContain("state.owner == program_id");
  });

  it("points at the read, not the declaration", () => {
    const src = read("try_borrow_data()?");
    expect(of(src, "QP003")[0].line).toBe(5);
  });

  it("reports only the first read of each account", () => {
    const src = read("try_borrow_data()?", "let x = state.data.borrow();");
    expect(of(src, "QP003")).toHaveLength(1);
  });

  it("covers destructured accounts", () => {
    const src = native("let [config, vault] = accounts else { return Ok(()) };\nlet d = config.try_borrow_data()?;");
    expect(of(src, "QP003").map((f) => f.message)).toEqual([expect.stringContaining("`config`")]);
  });

  it.each([
    ["state.owner != program_id", "if state.owner != program_id { return Err(ProgramError::IncorrectProgramId); }"],
    ["state.owner() (pinocchio)", "if state.owner() != program_id { return Err(ProgramError::IncorrectProgramId); }"],
    ["state.is_owned_by(..)", "if !state.is_owned_by(program_id) { return Err(ProgramError::IncorrectProgramId); }"],
    ["check_owner(&state, ..)", "check_owner(&state, program_id)?;"],
    ["check_owner_is(state, ..)", "check_owner_is(state, program_id)?;"],
    ["create_account(.., state.key, ..)", "invoke(&system_instruction::create_account(payer.key, state.key, lamports, 64, program_id), &[])?;"],
  ])("is quiet with %s", (_label, extra) => {
    expect(of(read("try_borrow_data()?", extra), "QP003")).toHaveLength(0);
  });

  it("is quiet when the account data is never read", () => {
    expect(of(native("let it = &mut accounts.iter();\nlet state = next_account_info(it)?;"), "QP003")).toHaveLength(0);
  });

  it("does not treat lamport borrows as data reads", () => {
    expect(of(read("try_borrow_mut_lamports()?"), "QP003")).toHaveLength(0);
  });

  it("an owner check inside a comment does not count", () => {
    expect(of(read("try_borrow_data()?", "// if state.owner != program_id { .. }"), "QP003")).toHaveLength(1);
  });

  it.fails("KNOWN BUG rust.ts:349 an owner check in another function does not cover this read", () => {
    const src = [
      "fn a(p: &Pubkey, accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let state = next_account_info(it)?; if state.owner != p { return } }",
      "fn b(accounts: &[AccountInfo]) { let it = &mut accounts.iter(); let state = next_account_info(it)?; let d = state.try_borrow_data()?; }",
    ].join("\n");
    expect(of(src, "QP003").map((f) => f.line)).toEqual([2]);
  });

  it.fails("KNOWN BUG rust.ts:264 checks accounts bound with `let mut`", () => {
    const src = native("let it = &mut accounts.iter();\nlet mut state = next_account_info(it)?;\nlet d = state.try_borrow_mut_data()?;");
    expect(sev(src, "QP003")).toEqual(["high"]);
  });
});

describe("QP003 missing owner check: Anchor", () => {
  const ctx = (field: string, body = "let d = ctx.accounts.config.try_borrow_data()?;") =>
    `#[derive(Accounts)]\npub struct Ctx<'info> {\n${field}\n}\npub fn handler(ctx: Context<Ctx>) -> Result<()> {\n    ${body}\n    Ok(())\n}`;

  it.each([
    ["UncheckedAccount + try_borrow_data", "    /// CHECK: x\n    pub config: UncheckedAccount<'info>,", "let d = ctx.accounts.config.try_borrow_data()?;"],
    ["AccountInfo + data.borrow()", "    pub config: AccountInfo<'info>,", "let d = ctx.accounts.config.data.borrow();"],
    ["UncheckedAccount + try_borrow_mut_data", "    /// CHECK: x\n    #[account(mut)]\n    pub config: UncheckedAccount<'info>,", "let d = ctx.accounts.config.try_borrow_mut_data()?;"],
  ])("flags %s without owner =", (_label, field, body) => {
    const fs = of(ctx(field, body), "QP003");
    expect(fs.map((f) => f.severity)).toEqual(["high"]);
    expect(fs[0].message).toMatch(/no `owner = \.\.\.` constraint/);
    expect(fs[0].line).toBe(6 + field.split("\n").length - 1);
  });

  it.each([
    ["#[account(owner = crate::ID)]", "    /// CHECK: owner checked\n    #[account(owner = crate::ID)]\n    pub config: UncheckedAccount<'info>,"],
    ["constraint = config.owner == ..", "    /// CHECK: x\n    #[account(constraint = config.owner == &crate::ID)]\n    pub config: UncheckedAccount<'info>,"],
    ["typed Account<'info, T>", "    pub config: Account<'info, Config>,"],
  ])("is quiet with %s", (_label, field) => {
    expect(of(ctx(field), "QP003")).toHaveLength(0);
  });

  it("is quiet when an unchecked account is never read", () => {
    expect(of(ctx("    /// CHECK: x\n    pub config: UncheckedAccount<'info>,", "msg!(\"hi\");"), "QP003")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* QP004 one-time key reuse                                            */
/* ------------------------------------------------------------------ */

describe("QP004 one-time key reuse", () => {
  const verify = (call: string, extra = "") => `fn verify(data: &[u8]) -> ProgramResult {\n    if data.len() < 2 { return Ok(()); }\n    ${call}(&data[1..])?;\n    ${extra}\n    Ok(())\n}`;

  it.each(["wots_verify", "verify_winternitz", "WOTS_VERIFY", "xmss_verify", "lamport_sig_verify", "one_time_sig", "onetime_verify", "ots_check", "hors_verify", "lms_verify", "my_wots"])(
    "flags `%s` with no usage record as high",
    (call) => {
      const fs = of(verify(call), "QP004");
      expect(fs.map((f) => f.severity)).toEqual(["high"]);
      expect(fs[0].line).toBe(3);
      expect(fs[0].message).toMatch(/nothing records that the key/);
    },
  );

  it("`unused` is not a usage marker", () => {
    expect(sev(`#[allow(unused)]\n${verify("wots_verify")}`, "QP004")).toEqual(["high"]);
  });

  it.each(["used", "is_used", "consumed", "spent", "nullifier", "nonce", "sequence", "counter", "epoch", "leaf_index", "next_index"])(
    "is quiet when `%s` is recorded",
    (marker) => {
      expect(of(verify("wots_verify", `rec.${marker} = 1;`), "QP004")).toHaveLength(0);
    },
  );

  it("is quiet when an Anchor `close =` consumes the record", () => {
    const src = `${verify("wots_verify")}\n#[derive(Accounts)]\npub struct V<'info> {\n    #[account(mut, close = payer)]\n    pub record: Account<'info, Rec>,\n}`;
    expect(of(src, "QP004")).toHaveLength(0);
  });

  it.each([
    ["no one-time scheme", "fn verify() { ed25519_verify(); }"],
    ["a scheme name only in a comment", "// TODO: add winternitz\nfn f() {}"],
    ["a scheme name glued to letters", "fn f() { let twots = 1; let xwinternitz = 2; }"],
    ["empty source", ""],
  ])("is quiet with %s", (_label, src) => {
    expect(of(src, "QP004")).toHaveLength(0);
  });

  it("escalates to critical when combined with a caller-chosen bump", () => {
    const src = `fn verify(p: &Pubkey, data: &[u8]) {\n  if data.len() < 41 { return }\n  let k = Pubkey::create_program_address(&[b"wots", &[data[40]]], p);\n  verify_winternitz(&data[1..]);\n}`;
    const fs = of(src, "QP004");
    expect(fs.map((f) => f.severity).sort()).toEqual(["critical", "high"]);
    expect(fs.find((f) => f.severity === "critical")?.message).toMatch(/caller-chosen PDA bump/);
  });

  it("escalates even when a usage record exists, because it can be re-created at another bump", () => {
    const src = `fn verify(p: &Pubkey, data: &[u8], rec: &mut Rec) {\n  if data.len() < 41 { return }\n  let k = Pubkey::create_program_address(&[b"wots", &[data[40]]], p);\n  verify_winternitz(&data[1..]);\n  rec.used = true;\n}`;
    expect(sev(src, "QP004")).toEqual(["critical"]);
  });

  it("does not escalate for an untraceable (high) or stored (info) bump", () => {
    const high = `fn verify(p: &Pubkey, rec: &mut Rec) { let k = Pubkey::create_program_address(&[b"w", &[compute()]], p); verify_winternitz(); rec.used = true; }`;
    const info = `fn verify(p: &Pubkey, rec: &mut Rec) { let k = Pubkey::create_program_address(&[b"w", &[rec.bump]], p); verify_winternitz(); rec.used = true; }`;
    expect(of(high, "QP004")).toHaveLength(0);
    expect(of(info, "QP004")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:387 `horse` is not a HORS signature", () => {
    expect(of("fn horse_power() -> u8 { 1 }", "QP004")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:387 a one_time_init function is not a one-time signature", () => {
    expect(of("pub fn one_time_init(ctx: Context<Init>) -> Result<()> { Ok(()) }", "QP004")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:388 the word `used` inside a string literal is not a usage record", () => {
    expect(sev(verify("wots_verify", 'msg!("signature used");'), "QP004")).toEqual(["high"]);
  });
});

/* ------------------------------------------------------------------ */
/* QP005 unchecked data reads                                          */
/* ------------------------------------------------------------------ */

describe("QP005 unchecked data reads", () => {
  const fn = (params: string, body: string) => `fn handler(${params}) -> ProgramResult {\n    ${body}\n    Ok(())\n}`;

  it.each([
    ["data[0]", "data: &[u8]", "let t = data[0];"],
    ["instruction_data[3]", "instruction_data: &[u8]", "let t = instruction_data[3];"],
    ["ix_data[1]", "ix_data: &[u8]", "let t = ix_data[1];"],
    ["input[2]", "input: &[u8]", "let t = input[2];"],
    ["buf[0]", "buf: &[u8]", "let t = buf[0];"],
    ["bytes[7]", "bytes: &[u8]", "let t = bytes[7];"],
    ["raw[1]", "raw: &[u8]", "let t = raw[1];"],
    ["data[0..8]", "data: &[u8]", "let a = &data[0..8];"],
    ["data[..8]", "data: &[u8]", "let a = &data[..8];"],
    ["data[8..]", "data: &[u8]", "let a = &data[8..];"],
    ["data[a..b]", "data: &[u8]", "let a = &data[start..end];"],
    ["account_data[0..4]", "account_data: &[u8]", "let a = &account_data[0..4];"],
    ["data[ 1 .. 33 ] with spaces", "data: &[u8]", "let a = &data[ 1 .. 33 ];"],
  ])("flags %s without a length check", (_label, params, body) => {
    const fs = of(fn(params, body), "QP005");
    expect(fs.map((f) => f.severity)).toEqual(["medium"]);
    expect(fs[0].line).toBe(2);
    expect(fs[0].message).toContain("`handler`");
  });

  it("compacts whitespace of the offending expression in the message", () => {
    const [f] = of(fn("data: &[u8]", "let a = &data[ 1 .. 33 ];"), "QP005");
    expect(f.message).toContain("`data[1..33]`");
  });

  it("emits one finding per function, at its first unchecked read", () => {
    const src = `fn a(data: &[u8]) {\n  let x = data[0];\n  let y = data[1];\n}\nfn b(input: &[u8]) {\n  let z = &input[1..];\n}`;
    expect(of(src, "QP005").map((f) => f.line)).toEqual([2, 6]);
  });

  it.each([
    ["len() <", "if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }"],
    ["len() >", "if 8 > data.len() { return Ok(()); } if data.len() > 64 { return Ok(()); }"],
    ["len() !=", "if data.len() != 8 { return Ok(()); }"],
    ["len() ==", "if data.len() == 0 { return Ok(()); }"],
    ["len() >=", "assert!(data.len() >= 8);"],
    ["len() <=", "if data.len() <= 7 { return Ok(()); }"],
    [".get(0..8)", "let h = data.get(0..8).ok_or(ProgramError::InvalidInstructionData)?;"],
    [".get(..8)", "let h = data.get(..8);"],
    [".get(start..)", "let h = data.get(start..);"],
    ["ensure_len", "ensure_len(data, 8)?;"],
    ["require!(data.len ..)", "require!(data.len() >= 8, E::Short);"],
    ["split_at_checked", "let (a, b) = data.split_at_checked(8).unwrap();"],
    ["first_chunk", "let a = data.first_chunk::<8>();"],
    ["chunks_exact", "for c in data.chunks_exact(8) {}"],
  ])("is quiet with a %s guard", (_label, guard) => {
    expect(of(fn("data: &[u8]", `${guard}\n    let a = &data[0..8];`), "QP005")).toHaveLength(0);
  });

  it.each([
    ["an unlisted buffer name", "payload: &[u8]", "let t = payload[0];"],
    ["a variable index", "data: &[u8]", "let t = data[i];"],
    ["no indexing at all", "data: &[u8]", "let t = data.to_vec();"],
    ["indexing only in a comment", "data: &[u8]", "// let t = data[0];"],
  ])("is quiet for %s", (_label, params, body) => {
    expect(of(fn(params, body), "QP005")).toHaveLength(0);
  });

  it("does not report indexing outside any function body", () => {
    expect(of("const X: u8 = data[0];", "QP005")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:428 accepts an is_empty() guard", () => {
    expect(of(fn("data: &[u8]", "if data.is_empty() { return Ok(()); }\n    let t = data[0];"), "QP005")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:426 flags inclusive ranges like data[0..=7]", () => {
    expect(sev(fn("data: &[u8]", "let a = &data[0..=7];"), "QP005")).toEqual(["medium"]);
  });

  it.fails("KNOWN BUG rust.ts:426 flags account_data[N] like account_data[a..b]", () => {
    expect(sev(fn("account_data: &[u8]", "let t = account_data[3];"), "QP005")).toEqual(["medium"]);
  });

  it.fails("KNOWN BUG rust.ts:85 still scans functions with nested generic bounds", () => {
    expect(sev("fn f<T: Into<u8>>(data: &[u8]) { let t = data[0]; }", "QP005")).toEqual(["medium"]);
  });
});

/* ------------------------------------------------------------------ */
/* QP006 classical-only signatures                                     */
/* ------------------------------------------------------------------ */

describe("QP006 classical-only signatures", () => {
  it.each([
    "use ed25519::Signature;",
    "use solana_program::secp256k1_recover::secp256k1_recover;",
    "let k = secp256r1::verify(x);",
    "use solana_program::ed25519_program;",
    "use ed25519_dalek::Verifier;",
    "use libsecp256k1::verify;",
    "pk.verify_strict(&msg, &sig)?;",
    "use Ed25519;",
  ])("flags `%s` as low", (stmt) => {
    const src = `${stmt}\nfn f() {}`;
    const fs = of(src, "QP006");
    expect(fs.map((f) => f.severity)).toEqual(["low"]);
    expect(fs[0].line).toBe(1);
    expect(fs[0].fix).toMatch(/hash-based/);
  });

  it("reports only the first classical mention", () => {
    expect(of("use ed25519_dalek;\nfn f() {}\nuse secp256k1;", "QP006")).toHaveLength(1);
  });

  it.each(["wots", "winternitz", "sphincs", "slh_dsa", "slhdsa", "ml_dsa", "mldsa", "dilithium", "falcon", "xmss", "lms", "lamport_sig"])(
    "is quiet when hash-based / PQ scheme `%s` is present",
    (pq) => {
      expect(of(`use ed25519_dalek;\nfn ${pq}_verify() { let used = true; }`, "QP006")).toHaveLength(0);
    },
  );

  it.each([
    ["no signature code", "fn f() {}"],
    ["classical names only in comments", "// ed25519 and secp256k1\nfn f() {}"],
    ["a classical name glued into an identifier", "fn f() { let my_ed25519x = 1; }"],
  ])("is quiet with %s", (_label, src) => {
    expect(of(src, "QP006")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:448 touching `lamports` is not a hash-based (Lamport) signature", () => {
    const src = "use solana_program::ed25519_program;\nfn f(a: &AccountInfo) -> u64 { a.lamports() }";
    expect(sev(src, "QP006")).toEqual(["low"]);
  });
});

/* ------------------------------------------------------------------ */
/* QP007 unchecked lamport arithmetic                                  */
/* ------------------------------------------------------------------ */

describe("QP007 unchecked lamport arithmetic", () => {
  it.each([
    ["**a.lamports.borrow_mut() -= x", "**a.lamports.borrow_mut() -= amount;"],
    ["**a.lamports.borrow_mut() += x", "**a.lamports.borrow_mut() += amount;"],
    ["**a.try_borrow_mut_lamports()? -= x", "**a.try_borrow_mut_lamports()? -= amount;"],
    ["**a.try_borrow_mut_lamports()? += x", "**a.try_borrow_mut_lamports()? += amount;"],
    ["a.lamports() - x", "let left = a.lamports() - fee;"],
    ["a.lamports() + x", "let total = a.lamports() + 1;"],
    ["*a.lamports.borrow_mut() -= x", "*a.lamports.borrow_mut() -= amount;"],
    ["ctx field .lamports.borrow_mut() -= x", "**ctx.accounts.vault.lamports.borrow_mut() -= amount;"],
  ])("flags %s", (_label, stmt) => {
    const fs = of(`fn f(a: &AccountInfo, amount: u64) {\n    ${stmt}\n}`, "QP007");
    expect(fs.map((f) => [f.severity, f.line])).toEqual([["medium", 2]]);
  });

  it("emits one finding per line, even with several matches on it", () => {
    const src = "fn f(a: &AccountInfo, b: &AccountInfo) {\n  **a.lamports.borrow_mut() -= 1; **b.lamports.borrow_mut() += 1;\n  **b.lamports.borrow_mut() += 2;\n}";
    expect(of(src, "QP007").map((f) => f.line)).toEqual([2, 3]);
  });

  it("a comment that mentions checked_sub does not hide the issue", () => {
    expect(of("fn f(a: &AccountInfo) {\n  **a.lamports.borrow_mut() -= 1; // TODO checked_sub\n}", "QP007")).toHaveLength(1);
  });

  it.each([
    ["checked_sub", "let v = a.lamports().checked_sub(amount).ok_or(E::Low)?;"],
    ["checked_add", "let v = a.lamports().checked_add(amount).ok_or(E::Overflow)?;"],
    ["plain assignment of a checked value", "**a.try_borrow_mut_lamports()? = v;"],
    ["multiplication", "let fee = a.lamports() * 2;"],
    ["saturating_sub", "let v = a.lamports().saturating_sub(amount);"],
    ["lamports in a comment", "// **a.lamports.borrow_mut() -= amount;"],
    ["checked math on the same line", "**a.lamports.borrow_mut() -= x.checked_sub(1).unwrap();"],
  ])("is quiet for %s", (_label, stmt) => {
    expect(of(`fn f(a: &AccountInfo, amount: u64) {\n    ${stmt}\n}`, "QP007")).toHaveLength(0);
  });

  it.fails("KNOWN BUG rust.ts:470 flags **x.to_account_info().try_borrow_mut_lamports()? -= amount (common Anchor form)", () => {
    const src = "fn f(ctx: Context<W>, amount: u64) {\n    **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;\n}";
    expect(sev(src, "QP007")).toEqual(["medium"]);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-rule behaviour                                                */
/* ------------------------------------------------------------------ */

describe("scanRust cross-rule behaviour", () => {
  it("every finding carries title and severity metadata from RULES (or a documented override)", () => {
    const src = native(`let it = &mut accounts.iter();\nlet admin = next_account_info(it)?;\nlet s = admin.try_borrow_data()?;\nlet k = Pubkey::create_program_address(&[&[data[0]]], program_id)?;\n**admin.lamports.borrow_mut() -= 1;\nverify_winternitz(&data[1..]);\nuse ed25519_dalek;`);
    const fs = scanRust(src);
    expect(fs.length).toBeGreaterThan(4);
    for (const f of fs) {
      expect(f.title).toBe(RULES[f.ruleId].title);
      expect(["critical", "high", "medium", "low", "info"]).toContain(f.severity);
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.fix.length).toBeGreaterThan(10);
      expect(f.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("snippets come from the original text, comments included", () => {
    const src = "fn f(data: &[u8]) { let t = data[0]; } // keep me";
    expect(of(src, "QP005")[0].snippet).toBe(src);
  });

  it("line numbers survive multi-line block comments above the issue", () => {
    const src = "/*\n one\n two\n*/\nfn f(data: &[u8]) {\n  let t = data[0];\n}";
    expect(of(src, "QP005")[0].line).toBe(6);
  });

  it("handles CRLF line endings", () => {
    const src = "fn f(data: &[u8]) {\r\n  let t = data[0];\r\n}";
    const [f] = of(src, "QP005");
    expect(f.line).toBe(2);
    expect(f.snippet).toBe("let t = data[0];");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "  \n\t\n"],
    ["binary noise", "\u0000\u0001\u0002￿"],
    ["unbalanced braces", "fn f( { { { [ [ ("],
    ["unterminated block comment", "fn f() { /* never closed"],
    ["unterminated string", 'fn f() { let s = "abc'],
    ["regex metacharacters in names", "fn f() { let a$b = next_account_info(it)?; let (x, y.z) = 1; }"],
    ["JSON that is not an IDL", '{"name":"x"}'],
  ])("does not throw on %s input", (_label, src) => {
    expect(() => scanRust(src)).not.toThrow();
  });

  it("does not mutate the input between calls (stable output)", () => {
    const src = native("let bump = data[40];\nlet k = Pubkey::create_program_address(&[b\"a\", &[bump]], program_id)?;");
    expect(scanRust(src)).toEqual(scanRust(src));
  });
});
