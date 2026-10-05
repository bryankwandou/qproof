// Example inputs for the scanner. The vulnerable vault is a reduced version of
// the hybrid Ed25519 + Winternitz vault bug that motivated qproof.

export const VULNERABLE_VAULT = `use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// Hybrid vault: a withdrawal needs an Ed25519 signature from the owner
// AND a Winternitz one-time signature. Each WOTS key may sign once.
pub fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let wots_record = next_account_info(iter)?;

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let wots_pubkey_hash: [u8; 32] = data[8..40].try_into().unwrap();
    let bump = data[40];

    // BUG: bump comes straight from instruction data.
    let expected = Pubkey::create_program_address(
        &[b"wots", wots_pubkey_hash.as_ref(), &[bump]],
        program_id,
    )?;
    if expected != *wots_record.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let record = wots_record.try_borrow_data()?;
    if record[0] == 1 {
        return Err(ProgramError::Custom(1)); // key already used
    }
    drop(record);

    verify_winternitz(&data[40..], &wots_pubkey_hash)?;
    wots_record.try_borrow_mut_data()?[0] = 1;

    **vault.lamports.borrow_mut() -= amount;
    **owner.lamports.borrow_mut() += amount;
    Ok(())
}
`;

export const FIXED_VAULT = `use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

pub fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 40 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let wots_record = next_account_info(iter)?;

    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if wots_record.owner != program_id || vault.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let wots_pubkey_hash: [u8; 32] = data[8..40].try_into().unwrap();

    // Canonical bump only: one WOTS key maps to exactly one record.
    let (expected, _bump) = Pubkey::find_program_address(
        &[b"wots", wots_pubkey_hash.as_ref()],
        program_id,
    );
    if expected != *wots_record.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let used = wots_record.try_borrow_data()?[0] == 1;
    if used {
        return Err(ProgramError::Custom(1));
    }

    verify_winternitz(&data[40..], &wots_pubkey_hash)?;
    wots_record.try_borrow_mut_data()?[0] = 1;

    let v = vault.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
    let o = owner.lamports().checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
    **vault.try_borrow_mut_lamports()? = v;
    **owner.try_borrow_mut_lamports()? = o;
    Ok(())
}
`;

export const SAMPLE_IDL = `{
  "name": "simple_vault",
  "version": "0.1.0",
  "instructions": [
    {
      "name": "initialize",
      "accounts": [
        { "name": "vault", "isMut": true, "isSigner": false },
        { "name": "authority", "isMut": true, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [{ "name": "bump", "type": "u8" }]
    },
    {
      "name": "setAuthority",
      "accounts": [
        { "name": "vault", "isMut": true, "isSigner": false },
        { "name": "authority", "isMut": false, "isSigner": false }
      ],
      "args": [{ "name": "newAuthority", "type": "publicKey" }]
    }
  ]
}`;
