import { test as setup, expect } from "@playwright/test";
import { PAGES } from "./fixtures";

// First compile of each route can take minutes in `next dev` on a slow disk.
setup.setTimeout(1_200_000);

setup("compile every route in next dev", async ({ request }) => {
  for (const { path } of PAGES) {
    const res = await request.get(path, { timeout: 420_000 });
    expect(res.status(), `GET ${path}`).toBe(200);
  }
});
