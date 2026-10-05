import type { Finding } from "./types";
import { RULES } from "./rules";

/** Replace comments with spaces so indexes and line numbers stay stable. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function lineText(src: string, line: number): string {
  return (src.split("\n")[line - 1] ?? "").trim();
}

/** Index of the matching closing bracket for the opener at `open`. */
function matchClose(src: string, open: number, o = "(", c = ")"): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

interface FnRange {
  name: string;
  start: number;
  sigEnd: number;
  end: number;
  signature: string;
  body: string;
}

export function functions(src: string): FnRange[] {
  const out: FnRange[] = [];
  const re = /\bfn\s+(\w+)\s*(<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const parenOpen = src.indexOf("(", m.index);
    const parenClose = matchClose(src, parenOpen);
    const braceOpen = src.indexOf("{", parenClose);
    const semi = src.indexOf(";", parenClose);
    if (braceOpen === -1 || (semi !== -1 && semi < braceOpen)) continue;
    const end = matchClose(src, braceOpen, "{", "}");
    out.push({
      name: m[1],
      start: m.index,
      sigEnd: braceOpen,
      end,
      signature: src.slice(m.index, braceOpen),
      body: src.slice(braceOpen, end + 1),
    });
  }
  return out;
}

function enclosing(fns: FnRange[], index: number): FnRange | undefined {
  let best: FnRange | undefined;
  for (const f of fns) {
    if (f.start <= index && index <= f.end) {
      if (!best || f.start > best.start) best = f;
    }
  }
  return best;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER_INPUT = /\b(data|instruction_data|ix_data|ix|args|params|input|payload|instruction)\b/;

function make(ruleId: string, src: string, index: number | undefined, message: string, fix: string, severity?: Finding["severity"]): Finding {
  const meta = RULES[ruleId];
  const line = index === undefined ? undefined : lineOf(src, index);
  return {
    ruleId,
    title: meta.title,
    severity: severity ?? meta.severity,
    line,
    snippet: line ? lineText(src, line) : undefined,
    message,
    fix,
  };
}

/* ------------------------------------------------------------------ */
/* QP001: non-canonical PDA bump                                       */
/* ------------------------------------------------------------------ */

type BumpOrigin = "canonical" | "user" | "stored" | "unknown";

function bumpOrigin(name: string, fn: FnRange | undefined, wholeSrc: string): BumpOrigin {
  const scope = fn ? fn.signature + fn.body : wholeSrc;
  const n = esc(name);
  // Expression itself reads from instruction input, e.g. args.bump or data[64]
  if (USER_INPUT.test(name) && !/\.bump$/.test(name.replace(USER_INPUT, ""))) {
    if (/^(data|instruction_data|ix_data|input|payload)\s*\[/.test(name)) return "user";
  }
  if (/^(args|params|ix|instruction|data|payload|input)\./.test(name)) return "user";
  if (/^(data|instruction_data|ix_data|input|payload)\s*\[/.test(name)) return "user";
  // Bound from find_program_address
  if (new RegExp(`\\(\\s*[\\w_]+\\s*,\\s*${n}\\s*\\)\\s*=\\s*[\\w:]*find_program_address`).test(scope)) return "canonical";
  // Compared against a canonical value
  if (new RegExp(`${n}\\s*[!=]=\\s*\\w*canonical|canonical\\w*\\s*[!=]=\\s*${n}`).test(scope)) return "canonical";
  if (/\./.test(name) && /\.bump$/.test(name)) return "stored";
  // let bump = <rhs>;
  const assign = new RegExp(`let\\s+(?:mut\\s+)?${n}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(scope);
  if (assign) {
    const rhs = assign[1];
    if (/find_program_address/.test(rhs)) return "canonical";
    if (USER_INPUT.test(rhs)) return "user";
    if (/\.bump\b/.test(rhs)) return "stored";
  }
  // Destructured from parsed instruction: let Foo { bump, .. } = ...
  if (new RegExp(`let\\s+\\w+\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=`).test(scope)) return "user";
  // Function parameter
  if (fn && new RegExp(`\\b${n}\\s*:\\s*u8\\b`).test(fn.signature)) return "user";
  return "unknown";
}

function ruleNonCanonicalBump(src: string, fns: FnRange[], out: Finding[]) {
  const re = /create_program_address\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf("(", m.index);
    const args = src.slice(open, matchClose(src, open) + 1);
    const fn = enclosing(fns, m.index);
    const scope = fn ? fn.body : src;
    const candidates = new Set<string>();
    for (const b of args.matchAll(/&\s*\[\s*([\w.]+(?:\[[^\]]*\])?)\s*\]/g)) candidates.add(b[1]);
    for (const b of args.matchAll(/\b([\w.]*bump\w*)\b/gi)) candidates.add(b[1]);
    // Seeds passed as a variable: look for its definition in scope
    const seedVar = /\(\s*&?\s*(\w+)\s*[,)]/.exec(args)?.[1];
    if (seedVar && candidates.size === 0) {
      const def = new RegExp(`let\\s+${esc(seedVar)}[^=]*=\\s*([^;]+);`).exec(scope)?.[1] ?? "";
      for (const b of def.matchAll(/&\s*\[\s*([\w.]+(?:\[[^\]]*\])?)\s*\]/g)) candidates.add(b[1]);
      for (const b of def.matchAll(/\b([\w.]*bump\w*)\b/gi)) candidates.add(b[1]);
    }
    let worst: BumpOrigin = candidates.size ? "canonical" : "unknown";
    let culprit = "";
    for (const c of candidates) {
      const o = bumpOrigin(c, fn, src);
      const rank = { canonical: 0, stored: 1, unknown: 2, user: 3 } as const;
      if (rank[o] >= rank[worst] && o !== "canonical") {
        worst = o;
        culprit = c;
      }
    }
    if (worst === "user") {
      out.push(
        make(
          "QP001",
          src,
          m.index,
          `create_program_address is called with bump \`${culprit}\`, which comes from caller input. Any of the up to 255 valid bumps produces a different PDA for the same seeds, so one logical record (a nonce, a "used" flag, a one-time key slot) can exist several times.`,
          "Derive the bump with Pubkey::find_program_address and use only that value, or store the canonical bump at init and compare: `if bump != canonical { return Err(InvalidSeeds) }`.",
        ),
      );
    } else if (worst === "unknown") {
      out.push(
        make(
          "QP001",
          src,
          m.index,
          "create_program_address is used and the bump origin could not be traced to find_program_address. If it can be influenced by the caller, the PDA is not unique.",
          "Trace the bump back to find_program_address or a stored canonical bump, and reject anything else.",
          "high",
        ),
      );
    } else if (worst === "stored") {
      out.push(
        make(
          "QP001",
          src,
          m.index,
          "The bump is read from account state. That is fine only if the value was produced by find_program_address when the account was initialised.",
          "Confirm the init path stores the canonical bump, not one supplied in instruction data.",
          "info",
        ),
      );
    }
  }

  // Anchor: #[account(seeds = [...], bump = <expr>)]
  const instructionAttr = /#\[instruction\(([^)]*)\)\]/g;
  const ixParams = new Set<string>();
  for (const a of src.matchAll(instructionAttr)) {
    for (const p of a[1].matchAll(/(\w+)\s*:/g)) ixParams.add(p[1]);
  }
  const bumpEq = /\bbump\s*=\s*([\w.\[\]]+)/g;
  while ((m = bumpEq.exec(src))) {
    const expr = m[1];
    // only inside #[account(...)] attributes, not `let bump = ...`
    const attrStart = src.lastIndexOf("#[account(", m.index);
    if (attrStart === -1 || matchClose(src, attrStart + 9) < m.index) continue;
    const userish = ixParams.has(expr) || /^(args|params|ix|data|instruction)\b/.test(expr);
    if (userish) {
      out.push(
        make(
          "QP001",
          src,
          m.index,
          `Anchor constraint uses \`bump = ${expr}\`, a value passed in the instruction. Anchor then calls create_program_address with it, so non-canonical bumps are accepted.`,
          "Use a bare `bump` (Anchor derives the canonical one) or `bump = account.bump` where account.bump was saved from ctx.bumps at init.",
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Account helpers                                                     */
/* ------------------------------------------------------------------ */

function nativeAccounts(src: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  for (const m of src.matchAll(/let\s+(\w+)\s*=\s*next_account_info\s*\(/g)) out.push({ name: m[1], index: m.index! });
  // let [a, b, c, ..] = accounts else / let [a, b] = accounts
  for (const m of src.matchAll(/let\s*\[([^\]]+)\]\s*=\s*accounts\b/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().replace(/^ref\s+/, "").replace(/^mut\s+/, "");
      if (/^\w+$/.test(name) && name !== "_") out.push({ name, index: m.index! });
    }
  }
  return out;
}

interface AnchorField {
  name: string;
  type: string;
  index: number;
  attrs: string;
  docs: string;
}

function anchorFields(src: string, original: string): AnchorField[] {
  const out: AnchorField[] = [];
  const re = /pub\s+(\w+)\s*:\s*((?:Box<)?\s*(?:Account|AccountInfo|UncheckedAccount|Signer|Program|SystemAccount|AccountLoader|InterfaceAccount|Interface|Sysvar)\b[^,\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    const lastField = Math.max(before.lastIndexOf("info>,"), before.lastIndexOf("{"), before.lastIndexOf(">,"));
    const attrs = before.slice(lastField + 1);
    const docsBefore = original.slice(Math.max(0, m.index - 600), m.index);
    const lf = Math.max(docsBefore.lastIndexOf(">,"), docsBefore.lastIndexOf("{"));
    out.push({ name: m[1], type: m[2], index: m.index, attrs, docs: docsBefore.slice(lf + 1) });
  }
  return out;
}

const AUTHORITY = /^(authority|admin|owner|signer|withdrawer|attester|operator|manager|governor|upgrade_authority|user_authority|vault_authority|.*_authority|.*_admin|.*_owner)$/i;

/* ------------------------------------------------------------------ */
/* QP002: missing signer check                                         */
/* ------------------------------------------------------------------ */

function ruleMissingSigner(src: string, original: string, out: Finding[]) {
  for (const a of nativeAccounts(src)) {
    if (!AUTHORITY.test(a.name) && !/^(payer|user|funder)$/.test(a.name)) continue;
    const n = esc(a.name);
    const checked = new RegExp(`${n}\\s*\\.\\s*(is_signer\\b|is_signer\\(\\))`).test(src);
    if (!checked) {
      out.push(
        make(
          "QP002",
          src,
          a.index,
          `Account \`${a.name}\` looks like an authority but no \`${a.name}.is_signer\` check was found. Anyone can pass that public key without its signature.`,
          `Add \`if !${a.name}.is_signer { return Err(ProgramError::MissingRequiredSignature); }\` before acting on its authority.`,
          AUTHORITY.test(a.name) ? "high" : "medium",
        ),
      );
    }
  }
  for (const f of anchorFields(src, original)) {
    if (!AUTHORITY.test(f.name)) continue;
    if (/^(?:Box<)?\s*(AccountInfo|UncheckedAccount)\b/.test(f.type) && !/\bsigner\b/.test(f.attrs)) {
      out.push(
        make(
          "QP002",
          src,
          f.index,
          `\`${f.name}\` is declared as ${f.type.split("<")[0].trim()} with no signer constraint, so Anchor will not require its signature.`,
          `Declare it as \`Signer<'info>\` or add \`#[account(signer)]\`, and tie it to state with \`has_one = ${f.name}\`.`,
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* QP003: missing owner check                                          */
/* ------------------------------------------------------------------ */

function ruleMissingOwner(src: string, original: string, out: Finding[]) {
  for (const a of nativeAccounts(src)) {
    const n = esc(a.name);
    const readRe = new RegExp(`\\b${n}\\s*\\.\\s*(try_borrow_data|try_borrow_mut_data|data\\s*\\.\\s*borrow|data\\s*\\.\\s*borrow_mut|borrow_data_unchecked|borrow_mut_data_unchecked|try_borrow|try_borrow_mut)\\b`);
    const read = readRe.exec(src);
    if (!read) continue;
    const ownerChecked =
      new RegExp(`\\b${n}\\s*\\.\\s*(owner\\b|owner\\(\\)|is_owned_by)`).test(src) ||
      new RegExp(`check_owner\\w*\\s*\\(\\s*&?\\s*${n}\\b`).test(src);
    // Accounts the program creates in the same instruction are owned by construction
    const created = new RegExp(`create_account\\s*\\([^;]*\\b${n}\\.(key|address)`).test(src);
    if (!ownerChecked && !created) {
      out.push(
        make(
          "QP003",
          src,
          read.index,
          `Data of \`${a.name}\` is read without verifying \`${a.name}.owner\`. An attacker can pass an account owned by another program with forged bytes in the expected layout.`,
          `Check \`${a.name}.owner == program_id\` (or the expected program) before deserialising.`,
        ),
      );
    }
  }
  for (const f of anchorFields(src, original)) {
    if (!/^(?:Box<)?\s*(AccountInfo|UncheckedAccount)\b/.test(f.type)) continue;
    const n = esc(f.name);
    const read = new RegExp(`\\b${n}\\s*\\.\\s*(try_borrow_data|data\\s*\\.\\s*borrow|try_borrow_mut_data)`).exec(src);
    if (read && !/\bowner\s*=/.test(f.attrs)) {
      out.push(
        make(
          "QP003",
          src,
          read.index,
          `\`${f.name}\` is an unchecked account and its data is read, but there is no \`owner = ...\` constraint.`,
          `Use \`Account<'info, T>\` so Anchor checks owner and discriminator, or add \`#[account(owner = expected_program)]\`.`,
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* QP004: one-time key reuse                                           */
/* ------------------------------------------------------------------ */

const OTS = /(?<![a-z0-9])(wots|winternitz|lamport_sig|one_time|onetime|ots_|xmss|hors|lms_)\w*/i;
const CONSUMED = /\b(used|is_used|consumed|spent|nullifier|nonce|sequence|counter|epoch|leaf_index|next_index)\b|close\s*=/i;

function ruleOneTimeKeyReuse(src: string, findings: Finding[], out: Finding[]) {
  const m = OTS.exec(src);
  if (!m) return;
  if (!CONSUMED.test(src)) {
    out.push(
      make(
        "QP004",
        src,
        m.index,
        "The program verifies a one-time signature scheme but nothing records that the key or leaf has been used. Signing two messages with the same Winternitz key leaks enough of the chain for forgeries.",
        "Store a per-key `used` flag or a monotonic leaf index in a uniquely derived PDA and reject a second use.",
      ),
    );
  }
  const userBump = findings.some((f) => f.ruleId === "QP001" && f.severity === "critical");
  if (userBump) {
    out.push(
      make(
        "QP004",
        src,
        m.index,
        "One-time signatures are combined with a caller-chosen PDA bump. The 'key used' record can be recreated at a different bump address, which lets the same one-time key sign twice.",
        "Derive the usage-record PDA with the canonical bump only. Treat this as a key-compromise issue: rotate any key that may have signed twice.",
        "critical",
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* QP005: unchecked account / instruction data reads                   */
/* ------------------------------------------------------------------ */

function ruleUncheckedReads(src: string, fns: FnRange[], out: Finding[]) {
  for (const fn of fns) {
    const body = fn.body;
    const slice = /\b(data|instruction_data|ix_data|input|buf|bytes|account_data|raw)\s*\[\s*(\w+\s*)?\.\.\s*(\w+\s*)?\]|\b(data|instruction_data|ix_data|input|buf|bytes|raw)\s*\[\s*\d+\s*\]/.exec(body);
    if (!slice) continue;
    const guarded = /\.len\(\)\s*(<|>|!=|==|>=|<=)|\.get\(\s*\d*\s*\.\.|\.get\(\s*\w+\s*\.\.|ensure_len|require!\s*\(\s*\w*\.len|split_at_checked|first_chunk|\.chunks_exact/.test(body);
    if (!guarded) {
      out.push(
        make(
          "QP005",
          src,
          fn.sigEnd + slice.index,
          `\`${fn.name}\` indexes raw bytes (\`${slice[0].replace(/\s+/g, "")}\`) without checking the length first. Short input panics the program; mis-sized account data may be read as a different layout.`,
          "Check `len()` up front and return InvalidInstructionData / InvalidAccountData, or use `.get(a..b)` and handle None.",
        ),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* QP006: classical-only signatures                                    */
/* ------------------------------------------------------------------ */

const CLASSICAL = /\b(ed25519|secp256k1|secp256r1|ed25519_program|ed25519_dalek|libsecp256k1|verify_strict|secp256k1_recover)\b/i;
const PQ = /(?<![a-z0-9])(wots|winternitz|sphincs|slh_dsa|slhdsa|ml_dsa|mldsa|dilithium|falcon|xmss|lms|lamport)\w*/i;

function ruleClassicalOnly(src: string, out: Finding[]) {
  const c = CLASSICAL.exec(src);
  if (c && !PQ.test(src)) {
    out.push(
      make(
        "QP006",
        src,
        c.index,
        "Signatures are verified with an elliptic-curve scheme only. A large quantum computer running Shor's algorithm can recover the private key from a public key, so anything gated purely by this check has no post-quantum fallback.",
        "Plan a hybrid path: keep Ed25519 for today and add a hash-based signature (WOTS+, SPHINCS+/SLH-DSA) for high-value authority actions such as vault withdrawals or upgrades.",
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* QP007: unchecked lamport arithmetic                                 */
/* ------------------------------------------------------------------ */

function ruleLamportMath(src: string, out: Finding[]) {
  const re = /(lamports\(\)\s*[-+]\s*\w|\.lamports\.borrow_mut\(\)\s*[-+]=|\*\*\s*\w+\.(try_borrow_mut_lamports\(\)\??|lamports\.borrow_mut\(\))\s*[-+]=)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = re.exec(src))) {
    const line = lineOf(src, m.index);
    if (seen.has(line)) continue;
    seen.add(line);
    const text = src.split("\n")[line - 1];
    if (/checked_(add|sub)/.test(text)) continue;
    out.push(
      make(
        "QP007",
        src,
        m.index,
        "Lamport balances are changed with plain + or -. With overflow checks off in release, this can wrap; with them on, it panics instead of returning a clear error.",
        "Use checked_add / checked_sub and map None to an explicit error.",
      ),
    );
  }
}

export function scanRust(original: string): Finding[] {
  const src = stripComments(original);
  const fns = functions(src);
  const out: Finding[] = [];
  ruleNonCanonicalBump(src, fns, out);
  ruleMissingSigner(src, original, out);
  ruleMissingOwner(src, original, out);
  ruleOneTimeKeyReuse(src, out, out);
  ruleUncheckedReads(src, fns, out);
  ruleClassicalOnly(src, out);
  ruleLamportMath(src, out);
  // snippets should show the original text, not the comment-stripped version
  for (const f of out) if (f.line) f.snippet = lineText(original, f.line);
  return out;
}
