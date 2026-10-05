//! qproof attestation registry.
//!
//! Instruction data starts with a one-byte tag.
//!
//! `0` Attest (70 bytes): tag | target(32) | report_hash(32) | score(1) | counts(4)
//!     accounts: attester (signer, writable), record (writable), system program
//!     Creates the record at PDA ["attest", attester, target, report_hash].
//!
//! `1` Revoke (1 byte): tag
//!     accounts: attester (signer, writable), record (writable)
//!     Closes a record. Only the attester stored in the record can do this; the
//!     rent goes back to them and the account is handed back to the system
//!     program with no data, so it cannot be revived.
//!
//! The bump is always derived on-chain with `find_program_address`; the program
//! never accepts a caller-supplied bump (the exact bug class the scanner flags
//! as QP001). The attester is part of the seeds, so nobody can squat or
//! front-run someone else's record for the same target and report hash.
//!
//! Record layout (128 bytes):
//!   "QPATTEST" | version | bump | score | critical | high | medium | low | pad
//!   attester(32) | target(32) | hash(32) | unix_ts(i64 LE) | slot(u64 LE)

// system_instruction / system_program are deprecated re-exports in solana-program 2.x
// but are the same code; kept to avoid pulling a second Pubkey type into the program.
#[allow(deprecated)]
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

pub const SEED: &[u8] = b"attest";
pub const DISCRIMINATOR: [u8; 8] = *b"QPATTEST";
pub const VERSION: u8 = 1;
pub const ACCOUNT_SIZE: usize = 128;

pub const IX_ATTEST: u8 = 0;
pub const IX_REVOKE: u8 = 1;
/// tag(1) + target(32) + hash(32) + score(1) + counts(4)
pub const IX_LEN: usize = 70;
/// tag(1)
pub const REVOKE_IX_LEN: usize = 1;
pub const MAX_SCORE: u8 = 100;

/// Custom error codes (surface as `InstructionError::Custom(code)`).
pub const ERR_UNAUTHORIZED: u32 = 0x5150_0001;
pub const ERR_NOT_WRITABLE: u32 = 0x5150_0002;

// Field offsets inside a record.
const OFF_VERSION: usize = 8;
const OFF_BUMP: usize = 9;
const OFF_SCORE: usize = 10;
const OFF_COUNTS: usize = 11;
const OFF_PAD: usize = 15;
const OFF_ATTESTER: usize = 16;
const OFF_TARGET: usize = 48;
const OFF_HASH: usize = 80;
const OFF_TS: usize = 112;
const OFF_SLOT: usize = 120;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Canonical record address for (attester, target, report hash).
pub fn record_address(program_id: &Pubkey, attester: &Pubkey, target: &[u8; 32], hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED, attester.as_ref(), target, hash], program_id)
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(&IX_ATTEST) => attest(program_id, accounts, data),
        Some(&IX_REVOKE) => revoke(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn require_writable(a: &AccountInfo) -> ProgramResult {
    if a.is_writable {
        Ok(())
    } else {
        Err(ProgramError::Custom(ERR_NOT_WRITABLE))
    }
}

fn attest(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != IX_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let target: [u8; 32] = data[1..33].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let hash: [u8; 32] = data[33..65].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let score = data[65];
    if score > MAX_SCORE {
        return Err(ProgramError::InvalidInstructionData);
    }
    let counts = &data[66..70];

    let iter = &mut accounts.iter();
    let attester = next_account_info(iter)?;
    let record = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    if !attester.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    require_writable(attester)?;
    require_writable(record)?;
    if *system.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (expected, bump) = record_address(program_id, attester.key, &target, &hash);
    if *record.key != expected {
        return Err(ProgramError::InvalidSeeds);
    }
    // Reinitialization guard: an existing record is never overwritten.
    if record.owner == program_id {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    if *record.owner != system_program::ID || !record.data_is_empty() {
        return Err(ProgramError::IllegalOwner);
    }

    let required = Rent::get()?.minimum_balance(ACCOUNT_SIZE);
    let signer_seeds: &[&[u8]] = &[SEED, attester.key.as_ref(), &target, &hash, &[bump]];
    if record.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(attester.key, record.key, required, ACCOUNT_SIZE as u64, program_id),
            &[attester.clone(), record.clone(), system.clone()],
            &[signer_seeds],
        )?;
    } else {
        // Someone sent lamports to the (predictable) address first. create_account
        // would fail on a funded account, so top up, allocate and assign instead.
        let top_up = required.saturating_sub(record.lamports());
        if top_up > 0 {
            invoke(
                &system_instruction::transfer(attester.key, record.key, top_up),
                &[attester.clone(), record.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(record.key, ACCOUNT_SIZE as u64),
            &[record.clone(), system.clone()],
            &[signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(record.key, program_id),
            &[record.clone(), system.clone()],
            &[signer_seeds],
        )?;
    }

    let clock = Clock::get()?;
    let mut d = record.try_borrow_mut_data()?;
    if d.len() != ACCOUNT_SIZE {
        return Err(ProgramError::InvalidAccountData);
    }
    d[0..8].copy_from_slice(&DISCRIMINATOR);
    d[OFF_VERSION] = VERSION;
    d[OFF_BUMP] = bump;
    d[OFF_SCORE] = score;
    d[OFF_COUNTS..OFF_COUNTS + 4].copy_from_slice(counts); // critical, high, medium, low
    d[OFF_PAD] = 0;
    d[OFF_ATTESTER..OFF_ATTESTER + 32].copy_from_slice(attester.key.as_ref());
    d[OFF_TARGET..OFF_TARGET + 32].copy_from_slice(&target);
    d[OFF_HASH..OFF_HASH + 32].copy_from_slice(&hash);
    d[OFF_TS..OFF_TS + 8].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
    d[OFF_SLOT..OFF_SLOT + 8].copy_from_slice(&clock.slot.to_le_bytes());
    msg!("qproof: attested score {}", score);
    Ok(())
}

fn revoke(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != REVOKE_IX_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let attester = next_account_info(iter)?;
    let record = next_account_info(iter)?;

    if !attester.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    require_writable(attester)?;
    require_writable(record)?;
    if attester.key == record.key {
        return Err(ProgramError::InvalidArgument);
    }
    if record.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    {
        let d = record.try_borrow_data()?;
        if d.len() != ACCOUNT_SIZE || d[0..8] != DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if d[OFF_ATTESTER..OFF_ATTESTER + 32] != *attester.key.as_ref() {
            return Err(ProgramError::Custom(ERR_UNAUTHORIZED));
        }
        // Defense in depth: the record must sit at the canonical PDA for its own
        // contents (only this program can create owned accounts, but check anyway).
        let target: [u8; 32] = d[OFF_TARGET..OFF_TARGET + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        let hash: [u8; 32] = d[OFF_HASH..OFF_HASH + 32].try_into().map_err(|_| ProgramError::InvalidAccountData)?;
        let (expected, bump) = record_address(program_id, attester.key, &target, &hash);
        if *record.key != expected || d[OFF_BUMP] != bump {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    // Close: move every lamport to the attester, wipe the data, give the account
    // back to the system program.
    let refund = record.lamports();
    let new_balance = attester.lamports().checked_add(refund).ok_or(ProgramError::ArithmeticOverflow)?;
    **attester.try_borrow_mut_lamports()? = new_balance;
    **record.try_borrow_mut_lamports()? = 0;
    record.try_borrow_mut_data()?.fill(0);
    record.resize(0)?;
    record.assign(&system_program::ID);
    msg!("qproof: revoked, refunded {} lamports", refund);
    Ok(())
}
