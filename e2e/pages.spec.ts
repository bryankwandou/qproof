import { PAGES, expect, snap, test, waitForHydration } from "./fixtures";

test.describe("page load", () => {
  for (const { path, h1 } of PAGES) {
    test(`${path} loads without console errors`, async ({ page, consoleErrors, rpc }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await waitForHydration(page);

      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
      await expect(page.getByRole("main")).not.toBeEmpty();
      await expect(page.locator("footer")).toBeVisible();

      if (path === "/attestations") {
        // The page reads the registry from devnet on mount; with the mock it must settle.
        await expect(page.getByText("Not deployed yet")).toBeVisible();
        await expect(page.getByText("No attestations yet.")).toBeVisible();
        expect(rpc.callsTo("getAccountInfo").length).toBeGreaterThan(0);
      }

      // Let late effects (wallet adapter autoConnect, RPC reads) run before judging the console.
      await page.waitForLoadState("networkidle");
      await snap(page, `desktop${path === "/" ? "-home" : path.replace(/\//g, "-")}`);

      expect(rpc.blocked, "unexpected requests to third-party hosts").toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  }

  test("each page has a distinct, non-empty document title", async ({ page }) => {
    const titles: string[] = [];
    for (const { path } of PAGES) {
      await page.goto(path);
      const t = await page.title();
      expect(t.trim(), `title of ${path}`).not.toBe("");
      titles.push(t);
    }
    // Soft: client pages ("use client") cannot export metadata, so they inherit the root title.
    expect.soft(new Set(titles).size, `titles: ${JSON.stringify(titles)}`).toBe(PAGES.length);
  });

  test("unknown route returns 404 page with site chrome", async ({ page }) => {
    const res = await page.goto("/definitely-not-a-page");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("banner")).toBeVisible();
  });
});
