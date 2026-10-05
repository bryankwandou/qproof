import { test as base, expect, type Page, type Route } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared fixtures for the qproof e2e suite.
 *
 * - `rpc`: an in-memory Solana JSON-RPC mock. Every request that leaves localhost is
 *   intercepted; JSON-RPC POSTs are answered from the mock, anything else is aborted
 *   and recorded in `rpc.blocked`. No test depends on live devnet/mainnet.
 * - `consoleErrors`: console.error messages and uncaught page errors seen on the page.
 */

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export type RpcCall = { url: string; method: string; params: unknown[] };

export interface MockAccount {
  data?: Uint8Array;
  owner?: string;
  executable?: boolean;
  lamports?: number;
}

type Handler = (params: unknown[], call: RpcCall) => unknown;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

const SLOT = 123_456;
const ctx = (value: unknown) => ({ context: { slot: SLOT }, value });

function isLocal(url: URL) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

function encodeAccount(a: MockAccount, slice?: { offset: number; length: number }) {
  let data = a.data ?? new Uint8Array();
  if (slice) data = data.slice(slice.offset, slice.offset + slice.length);
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    executable: a.executable ?? false,
    lamports: a.lamports ?? 0,
    owner: a.owner ?? SYSTEM_PROGRAM,
    rentEpoch: 0,
    space: (a.data ?? new Uint8Array()).length,
  };
}

export class RpcMock {
  readonly calls: RpcCall[] = [];
  /** Non-RPC requests to non-local hosts that were aborted. */
  readonly blocked: string[] = [];
  private accounts = new Map<string, MockAccount>();
  private handlers = new Map<string, Handler>();
  private httpFailure: { status: number; body: string } | null = null;
  private delayMs = 0;

  constructor() {
    this.handlers.set("getAccountInfo", (params) => {
      const [addr, cfg] = params as [string, { dataSlice?: { offset: number; length: number } } | undefined];
      const acct = this.accounts.get(addr);
      return ctx(acct ? encodeAccount(acct, cfg?.dataSlice) : null);
    });
    this.handlers.set("getMultipleAccounts", (params) => {
      const [addrs] = params as [string[]];
      return ctx(addrs.map((a) => (this.accounts.has(a) ? encodeAccount(this.accounts.get(a)!) : null)));
    });
    this.handlers.set("getProgramAccounts", () => []);
    this.handlers.set("getBalance", (params) => ctx(this.accounts.get(params[0] as string)?.lamports ?? 0));
    this.handlers.set("getLatestBlockhash", () =>
      ctx({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: SLOT + 150 }),
    );
    this.handlers.set("getSlot", () => SLOT);
    this.handlers.set("getVersion", () => ({ "solana-core": "2.1.0", "feature-set": 0 }));
    this.handlers.set("getGenesisHash", () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  }

  setAccount(address: string, account: MockAccount) {
    this.accounts.set(address, account);
    return this;
  }

  on(method: string, handler: Handler) {
    this.handlers.set(method, handler);
    return this;
  }

  /** Make every JSON-RPC request fail at the HTTP layer (e.g. 500). */
  failHttp(status: number, body = "Internal Server Error") {
    this.httpFailure = { status, body };
    return this;
  }

  /** Delay every RPC response, to observe loading states. */
  delay(ms: number) {
    this.delayMs = ms;
    return this;
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async install(page: Page) {
    await page.route(
      (url) => !isLocal(url),
      (route) => this.handle(route),
    );
  }

  private async handle(route: Route) {
    const req = route.request();
    const body = req.method() === "POST" ? req.postData() ?? "" : "";
    if (!body.includes('"jsonrpc"')) {
      this.blocked.push(`${req.method()} ${req.url()}`);
      return route.abort("blockedbyclient");
    }
    const parsed = JSON.parse(body) as
      | { id: string; method: string; params?: unknown[] }
      | { id: string; method: string; params?: unknown[] }[];
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of batch) this.calls.push({ url: req.url(), method: r.method, params: r.params ?? [] });
    if (this.delayMs) await new Promise((res) => setTimeout(res, this.delayMs));
    if (this.httpFailure) {
      return route.fulfill({ status: this.httpFailure.status, contentType: "text/plain", body: this.httpFailure.body });
    }
    const answer = (r: { id: string; method: string; params?: unknown[] }) => {
      const h = this.handlers.get(r.method);
      const call = { url: req.url(), method: r.method, params: r.params ?? [] };
      if (!h) return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `Method not mocked: ${r.method}` } };
      try {
        return { jsonrpc: "2.0", id: r.id, result: h(r.params ?? [], call) };
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(-32000, String(e));
        return { jsonrpc: "2.0", id: r.id, error: { code: err.code, message: err.message } };
      }
    };
    const out = Array.isArray(parsed) ? batch.map(answer) : answer(batch[0]);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(out),
    });
  }
}

type Fixtures = {
  rpc: RpcMock;
  consoleErrors: string[];
};

export const test = base.extend<Fixtures>({
  rpc: [
    async ({ page }, use) => {
      const mock = new RpcMock();
      await mock.install(page);
      await use(mock);
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const loc = msg.location();
        errors.push(`[console.error] ${msg.text()}${loc?.url ? ` (${loc.url}:${loc.lineNumber})` : ""}`);
      });
      page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
      await use(errors);
      if (errors.length) {
        await testInfo.attach("console-errors.txt", { body: errors.join("\n"), contentType: "text/plain" });
      }
    },
    { auto: true },
  ],
});

export { expect };

export const PAGES = [
  { path: "/", h1: /one-time keys/i },
  { path: "/scan", h1: /scan/i },
  { path: "/attestations", h1: /attestation/i },
  { path: "/docs", h1: /^docs$/i },
] as const;

/** Flat folder of deliberate screenshots, inside the (gitignored) Playwright output dir. */
export const SCREENSHOT_DIR = path.join(__dirname, "test-results", "screenshots");

export async function snap(page: Page, name: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

/** Wait until client components have hydrated (the language switch is a client component with handlers). */
export async function waitForHydration(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForFunction(() => {
    const btn = document.querySelector('[role="group"][aria-label="Language"] button');
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber"));
  });
}
