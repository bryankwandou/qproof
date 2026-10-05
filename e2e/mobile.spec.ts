import { Keypair } from "@solana/web3.js";
import type { Page } from "@playwright/test";
import { PAGES, expect, snap, test, waitForHydration } from "./fixtures";

const VW = 375;
test.use({ viewport: { width: VW, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

/** Returns elements whose right edge sticks out past the viewport, to make failures actionable. */
async function horizontalOverflow(page: Page) {
  return page.evaluate((vw) => {
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1) continue;
      // Ignore content clipped by an ancestor that scrolls/clips horizontally.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== "visible") {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      offenders.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)}`);
    }
    return {
      viewport: vw,
      // With isMobile, Chromium widens the layout viewport to fit overflowing content,
      // so innerWidth > 375 is itself a sign of horizontal overflow.
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: offenders.slice(0, 10),
    };
  }, VW);
}

async function expectNoHorizontalScroll(page: Page) {
  const r = await horizontalOverflow(page);
  expect(r.innerWidth, `layout viewport was widened past ${VW}px: ${JSON.stringify(r)}`).toBe(VW);
  expect(r.scrollWidth, `document is wider than the 375px viewport: ${JSON.stringify(r)}`).toBeLessThanOrEqual(r.viewport);
  expect(r.bodyScrollWidth, JSON.stringify(r)).toBeLessThanOrEqual(r.viewport);
  // Belt and braces: the window must not actually scroll sideways.
  const scrollX = await page.evaluate(() => {
    window.scrollTo(200, window.scrollY);
    const x = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return x;
  });
  expect(scrollX, JSON.stringify(r)).toBe(0);
}

test.describe("mobile 375px", () => {
  for (const { path } of PAGES) {
    test(`${path} has no horizontal scroll`, async ({ page }) => {
      await page.goto(path);
      await waitForHydration(page);
      await page.waitForLoadState("networkidle");
      // Scroll through so whileInView/lazy content is rendered at its final size.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 30));
        }
        window.scrollTo(0, 0);
      });
      await expectNoHorizontalScroll(page);
      await snap(page, `mobile${path === "/" ? "-home" : path.replace(/\//g, "-")}`);
    });
  }

  test("/scan stays within 375px after a report with long hashes and notes is rendered", async ({ page }) => {
    const addr = Keypair.generate().publicKey.toBase58();
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Load vulnerable vault" }).click();
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByText("QP001", { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await snap(page, "mobile-scan-source-report");

    await page.getByRole("tab", { name: "Program or account" }).click();
    await page.getByLabel("Program ID", { exact: true }).fill(addr);
    await page.getByRole("button", { name: "Inspect address" }).click();
    await expect(page.getByRole("heading", { name: /^Findings/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("hamburger menu opens, navigates, and closes", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    const banner = page.getByRole("banner");
    // Desktop nav is hidden at this width.
    await expect(banner.getByRole("link", { name: "Scanner" })).toBeHidden();
    const menu = banner.getByRole("button", { name: "Menu" });
    await expect(menu).toBeVisible();
    await menu.tap();
    const mobileNav = banner.getByRole("navigation").filter({ has: page.getByRole("link", { name: "Attestations" }) }).last();
    await expect(mobileNav.getByRole("link", { name: "Attestations" })).toBeVisible();
    await mobileNav.getByRole("link", { name: "Attestations" }).tap();
    await expect(page).toHaveURL("/attestations");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/attestations/i);
    await expect(banner.getByRole("link", { name: "Attestations" })).toBeHidden();

    // Soft a11y checks on the toggle (reported, not blocking).
    await expect.soft(menu, "menu toggle should expose aria-expanded").toHaveAttribute("aria-expanded", "false");
  });

  test("tap targets in the header are at least 24x24 CSS px", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    const buttons = page.getByRole("banner").getByRole("button");
    const small: string[] = [];
    for (const b of await buttons.all()) {
      if (!(await b.isVisible())) continue;
      const box = await b.boundingBox();
      if (box && (box.width < 24 || box.height < 24)) small.push(`${(await b.getAttribute("aria-label")) ?? (await b.innerText())} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    expect(small, "WCAG 2.2 SC 2.5.8 target size (minimum)").toEqual([]);
  });
});
