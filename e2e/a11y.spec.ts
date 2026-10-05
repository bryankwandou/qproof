import type { Page, TestInfo } from "@playwright/test";
import { PAGES, expect, test, waitForHydration } from "./fixtures";

/**
 * Accessibility scan with axe-core.
 *
 * @axe-core/playwright lives in e2e/node_modules (installed via `npm --prefix e2e ci`) so the
 * root package.json is untouched. If it is not installed, these tests skip instead of failing.
 */
type AxeBuilderLike = {
  withTags(tags: string[]): AxeBuilderLike;
  analyze(): Promise<{ violations: AxeViolation[] }>;
};
type AxeBuilderCtor = new (opts: { page: Page }) => AxeBuilderLike;
type AxeViolation = {
  id: string;
  impact?: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[]; failureSummary?: string }[];
};

let AxeBuilder: AxeBuilderCtor | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  AxeBuilder = require("@axe-core/playwright").default;
} catch {
  AxeBuilder = null;
}

const BLOCKING = new Set(["critical", "serious"]);

function summarize(v: AxeViolation[]) {
  return v.map((x) => ({
    id: x.id,
    impact: x.impact,
    help: x.help,
    count: x.nodes.length,
    targets: x.nodes.slice(0, 5).map((n) => n.target.join(" ")),
  }));
}

async function scan(page: Page, testInfo: TestInfo) {
  const results = await new AxeBuilder!({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  await testInfo.attach("axe-violations.json", {
    body: JSON.stringify(summarize(results.violations), null, 2),
    contentType: "application/json",
  });
  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  const advisory = results.violations.filter((v) => !BLOCKING.has(v.impact ?? ""));
  if (advisory.length) {
    testInfo.annotations.push({ type: "axe-advisory", description: JSON.stringify(summarize(advisory)) });
  }
  return { blocking, advisory };
}

test.describe("accessibility (axe)", () => {
  test.skip(!AxeBuilder, "@axe-core/playwright not installed (run: npm --prefix e2e ci)");
  // Render framer-motion content at its final state so contrast is measured on opaque text.
  test.use({ reducedMotion: "reduce" });

  for (const { path } of PAGES) {
    test(`${path} has no serious or critical WCAG A/AA violations`, async ({ page }, testInfo) => {
      await page.goto(path);
      await waitForHydration(page);
      await page.waitForLoadState("networkidle");
      const { blocking } = await scan(page, testInfo);
      expect(summarize(blocking)).toEqual([]);
    });
  }

  test("/scan with a rendered report has no serious or critical violations", async ({ page }, testInfo) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Load vulnerable vault" }).click();
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByText("QP001", { exact: true })).toBeVisible();
    const { blocking } = await scan(page, testInfo);
    expect(summarize(blocking)).toEqual([]);
  });

  test("/scan chain tab with a validation error has no serious or critical violations", async ({ page }, testInfo) => {
    await page.goto("/scan");
    await waitForHydration(page);
    await page.getByRole("tab", { name: "Program or account" }).click();
    await page.getByRole("button", { name: "Inspect address" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    const { blocking } = await scan(page, testInfo);
    expect(summarize(blocking)).toEqual([]);
  });

  test("keyboard: skip to content and tab order reach the main nav", async ({ page }) => {
    await page.goto("/");
    await waitForHydration(page);
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { tag: el?.tagName, text: el?.textContent?.trim(), href: el?.getAttribute("href") };
    });
    // Soft: a skip link is best practice but not present today.
    expect.soft(first.text ?? "", "first Tab stop should be a 'Skip to content' link").toMatch(/skip/i);
    // Hard: the nav links must be reachable by keyboard.
    const reached: string[] = [];
    for (let i = 0; i < 12; i++) {
      const href = await page.evaluate(() => document.activeElement?.getAttribute("href"));
      if (href) reached.push(href);
      await page.keyboard.press("Tab");
    }
    expect(reached).toEqual(expect.arrayContaining(["/scan", "/attestations", "/docs"]));
  });
});
