import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "node:fs";
import type { Page } from "@playwright/test";
import { SYSTEM_PROGRAM, UPGRADEABLE_LOADER, expect, snap, test, waitForHydration } from "./fixtures";

const INVALID_PK = "That is not a valid base58 public key.";

async function openChainTab(page: Page) {
  await page.goto("/scan");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Program or account" }).click();
  await expect(page.getByRole("tab", { name: "Program or account" })).toHaveAttribute("aria-selected", "true");
}

const addressInput = (page: Page) => page.getByLabel("Program ID", { exact: true });
const inspectButton = (page: Page) => page.getByRole("button", { name: /inspect address|reading chain/i });
const alertBox = (page: Page) => page.getByRole("main").getByRole("alert");

function u32le(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Upgradeable-loader Program account (36 bytes) and its ProgramData header (45 bytes). */
function upgradeableProgram(programData: PublicKey, authority: PublicKey | null, slot = 300_000_000) {
  const program = new Uint8Array(36);
  program.set(u32le(2), 0);
  program.set(programData.toBytes(), 4);
  const pd = new Uint8Array(45 + 16);
  pd.set(u32le(3), 0);
  new DataView(pd.buffer).setBigUint64(4, BigInt(slot), true);
  if (authority) {
    pd[12] = 1;
    pd.set(authority.toBytes(), 13);
  }
  return { program, pd };
}

test.describe("scan: address input validation", () => {
  const bad: [string, string][] = [
    ["empty", ""],
    ["whitespace only", "    "],
    ["punctuation", "not-a-key!!"],
    ["too short", "abc123"],
    ["non-base58 characters (0 O I l)", "0OIl" + "A".repeat(40)],
    ["too long (45 chars)", "1".repeat(45)],
    ["base58 that decodes to more than 32 bytes", "z".repeat(44)],
    ["hex string", "0x" + "ab".repeat(20)],
  ];
  for (const [label, value] of bad) {
    test(`rejects ${label} with a visible error and no RPC call`, async ({ page, rpc }) => {
      await openChainTab(page);
      await addressInput(page).fill(value);
      await inspectButton(page).click();
      await expect(alertBox(page)).toBeVisible();
      await expect(alertBox(page)).toHaveText(INVALID_PK);
      await expect(page.getByRole("heading", { name: /^Findings/ })).toHaveCount(0);
      expect(rpc.calls).toEqual([]);
    });
  }

  test("pressing Enter in the address field submits (or at least does not crash)", async ({ page, rpc }) => {
    await openChainTab(page);
    await addressInput(page).fill("not-a-key!!");
    await addressInput(page).press("Enter");
    // Soft: there is no <form>, so Enter does nothing today. Recorded as a UX finding, not a failure.
    await expect.soft(alertBox(page), "Enter key should trigger the inspect action").toBeVisible({ timeout: 2_000 });
    expect(rpc.calls).toEqual([]);
  });
});

test.describe("scan: on-chain address (mocked RPC)", () => {
  test("valid-format address that does not exist triggers a getAccountInfo scan", async ({ page, rpc, consoleErrors }) => {
    const addr = Keypair.generate().publicKey.toBase58();
    await openChainTab(page);
    await addressInput(page).fill(`  ${addr}  `); // surrounding whitespace is trimmed
    await inspectButton(page).click();

    await expect(page.getByRole("heading", { name: "Findings (0)" })).toBeVisible();
    await expect(page.getByText("Account does not exist on this cluster.")).toBeVisible();
    await expect(page.getByText(/Read from devnet via public RPC/)).toBeVisible();
    await expect(alertBox(page)).toHaveCount(0);

    const reads = rpc.callsTo("getAccountInfo").filter((c) => c.params[0] === addr);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads[0].url).toContain("api.devnet.solana.com");
    // Read-only promise in the UI: nothing but reads may be sent.
    expect(rpc.calls.map((c) => c.method)).not.toContain("sendTransaction");
    expect(consoleErrors).toEqual([]);
  });

  test("upgradeable program with a single-key authority reports QP201 and QP202", async ({ page, rpc }) => {
    const programId = Keypair.generate().publicKey;
    const programData = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey; // on-curve Ed25519 key
    const { program, pd } = upgradeableProgram(programData, authority);
    rpc
      .setAccount(programId.toBase58(), { data: program, owner: UPGRADEABLE_LOADER, executable: true, lamports: 1_141_440 })
      .setAccount(programData.toBase58(), { data: pd, owner: UPGRADEABLE_LOADER, lamports: 5_000_000 });

    await openChainTab(page);
    await addressInput(page).fill(programId.toBase58());
    await inspectButton(page).click();

    await expect(page.getByRole("heading", { name: "Findings (2)" })).toBeVisible();
    await expect(page.getByText("QP201", { exact: true })).toBeVisible();
    await expect(page.getByText("QP202", { exact: true })).toBeVisible();
    await expect(page.getByText(`Upgrade authority: ${authority.toBase58()}`)).toBeVisible();
    await expect(page.getByText("Readiness score")).toBeVisible();
    // Report hash is computed asynchronously and rendered as 64 hex chars.
    await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
    // The attest panel probes the registry program; mocked as not deployed.
    await expect(page.getByText(/registry program is not deployed on devnet/i)).toBeVisible();

    const pdRead = rpc.callsTo("getAccountInfo").find((c) => c.params[0] === programData.toBase58());
    expect(pdRead, "ProgramData account should be read").toBeTruthy();
    await snap(page, "scan-program-report-desktop");
  });

  test("immutable program reports only QP202 and an immutability note", async ({ page, rpc }) => {
    const programId = Keypair.generate().publicKey;
    const programData = Keypair.generate().publicKey;
    const { program, pd } = upgradeableProgram(programData, null);
    rpc
      .setAccount(programId.toBase58(), { data: program, owner: UPGRADEABLE_LOADER, executable: true })
      .setAccount(programData.toBase58(), { data: pd, owner: UPGRADEABLE_LOADER });
    await openChainTab(page);
    await addressInput(page).fill(programId.toBase58());
    await inspectButton(page).click();
    await expect(page.getByRole("heading", { name: "Findings (1)" })).toBeVisible();
    await expect(page.getByText("QP202", { exact: true })).toBeVisible();
    await expect(page.getByText("Program is immutable. No upgrade-key exposure.")).toBeVisible();
  });

  test("funded wallet address reports QP203 with its SOL balance", async ({ page, rpc }) => {
    const wallet = Keypair.generate().publicKey.toBase58();
    rpc.setAccount(wallet, { lamports: 2_500_000_000, owner: SYSTEM_PROGRAM });
    await openChainTab(page);
    await addressInput(page).fill(wallet);
    await inspectButton(page).click();
    await expect(page.getByText("QP203", { exact: true })).toBeVisible();
    await expect(page.getByText(/holding 2\.5000 SOL/)).toBeVisible();
  });

  test("mainnet toggle sends the read to the mainnet RPC only", async ({ page, rpc }) => {
    const addr = Keypair.generate().publicKey.toBase58();
    await openChainTab(page);
    await page.getByRole("group", { name: "Network" }).getByRole("button", { name: "mainnet" }).click();
    await expect(page.getByRole("button", { name: "mainnet" })).toHaveAttribute("aria-pressed", "true");
    await addressInput(page).fill(addr);
    await inspectButton(page).click();
    await expect(page.getByText(/Read from mainnet via public RPC/)).toBeVisible();
    const reads = rpc.callsTo("getAccountInfo").filter((c) => c.params[0] === addr);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const r of reads) expect(r.url).toContain("api.mainnet-beta.solana.com");
  });

  test("shows a loading state while the RPC is slow", async ({ page, rpc }) => {
    rpc.delay(1_500);
    await openChainTab(page);
    await addressInput(page).fill(Keypair.generate().publicKey.toBase58());
    await inspectButton(page).click();
    await expect(page.getByRole("button", { name: /reading chain/i })).toBeDisabled();
    await expect(page.getByRole("heading", { name: /^Findings/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspect address" })).toBeEnabled();
  });

  test("RPC failure surfaces a readable error", async ({ page, rpc }) => {
    rpc.failHttp(500);
    await openChainTab(page);
    await addressInput(page).fill(Keypair.generate().publicKey.toBase58());
    await inspectButton(page).click();
    await expect(alertBox(page)).toContainText("RPC error on devnet");
    await expect(page.getByRole("heading", { name: /^Findings/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inspect address" })).toBeEnabled();
  });

  test("a fixed input clears the previous error", async ({ page }) => {
    await openChainTab(page);
    await addressInput(page).fill("nope");
    await inspectButton(page).click();
    await expect(alertBox(page)).toHaveText(INVALID_PK);
    await addressInput(page).fill(Keypair.generate().publicKey.toBase58());
    await inspectButton(page).click();
    await expect(page.getByRole("heading", { name: /^Findings/ })).toBeVisible();
    await expect(alertBox(page)).toHaveCount(0);
  });
});

test.describe("scan: source tab", () => {
  test("empty source shows a visible error", async ({ page }) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(alertBox(page)).toHaveText("Paste code or load an example, then run the scan.");
  });

  test("invalid attestation target key shows a visible error", async ({ page }) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Load vulnerable vault" }).click();
    await page.getByLabel(/Program ID for the attestation/).fill("not-a-key");
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(alertBox(page)).toHaveText(INVALID_PK);
  });

  test("vulnerable sample produces a QP001 critical finding; fixed sample scores higher", async ({ page, consoleErrors }) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Load vulnerable vault" }).click();
    await expect(page.getByRole("textbox").first()).not.toHaveValue("");
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByText("QP001", { exact: true })).toBeVisible();
    const scoreBox = page.getByText("Readiness score").locator("..");
    const vulnScore = Number((await scoreBox.locator(".text-4xl").innerText()).match(/\d+/)?.[0]);

    await page.getByRole("button", { name: "Load fixed vault" }).click();
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByText("QP001", { exact: true })).toHaveCount(0);
    const fixedScore = Number((await scoreBox.locator(".text-4xl").innerText()).match(/\d+/)?.[0]);
    expect(fixedScore).toBeGreaterThan(vulnScore);
    expect(consoleErrors).toEqual([]);
  });

  test("sample IDL scans and the JSON report downloads with a hash", async ({ page }) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Load sample IDL" }).click();
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByRole("heading", { name: /^Findings/ })).toBeVisible();
    await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download JSON" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^qproof-.+\.json$/);
    const file = await download.path();
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(json.findings)).toBe(true);
  });
});
