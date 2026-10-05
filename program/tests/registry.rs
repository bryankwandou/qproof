//! Runs the compiled registry program (target/deploy/qproof_registry.so) inside
//! LiteSVM, i.e. the real SBF loader, system program, rent and clock sysvars and
//! CPI privilege checks. Build first with `cargo build-sbf`, then `cargo test`.
//!
//! Only primitive constants are imported from the crate; all key / instruction
//! types come from the LiteSVM-side solana crates.

use std::{
    path::PathBuf,
    str::FromStr,
    sync::OnceLock,
};

use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use qproof_registry::{
    ACCOUNT_SIZE, DISCRIMINATOR, ERR_NOT_WRITABLE, ERR_UNAUTHORIZED, IX_ATTEST, IX_LEN, IX_REVOKE, SEED, VERSION,
};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

/// Devnet program id (qproof/.devnet-keys/program.json, referenced by src/lib/chain.ts).
const PROGRAM_ID: &str = "81k7uatyydQboYd5oSDzjE7xzNfnwu53FnzocoGbrUsT";
const SYSTEM: Address = solana_system_interface::program::ID;
const SOL: u64 = 1_000_000_000;

type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

// ----------------------------------------------------------------- harness

fn program_bytes() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let so = dir.join("target").join("deploy").join("qproof_registry.so");
        let so_meta = std::fs::metadata(&so)
            .unwrap_or_else(|_| panic!("{} missing: run `cargo build-sbf` in program/ first", so.display()));
        // Refuse to test a stale binary: the .so must be newer than the source.
        let src_time = std::fs::metadata(dir.join("src").join("lib.rs")).unwrap().modified().unwrap();
        assert!(
            so_meta.modified().unwrap() >= src_time,
            "{} is older than src/lib.rs: run `cargo build-sbf` again",
            so.display()
        );
        std::fs::read(&so).unwrap()
    })
}

struct Env {
    svm: LiteSVM,
    pid: Address,
    payer: Keypair,
}

fn env() -> Env {
    let pid = Address::from_str(PROGRAM_ID).unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(pid, program_bytes()).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
    Env { svm, pid, payer }
}

impl Env {
    fn funded(&mut self, lamports: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), lamports).unwrap();
        k
    }

    fn rent(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE)
    }

    fn pda(&self, attester: &Address, target: &[u8; 32], hash: &[u8; 32]) -> (Address, u8) {
        Address::find_program_address(&[SEED, attester.as_ref(), target, hash], &self.pid)
    }

    /// Sends `ixs` with `fee_payer` paying and `signers` signing (fee payer included automatically).
    fn send(&mut self, ixs: &[Instruction], fee_payer: &Keypair, extra: &[&Keypair]) -> TxResult {
        let mut signers: Vec<&Keypair> = vec![fee_payer];
        for s in extra {
            if s.pubkey() != fee_payer.pubkey() {
                signers.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(ixs, Some(&fee_payer.pubkey()), &signers, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        // A fresh blockhash per tx so identical retries are not deduplicated.
        self.svm.expire_blockhash();
        res
    }

    /// Payer attests for itself; returns the record address.
    fn attest_ok(&mut self, who: &Keypair, target: &[u8; 32], hash: &[u8; 32], score: u8) -> Address {
        let (pda, _) = self.pda(&who.pubkey(), target, hash);
        let ix = attest_ix(&self.pid, &who.pubkey(), &pda, target, hash, score, [1, 2, 3, 4]);
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &payer, &[who]).expect("attest should succeed");
        pda
    }

    fn account(&self, a: &Address) -> Option<Account> {
        self.svm.get_account(a).filter(|acc| acc.lamports > 0)
    }

    fn balance(&self, a: &Address) -> u64 {
        self.svm.get_balance(a).unwrap_or(0)
    }

    /// Writes an arbitrary account (used to forge hostile states).
    fn put(&mut self, at: Address, owner: Address, lamports: u64, data: Vec<u8>) {
        self.svm
            .set_account(at, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }
}

fn target() -> [u8; 32] {
    Keypair::new().pubkey().to_bytes()
}

fn attest_data(target: &[u8; 32], hash: &[u8; 32], score: u8, counts: [u8; 4]) -> Vec<u8> {
    let mut d = Vec::with_capacity(IX_LEN);
    d.push(IX_ATTEST);
    d.extend_from_slice(target);
    d.extend_from_slice(hash);
    d.push(score);
    d.extend_from_slice(&counts);
    assert_eq!(d.len(), IX_LEN);
    d
}

fn attest_ix(
    pid: &Address,
    attester: &Address,
    record: &Address,
    target: &[u8; 32],
    hash: &[u8; 32],
    score: u8,
    counts: [u8; 4],
) -> Instruction {
    Instruction {
        program_id: *pid,
        accounts: vec![
            AccountMeta::new(*attester, true),
            AccountMeta::new(*record, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: attest_data(target, hash, score, counts),
    }
}

fn revoke_ix(pid: &Address, attester: &Address, record: &Address) -> Instruction {
    Instruction {
        program_id: *pid,
        accounts: vec![AccountMeta::new(*attester, true), AccountMeta::new(*record, false)],
        data: vec![IX_REVOKE],
    }
}

fn transfer_ix(from: &Address, to: &Address, lamports: u64) -> Instruction {
    solana_system_interface::instruction::transfer(from, to, lamports)
}

/// Builds the exact bytes the program writes, for forging accounts in tests.
fn record_bytes(bump: u8, score: u8, attester: &Address, target: &[u8; 32], hash: &[u8; 32]) -> Vec<u8> {
    let mut d = vec![0u8; ACCOUNT_SIZE];
    d[0..8].copy_from_slice(&DISCRIMINATOR);
    d[8] = VERSION;
    d[9] = bump;
    d[10] = score;
    d[16..48].copy_from_slice(attester.as_ref());
    d[48..80].copy_from_slice(target);
    d[80..112].copy_from_slice(hash);
    d
}

#[track_caller]
fn expect_err(res: TxResult, ix_index: u8, want: InstructionError) {
    match res {
        Ok(meta) => panic!("expected {want:?}, transaction succeeded. logs: {:#?}", meta.logs),
        Err(f) => assert_eq!(
            f.err,
            TransactionError::InstructionError(ix_index, want.clone()),
            "logs: {:#?}",
            f.meta.logs
        ),
    }
}

/// What the runtime reports for ProgramError::NotEnoughAccountKeys (variant is
/// deprecated in newer SDKs in favour of MissingAccount, but still what a
/// solana-program 2.x binary produces).
#[allow(deprecated)]
const NOT_ENOUGH_KEYS: InstructionError = InstructionError::NotEnoughAccountKeys;

fn custom(code: u32) -> InstructionError {
    InstructionError::Custom(code)
}

// ================================================================== Attest

#[test]
fn attest_happy_path_writes_every_field_at_canonical_pda() {
    let mut e = env();
    let mut clock: Clock = e.svm.get_sysvar();
    clock.slot = 4242;
    clock.unix_timestamp = 1_750_000_000;
    e.svm.set_sysvar(&clock);

    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [7u8; 32];
    let (pda, bump) = e.pda(&attester.pubkey(), &t, &h);
    let before = e.balance(&attester.pubkey());
    let ix = attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 55, [1, 2, 3, 4]);
    let meta = e.send(&[ix], &attester, &[]).expect("attest");
    println!("attest CU: {}", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 40_000, "CU {}", meta.compute_units_consumed);

    let acc = e.account(&pda).expect("record exists");
    assert_eq!(acc.owner, e.pid);
    assert_eq!(acc.lamports, e.rent(), "exactly rent-exempt");
    assert!(!acc.executable);
    let d = &acc.data;
    assert_eq!(d.len(), ACCOUNT_SIZE);
    assert_eq!(&d[0..8], &DISCRIMINATOR);
    assert_eq!(d[8], VERSION);
    assert_eq!(d[9], bump, "canonical bump stored");
    assert_eq!(d[10], 55);
    assert_eq!(&d[11..15], &[1, 2, 3, 4]);
    assert_eq!(d[15], 0);
    assert_eq!(&d[16..48], attester.pubkey().as_ref());
    assert_eq!(&d[48..80], &t);
    assert_eq!(&d[80..112], &h);
    assert_eq!(i64::from_le_bytes(d[112..120].try_into().unwrap()), 1_750_000_000);
    assert_eq!(u64::from_le_bytes(d[120..128].try_into().unwrap()), 4242);
    // attester paid rent + fee and nothing else
    assert_eq!(before - e.balance(&attester.pubkey()), e.rent() + meta.fee);
}

#[test]
fn attest_score_bounds_and_full_count_range_accepted() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    for (i, s) in [0u8, 1, 99, 100].into_iter().enumerate() {
        let t = target();
        let h = [i as u8 + 1; 32];
        let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
        let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, s, [255, 0, 255, 7]);
        e.send(&[ix], &payer, &[]).expect("score in range");
        let d = e.account(&pda).unwrap().data;
        assert_eq!(d[10], s);
        assert_eq!(&d[11..15], &[255, 0, 255, 7]);
    }
}

#[test]
fn attest_rejects_score_above_100() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    for s in [101u8, 150, 255] {
        let t = target();
        let h = [9u8; 32];
        let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
        let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, s, [0; 4]);
        expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidInstructionData);
        assert!(e.account(&pda).is_none());
    }
}

#[test]
fn attest_rejects_oversized_instruction_data() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [1u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    for extra in [1usize, 58, 900] {
        let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
        ix.data.extend(std::iter::repeat(0xAB).take(extra));
        expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidInstructionData);
    }
    assert!(e.account(&pda).is_none());
}

#[test]
fn attest_rejects_truncated_and_empty_instruction_data() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [2u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    for len in [0usize, 1, 33, 65, 69] {
        let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
        ix.data.truncate(len);
        expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidInstructionData);
    }
    assert!(e.account(&pda).is_none());
}

#[test]
fn rejects_unknown_instruction_tags() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [3u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    for tag in [2u8, 3, 0x7f, 0xff] {
        let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
        ix.data[0] = tag;
        expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidInstructionData);
    }
    assert!(e.account(&pda).is_none());
}

#[test]
fn attest_rejects_attester_that_did_not_sign() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let victim = e.funded(10 * SOL);
    let t = target();
    let h = [4u8; 32];
    let (pda, _) = e.pda(&victim.pubkey(), &t, &h);
    let mut ix = attest_ix(&e.pid, &victim.pubkey(), &pda, &t, &h, 100, [0; 4]);
    ix.accounts[0].is_signer = false;
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::MissingRequiredSignature);
    assert!(e.account(&pda).is_none());
    assert_eq!(e.balance(&victim.pubkey()), 10 * SOL, "victim not charged");
}

#[test]
fn attest_signer_cannot_write_into_another_attesters_pda() {
    // The signer is a real signer, but the record address belongs to someone else.
    let mut e = env();
    let attacker = e.funded(10 * SOL);
    let victim = e.funded(10 * SOL);
    let t = target();
    let h = [5u8; 32];
    let (victim_pda, _) = e.pda(&victim.pubkey(), &t, &h);
    let ix = attest_ix(&e.pid, &attacker.pubkey(), &victim_pda, &t, &h, 100, [0; 4]);
    expect_err(e.send(&[ix], &attacker, &[]), 0, InstructionError::InvalidSeeds);
    assert!(e.account(&victim_pda).is_none());
}

#[test]
fn attest_rejects_duplicate_and_keeps_original_record() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [6u8; 32];
    let pda = e.attest_ok(&payer, &t, &h, 90);
    let original = e.account(&pda).unwrap();

    let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 10, [9, 9, 9, 9]);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::AccountAlreadyInitialized);
    assert_eq!(e.account(&pda).unwrap(), original, "record untouched by the retry");
}

#[test]
fn attest_duplicate_inside_one_transaction_rolls_back_everything() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [7u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let a = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 80, [0; 4]);
    let b = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 20, [0; 4]);
    expect_err(e.send(&[a, b], &payer, &[]), 1, InstructionError::AccountAlreadyInitialized);
    assert!(e.account(&pda).is_none(), "atomic: first attest rolled back");
}

#[test]
fn attest_front_runner_cannot_squat_another_attesters_record() {
    // Before the fix the PDA was ["attest", target, hash], so whoever landed first
    // owned the (target, hash) slot and everybody else got AccountAlreadyInitialized.
    let mut e = env();
    let attacker = e.funded(10 * SOL);
    let honest = e.funded(10 * SOL);
    let t = target();
    let h = [8u8; 32];
    let attacker_pda = e.attest_ok(&attacker, &t, &h, 100);
    let honest_pda = e.attest_ok(&honest, &t, &h, 40);
    assert_ne!(attacker_pda, honest_pda);
    let d = e.account(&honest_pda).unwrap().data;
    assert_eq!(d[10], 40);
    assert_eq!(&d[16..48], honest.pubkey().as_ref());
    let d = e.account(&attacker_pda).unwrap().data;
    assert_eq!(&d[16..48], attacker.pubkey().as_ref());
}

#[test]
fn attest_succeeds_when_record_address_was_prefunded_below_rent() {
    // Anyone can send lamports to the predictable PDA. That used to block
    // create_account forever (AccountAlreadyInitialized / "already in use").
    let mut e = env();
    let griefer = e.funded(SOL);
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [9u8; 32];
    let (pda, bump) = e.pda(&attester.pubkey(), &t, &h);
    // The cheapest legal grief: the rent-exempt minimum for an empty account
    // (a smaller amount would leave a rent-paying account, which the runtime refuses).
    let gift = e.svm.minimum_balance_for_rent_exemption(0);
    assert!(gift < e.rent());
    e.send(&[transfer_ix(&griefer.pubkey(), &pda, gift)], &griefer, &[]).unwrap();
    assert_eq!(e.balance(&pda), gift);

    let before = e.balance(&attester.pubkey());
    let ix = attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 70, [0, 1, 0, 1]);
    let meta = e.send(&[ix], &attester, &[]).expect("prefunded address still attestable");
    let acc = e.account(&pda).unwrap();
    assert_eq!(acc.owner, e.pid);
    assert_eq!(acc.lamports, e.rent(), "topped up to exactly rent-exempt");
    assert_eq!(acc.data.len(), ACCOUNT_SIZE);
    assert_eq!(acc.data[9], bump);
    assert_eq!(acc.data[10], 70);
    assert_eq!(before - e.balance(&attester.pubkey()), e.rent() - gift + meta.fee);
}

#[test]
fn attest_succeeds_when_record_address_was_prefunded_above_rent() {
    let mut e = env();
    let griefer = e.funded(SOL);
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [10u8; 32];
    let (pda, _) = e.pda(&attester.pubkey(), &t, &h);
    let gift = e.rent() + 12_345;
    e.send(&[transfer_ix(&griefer.pubkey(), &pda, gift)], &griefer, &[]).unwrap();

    let before = e.balance(&attester.pubkey());
    let ix = attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 33, [0; 4]);
    let meta = e.send(&[ix], &attester, &[]).expect("over-funded address still attestable");
    let acc = e.account(&pda).unwrap();
    assert_eq!(acc.owner, e.pid);
    assert_eq!(acc.lamports, gift, "no top-up needed");
    assert_eq!(acc.data[10], 33);
    assert_eq!(before - e.balance(&attester.pubkey()), meta.fee, "attester paid only the fee");
}

#[test]
fn attest_rejects_non_canonical_bump_address() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [11u8; 32];
    let (_, canon) = e.pda(&payer.pubkey(), &t, &h);
    let alt = (0..canon)
        .rev()
        .find_map(|b| Address::create_program_address(&[SEED, payer.pubkey().as_ref(), &t, &h, &[b]], &e.pid).ok())
        .expect("some lower bump is also off-curve");
    let ix = attest_ix(&e.pid, &payer.pubkey(), &alt, &t, &h, 50, [0; 4]);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidSeeds);
    assert!(e.account(&alt).is_none());
}

#[test]
fn attest_rejects_wrong_seed_pdas_and_random_addresses() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [12u8; 32];
    let other_program = Keypair::new().pubkey();
    let candidates = [
        // legacy scheme without the attester
        Address::find_program_address(&[SEED, &t, &h], &e.pid).0,
        // target and hash swapped
        Address::find_program_address(&[SEED, payer.pubkey().as_ref(), &h, &t], &e.pid).0,
        // wrong prefix
        Address::find_program_address(&[b"attestx", payer.pubkey().as_ref(), &t, &h], &e.pid).0,
        // right seeds, different program
        Address::find_program_address(&[SEED, payer.pubkey().as_ref(), &t, &h], &other_program).0,
        // plain keypair address
        Keypair::new().pubkey(),
        // the attester itself
        payer.pubkey(),
    ];
    for bad in candidates {
        let ix = attest_ix(&e.pid, &payer.pubkey(), &bad, &t, &h, 50, [0; 4]);
        expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::InvalidSeeds);
    }
}

#[test]
fn attest_rejects_record_owned_by_another_program() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [13u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let foreign = Keypair::new().pubkey();
    let rent = e.rent();
    e.put(pda, foreign, rent, vec![]);
    let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::IllegalOwner);
    assert_eq!(e.account(&pda).unwrap().owner, foreign);
}

#[test]
fn attest_rejects_system_owned_record_that_already_has_data() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [14u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let rent = e.rent();
    e.put(pda, SYSTEM, rent, vec![1u8; ACCOUNT_SIZE]);
    let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::IllegalOwner);
}

#[test]
fn attest_rejects_forged_program_owned_record_reinit() {
    // Even an account already owned by the program (any content) is never rewritten.
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [15u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let pid = e.pid;
    let rent = e.rent();
    e.put(pda, pid, rent, vec![0u8; ACCOUNT_SIZE]);
    let ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::AccountAlreadyInitialized);
    assert_eq!(e.account(&pda).unwrap().data, vec![0u8; ACCOUNT_SIZE]);
}

#[test]
fn attest_rejects_fake_system_program() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [16u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
    ix.accounts[2] = AccountMeta::new_readonly(Keypair::new().pubkey(), false);
    expect_err(e.send(&[ix.clone()], &payer, &[]), 0, InstructionError::IncorrectProgramId);
    // the registry itself in the system slot
    ix.accounts[2] = AccountMeta::new_readonly(e.pid, false);
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::IncorrectProgramId);
    assert!(e.account(&pda).is_none());
}

#[test]
fn attest_rejects_readonly_record() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [17u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
    ix.accounts[1].is_writable = false;
    expect_err(e.send(&[ix], &payer, &[]), 0, custom(ERR_NOT_WRITABLE));
    assert!(e.account(&pda).is_none());
}

#[test]
fn attest_rejects_readonly_attester() {
    // A separate fee payer lets the attester sign as a read-only signer.
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [18u8; 32];
    let (pda, _) = e.pda(&attester.pubkey(), &t, &h);
    let mut ix = attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 50, [0; 4]);
    ix.accounts[0].is_writable = false;
    expect_err(e.send(&[ix], &payer, &[&attester]), 0, custom(ERR_NOT_WRITABLE));
    assert!(e.account(&pda).is_none());
}

#[test]
fn attest_rejects_missing_accounts() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [19u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    for keep in [0usize, 1, 2] {
        let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 50, [0; 4]);
        ix.accounts.truncate(keep);
        expect_err(e.send(&[ix], &payer, &[]), 0, NOT_ENOUGH_KEYS);
    }
}

#[test]
fn attest_fails_cleanly_when_attester_cannot_pay_rent() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let broke = e.funded(1_000_000); // rent-exempt as a wallet, but below rent for a 128-byte record
    let t = target();
    let h = [20u8; 32];
    let (pda, _) = e.pda(&broke.pubkey(), &t, &h);
    let ix = attest_ix(&e.pid, &broke.pubkey(), &pda, &t, &h, 50, [0; 4]);
    // system program: SystemError::ResultWithNegativeLamports = Custom(1)
    expect_err(e.send(&[ix], &payer, &[&broke]), 0, custom(1));
    assert!(e.account(&pda).is_none());
    assert_eq!(e.balance(&broke.pubkey()), 1_000_000);
}

#[test]
fn attest_ignores_trailing_accounts() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let t = target();
    let h = [21u8; 32];
    let (pda, _) = e.pda(&payer.pubkey(), &t, &h);
    let mut ix = attest_ix(&e.pid, &payer.pubkey(), &pda, &t, &h, 61, [0; 4]);
    ix.accounts.push(AccountMeta::new(Keypair::new().pubkey(), false));
    e.send(&[ix], &payer, &[]).expect("extra accounts are harmless");
    assert_eq!(e.account(&pda).unwrap().data[10], 61);
}

// ================================================================== Revoke

#[test]
fn revoke_happy_path_closes_record_and_refunds_attester() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [30u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    let rent = e.account(&pda).unwrap().lamports;

    let before = e.balance(&attester.pubkey());
    let meta = e.send(&[revoke_ix(&e.pid, &attester.pubkey(), &pda)], &attester, &[]).expect("revoke");
    println!("revoke CU: {}", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 20_000, "CU {}", meta.compute_units_consumed);
    assert!(e.account(&pda).is_none(), "record closed");
    assert_eq!(e.balance(&attester.pubkey()), before + rent - meta.fee, "full rent refunded");
}

#[test]
fn revoke_by_non_authority_is_rejected() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let thief = e.funded(10 * SOL);
    let t = target();
    let h = [31u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    let snapshot = e.account(&pda).unwrap();

    let ix = revoke_ix(&e.pid, &thief.pubkey(), &pda);
    expect_err(e.send(&[ix], &thief, &[]), 0, custom(ERR_UNAUTHORIZED));
    assert_eq!(e.account(&pda).unwrap(), snapshot, "record and lamports intact");
}

#[test]
fn revoke_requires_attester_signature() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [32u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    let mut ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    ix.accounts[0].is_signer = false;
    expect_err(e.send(&[ix], &payer, &[]), 0, InstructionError::MissingRequiredSignature);
    assert!(e.account(&pda).is_some());
}

#[test]
fn revoke_rejects_lookalike_record_owned_by_another_program() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [33u8; 32];
    let (pda, bump) = e.pda(&attester.pubkey(), &t, &h);
    let foreign = Keypair::new().pubkey();
    let rent = e.rent();
    e.put(pda, foreign, rent, record_bytes(bump, 50, &attester.pubkey(), &t, &h));
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::IllegalOwner);
    assert_eq!(e.account(&pda).unwrap().lamports, rent);
}

#[test]
fn revoke_rejects_system_owned_accounts() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let wallet = e.funded(5 * SOL);
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &wallet.pubkey());
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::IllegalOwner);
    assert_eq!(e.balance(&wallet.pubkey()), 5 * SOL);
}

#[test]
fn revoke_rejects_program_owned_account_with_bad_discriminator_or_size() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [34u8; 32];
    let (pda, bump) = e.pda(&attester.pubkey(), &t, &h);
    let pid = e.pid;
    let rent = e.rent();

    let mut bad_disc = record_bytes(bump, 50, &attester.pubkey(), &t, &h);
    bad_disc[0] ^= 0xff;
    let mut short = record_bytes(bump, 50, &attester.pubkey(), &t, &h);
    short.truncate(ACCOUNT_SIZE - 1);
    let mut long = record_bytes(bump, 50, &attester.pubkey(), &t, &h);
    long.push(0);
    for data in [bad_disc, short, long, vec![]] {
        e.put(pda, pid, rent, data);
        let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
        expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::InvalidAccountData);
        assert_eq!(e.account(&pda).unwrap().lamports, rent);
    }
}

#[test]
fn revoke_rejects_forged_record_away_from_its_pda() {
    // Program-owned account with a valid layout naming the signer, but at an
    // address that is not the canonical PDA for its contents.
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [35u8; 32];
    let (_, bump) = e.pda(&attester.pubkey(), &t, &h);
    let fake = Keypair::new().pubkey();
    let pid = e.pid;
    e.put(fake, pid, 5 * SOL, record_bytes(bump, 50, &attester.pubkey(), &t, &h));
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &fake);
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::InvalidSeeds);
    assert_eq!(e.balance(&fake), 5 * SOL);
}

#[test]
fn revoke_rejects_record_with_non_canonical_stored_bump() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [36u8; 32];
    let (pda, bump) = e.pda(&attester.pubkey(), &t, &h);
    let pid = e.pid;
    let rent = e.rent();
    e.put(pda, pid, rent, record_bytes(bump.wrapping_sub(1), 50, &attester.pubkey(), &t, &h));
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::InvalidSeeds);
}

#[test]
fn revoke_rejects_wrong_instruction_length() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [37u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    for extra in [1usize, 69, 500] {
        let mut ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
        ix.data.extend(std::iter::repeat(0u8).take(extra));
        expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::InvalidInstructionData);
    }
    assert!(e.account(&pda).is_some());
}

#[test]
fn revoke_twice_fails_the_second_time() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [38u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    e.send(&[revoke_ix(&e.pid, &attester.pubkey(), &pda)], &attester, &[]).unwrap();
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::IllegalOwner);
}

#[test]
fn revoke_twice_in_one_transaction_fails_atomically() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [39u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    expect_err(e.send(&[ix.clone(), ix], &attester, &[]), 1, InstructionError::IllegalOwner);
    assert!(e.account(&pda).is_some(), "first revoke rolled back");
}

#[test]
fn revoked_record_cannot_be_revived_by_refunding_it() {
    // Classic closed-account revival: send lamports back in the same tx.
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [40u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    let refill = e.rent();
    let ixs = [revoke_ix(&e.pid, &attester.pubkey(), &pda), transfer_ix(&attester.pubkey(), &pda, refill)];
    e.send(&ixs, &attester, &[]).expect("revoke + refill");
    let acc = e.account(&pda).expect("refilled lamports keep the address alive");
    assert_eq!(acc.owner, SYSTEM, "no longer owned by the registry");
    assert!(acc.data.is_empty(), "no stale record data");
    // it is not a record any more...
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::IllegalOwner);
    // ...but the attester can attest fresh (prefunded path).
    let ix = attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 12, [0; 4]);
    e.send(&[ix], &attester, &[]).expect("re-attest over refilled address");
    assert_eq!(e.account(&pda).unwrap().data[10], 12);
}

#[test]
fn revoke_then_reattest_records_new_score() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [41u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    // revoke and re-attest atomically in one transaction
    let ixs = [
        revoke_ix(&e.pid, &attester.pubkey(), &pda),
        attest_ix(&e.pid, &attester.pubkey(), &pda, &t, &h, 88, [4, 3, 2, 1]),
    ];
    e.send(&ixs, &attester, &[]).expect("revoke + re-attest");
    let acc = e.account(&pda).unwrap();
    assert_eq!(acc.owner, e.pid);
    assert_eq!(acc.lamports, e.rent());
    assert_eq!(acc.data[10], 88);
    assert_eq!(&acc.data[11..15], &[4, 3, 2, 1]);
}

#[test]
fn revoke_only_affects_the_callers_own_record() {
    let mut e = env();
    let a = e.funded(10 * SOL);
    let b = e.funded(10 * SOL);
    let t = target();
    let h = [42u8; 32];
    let pda_a = e.attest_ok(&a, &t, &h, 10);
    let pda_b = e.attest_ok(&b, &t, &h, 20);
    let snap_b = e.account(&pda_b).unwrap();
    // a cannot close b's record...
    expect_err(e.send(&[revoke_ix(&e.pid, &a.pubkey(), &pda_b)], &a, &[]), 0, custom(ERR_UNAUTHORIZED));
    // ...and closing its own leaves b's alone
    e.send(&[revoke_ix(&e.pid, &a.pubkey(), &pda_a)], &a, &[]).unwrap();
    assert!(e.account(&pda_a).is_none());
    assert_eq!(e.account(&pda_b).unwrap(), snap_b);
}

#[test]
fn revoke_rejects_readonly_accounts() {
    let mut e = env();
    let payer = e.payer.insecure_clone();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [43u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);

    let mut ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    ix.accounts[1].is_writable = false;
    expect_err(e.send(&[ix], &attester, &[]), 0, custom(ERR_NOT_WRITABLE));

    let mut ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
    ix.accounts[0].is_writable = false;
    expect_err(e.send(&[ix], &payer, &[&attester]), 0, custom(ERR_NOT_WRITABLE));
    assert!(e.account(&pda).is_some());
}

#[test]
fn revoke_rejects_missing_accounts() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let t = target();
    let h = [44u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    for keep in [0usize, 1] {
        let mut ix = revoke_ix(&e.pid, &attester.pubkey(), &pda);
        ix.accounts.truncate(keep);
        expect_err(e.send(&[ix], &attester, &[]), 0, NOT_ENOUGH_KEYS);
    }
}

#[test]
fn revoke_rejects_attester_passed_as_record() {
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let ix = revoke_ix(&e.pid, &attester.pubkey(), &attester.pubkey());
    expect_err(e.send(&[ix], &attester, &[]), 0, InstructionError::InvalidArgument);
}

#[test]
fn revoke_refunds_any_extra_lamports_in_the_record() {
    // Lamports donated to a live record go back to the attester on close.
    let mut e = env();
    let attester = e.funded(10 * SOL);
    let donor = e.funded(SOL);
    let t = target();
    let h = [45u8; 32];
    let pda = e.attest_ok(&attester, &t, &h, 77);
    e.send(&[transfer_ix(&donor.pubkey(), &pda, 500_000)], &donor, &[]).unwrap();
    let held = e.account(&pda).unwrap().lamports;
    assert_eq!(held, e.rent() + 500_000);
    let before = e.balance(&attester.pubkey());
    let meta = e.send(&[revoke_ix(&e.pid, &attester.pubkey(), &pda)], &attester, &[]).unwrap();
    assert_eq!(e.balance(&attester.pubkey()), before + held - meta.fee);
    assert!(e.account(&pda).is_none());
}
