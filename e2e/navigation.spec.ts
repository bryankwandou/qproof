import { expect, test, waitForHydration } from "./fixtures";

const NAV = [
  { name: "Scanner", path: "/scan", h1: /scanner/i },
  { name: "Attestations", path: "/attestations", h1: /attestations/i },
  { name: "Docs", path: "/docs", h1: /^docs$/i },
] as const;

test.describe("header navigation (desktop)", () => {
  for (const link of NAV) {
    test(`"${link.name}" link navigates to ${link.path}`, async ({ page }) => {
      await page.goto("/");
      await waitForHydration(page);
      const nav = page.getByRole("banner").getByRole("navigation");
      await nav.getByRole("link", { name: link.name, exact: true }).click();
      await expect(page).toHaveURL(link.path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(link.h1);
    });
  }

  test("visits every nav link in sequence and the logo returns home", async ({ page }) => {
    await page.goto("/docs");
    await waitForHydration(page);
    const nav = page.getByRole("banner").getByRole("navigation");
    for (const link of NAV) {
      await nav.getByRole("link", { name: link.name, exact: true }).click();
      await expect(page).toHaveURL(link.path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(link.h1);
    }
    await page.getByRole("banner").getByRole("link", { name: "qproof" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/one-time keys/i);
  });

  test("GitHub links open the repo in a new tab safely", async ({ page }) => {
    await page.goto("/");
    const links = page.getByRole("link", { name: "GitHub" });
    await expect(links).toHaveCount(2); // header + footer
    for (const l of await links.all()) {
      await expect(l).toHaveAttribute("href", /^https:\/\/github\.com\/[^/]+\/qproof$/);
      await expect(l).toHaveAttribute("target", "_blank");
      await expect(l).toHaveAttribute("rel", /noreferrer|noopener/);
    }
  });

  test("home CTAs lead to the scanner and docs", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.getByRole("main").getByRole("link", { name: /scan a program/i }).click();
    await expect(page).toHaveURL("/scan");
    await page.goBack();
    await expect(page).toHaveURL("/");
    await page.getByRole("main").getByRole("link", { name: /how it works/i }).click();
    await expect(page).toHaveURL("/docs");
  });

  test("every same-origin link on every page resolves (no 404s)", async ({ page, request }) => {
    const seen = new Set<string>();
    for (const path of ["/", "/scan", "/attestations", "/docs"]) {
      await page.goto(path);
      const hrefs = await page
        .locator("a[href]")
        .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
      for (const href of hrefs) {
        const u = new URL(href);
        if (u.origin !== new URL(page.url()).origin) continue;
        seen.add(u.pathname);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const p of seen) {
      const res = await request.get(p);
      expect(res.status(), `internal link ${p}`).toBe(200);
    }
  });

  test("language switch translates the nav and persists across navigation", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "id" }).click();
    const nav = page.getByRole("banner").getByRole("navigation");
    await expect(nav.getByRole("link", { name: "Pemindai" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await nav.getByRole("link", { name: "Pemindai" }).click();
    await expect(page).toHaveURL("/scan");
    await expect(nav.getByRole("link", { name: "Pemindai" })).toBeVisible();
    await page.reload();
    await expect(nav.getByRole("link", { name: "Pemindai" })).toBeVisible();
  });
});
