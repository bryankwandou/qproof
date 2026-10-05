import { defineConfig, devices } from "@playwright/test";

// Dedicated port so the e2e dev server does not clash with a developer's `next dev` on 3000.
const PORT = Number(process.env.E2E_PORT ?? 3107);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  // Keep all generated artifacts under e2e/ (both folder names are gitignored).
  outputDir: "e2e/test-results",
  // Generous: on the dev machine `next dev` needs ~3 min to boot and 1-3 min per first route compile,
  // and src/ is edited concurrently, which triggers HMR recompiles mid-run.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // `next dev` compiles routes on demand; a few workers is faster than many on Windows.
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "e2e/playwright-report", open: "never" }],
    ["json", { outputFile: "e2e/test-results/results.json" }],
  ],
  use: {
    baseURL,
    locale: "en-US",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    navigationTimeout: 180_000,
    actionTimeout: 30_000,
  },
  projects: [
    // Hits every route once so `next dev` has compiled them before timed tests start.
    { name: "warmup", testMatch: /warmup\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      dependencies: ["warmup"],
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 900_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      // Pin RPC endpoints so .env files cannot point the suite at a live/private RPC.
      // Tests intercept every non-localhost JSON-RPC call anyway (see e2e/fixtures.ts).
      NEXT_PUBLIC_RPC_URL: "https://api.devnet.solana.com",
      NEXT_PUBLIC_MAINNET_RPC_URL: "https://api.mainnet-beta.solana.com",
    },
  },
});
