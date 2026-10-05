"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "id";

const en = {
  nav: { scan: "Scanner", attestations: "Attestations", docs: "Docs", github: "GitHub", skip: "Skip to content", menu: "Menu" },
  hero: {
    eyebrow: "Solana devnet · open source",
    title: "Find the bugs that break one-time keys before an attacker does.",
    body:
      "qproof reads Solana program source, Anchor IDLs and on-chain metadata, flags patterns that undermine signature schemes, and writes a hash of the report to devnet so anyone can check it later.",
    ctaScan: "Scan a program",
    ctaDocs: "How it works",
    demoOpen: "Open this example in the scanner",
    demoCaption: "Live output of the bundled scanner on the vulnerable vault sample.",
  },
  story: {
    label: "Why this exists",
    title: "One byte of caller input let a one-time key sign twice.",
    body:
      "We were reviewing a hybrid vault that required both an Ed25519 signature and a Winternitz one-time signature for withdrawals. Each WOTS key had a PDA that recorded whether it had been used. The program built that PDA with create_program_address and a bump taken from instruction data. Pick a different valid bump, get a fresh record, and the same key signs again. Winternitz keys leak part of their secret with every signature, so a second signature is enough to start forging.",
    note: "qproof rule QP001 catches this pattern. The scanner ships with the vulnerable snippet so you can see it fire.",
  },
  features: {
    label: "What it checks",
    items: [
      { t: "Non-canonical bumps", d: "Bumps from instruction data, function parameters or Anchor `bump = arg` constraints reaching create_program_address." },
      { t: "Signer and owner checks", d: "Authority accounts used without is_signer, and account data read before the owner is verified." },
      { t: "One-time key reuse", d: "Winternitz, Lamport or XMSS verification without a reliable record that the key was spent." },
      { t: "Raw byte reads", d: "Slicing instruction or account data without a length check, and unchecked lamport math." },
      { t: "Quantum exposure", d: "Authorisation that rests only on Ed25519, including single-key upgrade authorities." },
      { t: "Verifiable reports", d: "A SHA-256 of each report is stored in a devnet PDA keyed by attester, target and hash." },
    ],
  },
  how: {
    label: "How it works",
    steps: [
      { t: "Scan", d: "Paste source, upload an IDL, or enter a program ID. Rules run in your browser. Nothing is uploaded." },
      { t: "Review", d: "Each finding has a line, a reason and a fix. The score starts at 100 and drops by severity." },
      { t: "Attest", d: "Sign one devnet transaction. The registry stores the score and the report hash at a PDA derived from your key, the target and the hash." },
      { t: "Verify", d: "Anyone with the report can recompute the hash and look up the record. No server in the middle." },
    ],
  },
  cta: { title: "Run it on your own program.", body: "Takes a few seconds. Works without a wallet until you want to attest.", button: "Open the scanner" },
  footer: { line: "Built for Solana developers. Devnet only. Not an audit.", rights: "MIT licensed" },
  scan: {
    title: "Scanner",
    sub: "Static checks for Solana programs. Runs locally in your browser.",
    tabSource: "Source or IDL",
    tabChain: "Program or account",
    placeholder: "Paste Rust source (native, Anchor or Pinocchio) or an Anchor IDL JSON…",
    upload: "Upload file",
    loadVuln: "Load vulnerable vault",
    loadFixed: "Load fixed vault",
    loadIdl: "Load sample IDL",
    run: "Run scan",
    targetLabel: "Program ID for the attestation (optional)",
    targetHelp: "Leave empty and the attestation is keyed by a hash of the source instead.",
    programId: "Program ID",
    inspect: "Inspect address",
    inspecting: "Reading chain…",
    empty: "Paste code or load an example, then run the scan.",
    noFindings: "No findings. That does not mean the program is safe, only that these rules did not match.",
    score: "Readiness score",
    findings: "Findings",
    fix: "Fix",
    line: "line",
    hash: "Report hash",
    notes: "Notes",
    download: "Download JSON",
    invalidPk: "That is not a valid base58 public key.",
    tabsLabel: "Input type",
    targetPlaceholder: "optional",
    addressPlaceholder: "Program ID or account address",
    network: "Network",
    mainnetNote: "Mainnet is read-only: public getAccountInfo queries, nothing is signed or sent.",
    examples: "Examples",
    exToken: "SPL Token program",
    exRegistry: "qproof registry",
    targetMeta: "target",
    fileError: "Could not read that file.",
    fileTooLarge: "File is too large. The limit is 2 MB.",
    fileLoaded: "Loaded",
  },
  attest: {
    title: "Record on devnet",
    body: "Stores the score and report hash in the qproof registry. Costs a little devnet SOL for rent.",
    button: "Sign attestation",
    sending: "Waiting for wallet…",
    done: "Attestation recorded",
    exists: "This exact report is already attested.",
    connect: "Connect a wallet to attest",
    notDeployed: "The registry program is not deployed on devnet yet, so attestations are disabled. See the README for status.",
    devnetHint: "Make sure your wallet is set to devnet and holds a little devnet SOL.",
    viewRecord: "View in attestations",
  },
  list: {
    title: "Attestations",
    sub: "Every report recorded in the qproof registry on Solana devnet, read live from the chain.",
    refresh: "Refresh",
    loading: "Loading from devnet…",
    none: "No attestations yet.",
    verifyTitle: "Verify a report",
    verifyBody: "Enter the target and report hash. qproof looks up the registry records for that exact report.",
    target: "Target (program ID or source key)",
    hash: "Report hash (hex)",
    verify: "Verify",
    found: "Attestation found",
    notFound: "No attestation at this address.",
    program: "Registry program",
    status: "Status",
    live: "Deployed on devnet",
    offline: "Not deployed yet",
    colTarget: "Target",
    colScore: "Score",
    colFindings: "C / H / M / L",
    colAttester: "Attester",
    colWhen: "Recorded",
    colHash: "Report hash",
    colAction: "Action",
    attester: "Attester (optional)",
    verifyHint: "Leave the attester empty to list every record of this report, whoever signed it.",
    badHash: "Report hash must be 64 hex characters.",
    score: "score",
    slot: "slot",
    by: "by",
    you: "you",
    revoke: "Revoke",
    revoking: "Revoking…",
    revoked: "Record closed. The rent went back to your wallet.",
  },
  notFound: { title: "Page not found", body: "There is nothing at this address.", back: "Back to home" },
};

type Dict = typeof en;

const id: Dict = {
  nav: { scan: "Pemindai", attestations: "Atestasi", docs: "Dokumentasi", github: "GitHub", skip: "Langsung ke konten", menu: "Menu" },
  hero: {
    eyebrow: "Solana devnet · sumber terbuka",
    title: "Temukan bug yang merusak kunci sekali pakai sebelum penyerang menemukannya.",
    body:
      "qproof membaca source program Solana, IDL Anchor, dan metadata on-chain, menandai pola yang melemahkan skema tanda tangan, lalu menulis hash laporan ke devnet agar siapa pun bisa memeriksanya.",
    ctaScan: "Pindai program",
    ctaDocs: "Cara kerjanya",
    demoOpen: "Buka contoh ini di pemindai",
    demoCaption: "Hasil asli pemindai pada contoh vault yang rentan.",
  },
  story: {
    label: "Latar belakang",
    title: "Satu byte input dari pemanggil membuat kunci sekali pakai bisa menandatangani dua kali.",
    body:
      "Kami sedang meninjau vault hibrida yang mewajibkan tanda tangan Ed25519 dan tanda tangan sekali pakai Winternitz untuk penarikan. Setiap kunci WOTS punya PDA yang mencatat apakah kunci itu sudah dipakai. Program membangun PDA tersebut dengan create_program_address dan bump yang diambil dari data instruksi. Pilih bump valid yang lain, dapat catatan baru, dan kunci yang sama bisa menandatangani lagi. Kunci Winternitz membocorkan sebagian rahasianya di setiap tanda tangan, jadi tanda tangan kedua sudah cukup untuk mulai memalsukan.",
    note: "Aturan QP001 di qproof mendeteksi pola ini. Pemindai menyertakan potongan kode yang rentan agar Anda bisa melihatnya bekerja.",
  },
  features: {
    label: "Yang diperiksa",
    items: [
      { t: "Bump non-kanonik", d: "Bump dari data instruksi, parameter fungsi, atau constraint Anchor `bump = arg` yang masuk ke create_program_address." },
      { t: "Cek signer dan owner", d: "Akun otoritas dipakai tanpa is_signer, dan data akun dibaca sebelum owner diverifikasi." },
      { t: "Pemakaian ulang kunci sekali pakai", d: "Verifikasi Winternitz, Lamport, atau XMSS tanpa catatan yang andal bahwa kunci sudah terpakai." },
      { t: "Pembacaan byte mentah", d: "Slicing data instruksi atau akun tanpa cek panjang, serta aritmetika lamport tanpa checked." },
      { t: "Paparan kuantum", d: "Otorisasi yang hanya bergantung pada Ed25519, termasuk upgrade authority satu kunci." },
      { t: "Laporan yang bisa diverifikasi", d: "SHA-256 setiap laporan disimpan di PDA devnet berdasarkan pengatestasi, target, dan hash." },
    ],
  },
  how: {
    label: "Cara kerja",
    steps: [
      { t: "Pindai", d: "Tempel source, unggah IDL, atau masukkan program ID. Aturan berjalan di browser Anda. Tidak ada yang diunggah." },
      { t: "Tinjau", d: "Setiap temuan punya baris, alasan, dan perbaikan. Skor mulai dari 100 dan turun sesuai tingkat keparahan." },
      { t: "Atestasi", d: "Tanda tangani satu transaksi devnet. Registry menyimpan skor dan hash laporan di PDA yang diturunkan dari kunci Anda, target, dan hash." },
      { t: "Verifikasi", d: "Siapa pun yang memegang laporan bisa menghitung ulang hash dan mencari catatannya. Tanpa server perantara." },
    ],
  },
  cta: { title: "Coba pada program Anda sendiri.", body: "Hanya beberapa detik. Tidak perlu wallet sampai Anda ingin membuat atestasi.", button: "Buka pemindai" },
  footer: { line: "Dibuat untuk developer Solana. Hanya devnet. Bukan audit.", rights: "Lisensi MIT" },
  scan: {
    title: "Pemindai",
    sub: "Pemeriksaan statis untuk program Solana. Berjalan lokal di browser Anda.",
    tabSource: "Source atau IDL",
    tabChain: "Program atau akun",
    placeholder: "Tempel source Rust (native, Anchor, atau Pinocchio) atau JSON IDL Anchor…",
    upload: "Unggah file",
    loadVuln: "Muat vault rentan",
    loadFixed: "Muat vault yang sudah diperbaiki",
    loadIdl: "Muat contoh IDL",
    run: "Jalankan pemindaian",
    targetLabel: "Program ID untuk atestasi (opsional)",
    targetHelp: "Jika dikosongkan, atestasi memakai hash dari source sebagai kunci.",
    programId: "Program ID",
    inspect: "Periksa alamat",
    inspecting: "Membaca chain…",
    empty: "Tempel kode atau muat contoh, lalu jalankan pemindaian.",
    noFindings: "Tidak ada temuan. Ini bukan berarti program aman, hanya saja aturan ini tidak cocok.",
    score: "Skor kesiapan",
    findings: "Temuan",
    fix: "Perbaikan",
    line: "baris",
    hash: "Hash laporan",
    notes: "Catatan",
    download: "Unduh JSON",
    invalidPk: "Itu bukan public key base58 yang valid.",
    tabsLabel: "Jenis input",
    targetPlaceholder: "opsional",
    addressPlaceholder: "Program ID atau alamat akun",
    network: "Jaringan",
    mainnetNote: "Mainnet hanya dibaca: kueri publik getAccountInfo, tidak ada yang ditandatangani atau dikirim.",
    examples: "Contoh",
    exToken: "Program SPL Token",
    exRegistry: "Registry qproof",
    targetMeta: "target",
    fileError: "File tidak bisa dibaca.",
    fileTooLarge: "File terlalu besar. Batasnya 2 MB.",
    fileLoaded: "Dimuat",
  },
  attest: {
    title: "Catat di devnet",
    body: "Menyimpan skor dan hash laporan di registry qproof. Butuh sedikit SOL devnet untuk rent.",
    button: "Tanda tangani atestasi",
    sending: "Menunggu wallet…",
    done: "Atestasi tercatat",
    exists: "Laporan yang sama persis sudah diatestasi.",
    connect: "Hubungkan wallet untuk atestasi",
    notDeployed: "Program registry belum ter-deploy di devnet, jadi atestasi dinonaktifkan. Lihat README untuk statusnya.",
    devnetHint: "Pastikan wallet Anda di jaringan devnet dan punya sedikit SOL devnet.",
    viewRecord: "Lihat di halaman atestasi",
  },
  list: {
    title: "Atestasi",
    sub: "Semua laporan yang tercatat di registry qproof di Solana devnet, dibaca langsung dari chain.",
    refresh: "Muat ulang",
    loading: "Memuat dari devnet…",
    none: "Belum ada atestasi.",
    verifyTitle: "Verifikasi laporan",
    verifyBody: "Masukkan target dan hash laporan. qproof mencari catatan registry untuk laporan tersebut.",
    target: "Target (program ID atau kunci source)",
    hash: "Hash laporan (hex)",
    verify: "Verifikasi",
    found: "Atestasi ditemukan",
    notFound: "Tidak ada atestasi di alamat ini.",
    program: "Program registry",
    status: "Status",
    live: "Sudah di devnet",
    offline: "Belum ter-deploy",
    colTarget: "Target",
    colScore: "Skor",
    colFindings: "K / T / S / R",
    colAttester: "Pengatestasi",
    colWhen: "Waktu",
    colHash: "Hash laporan",
    colAction: "Aksi",
    attester: "Pengatestasi (opsional)",
    verifyHint: "Kosongkan pengatestasi untuk menampilkan semua catatan laporan ini, siapa pun penandatangannya.",
    badHash: "Hash laporan harus 64 karakter hex.",
    score: "skor",
    slot: "slot",
    by: "oleh",
    you: "Anda",
    revoke: "Cabut",
    revoking: "Mencabut…",
    revoked: "Catatan ditutup. Rent dikembalikan ke wallet Anda.",
  },
  notFound: { title: "Halaman tidak ditemukan", body: "Tidak ada apa pun di alamat ini.", back: "Kembali ke beranda" },
};

const dicts: Record<Lang, Dict> = { en, id };

const Ctx = createContext<{ lang: Lang; t: Dict; setLang: (l: Lang) => void }>({
  lang: "en",
  t: en,
  setLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("qproof-lang");
      if (saved === "en" || saved === "id") setLangState(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("qproof-lang", l);
    } catch {}
  };
  return <Ctx.Provider value={{ lang, t: dicts[lang], setLang }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
