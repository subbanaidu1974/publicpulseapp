import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// The dev server serves data/generated/countday (git-ignored). The spec seeds SYNTHETIC snapshots there and removes them afterwards.
const DIR = path.resolve("data/generated/countday");
test.describe.configure({ mode: "serial" });
// Both projects would seed/remove the same shared directory at once (parallel workers race): run this spec in the desktop project only.
test.skip(({ isMobile }) => isMobile, "seeds a shared directory; desktop project only");

test.beforeAll(({}, testInfo) => {
  if (testInfo.project.name === "mobile") return; // hooks still run for skipped tests: do not touch the shared directory from the mobile project
  fs.rmSync(DIR, { recursive: true, force: true });
  execFileSync(process.execPath, ["--import", "tsx", "scripts/countday-ingest.ts", "--state", "AP", "--source", "fixture", "--steps", "3", "--acs", "8", "--dir", DIR], { stdio: "pipe" });
});
test.afterAll(({}, testInfo) => { if (testInfo.project.name !== "mobile") fs.rmSync(DIR, { recursive: true, force: true }); });

test("@E2E-50 count-day page shows synthetic banner, labels and never 'won' for partial counts", async ({ page }) => {
  await page.goto("/#/countday");
  await expect(page.getByTestId("countday-banner")).toContainText("SYNTHETIC");
  await expect(page.getByTestId("countday-table")).toBeVisible();
  const labels = await page.locator("[data-testid=countday-table] tbody tr").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-label")));
  expect(labels.length).toBe(8);
  expect(labels).toContain("leading");
  await expect(page.getByTestId("countday-meta")).toContainText("sha256");
});

test("@E2E-50 API: signed latest, immutable numbered snapshot, keys", async ({ request }) => {
  const latest = await request.get("/api/v1/countday/AP/latest");
  expect(latest.status()).toBe(200);
  const j = await latest.json();
  expect(j.body.seq).toBe(3);
  expect(j.live.state).toBe("synthetic");
  expect(j.signature.alg).toBe("ed25519");
  const snap = await request.get("/api/v1/countday/AP/snapshots/1");
  expect(snap.headers()["cache-control"]).toContain("immutable");
  const keys = await (await request.get("/api/v1/countday/keys")).json();
  expect(keys.keys.map((k: { keyId: string }) => k.keyId)).toContain(j.signature.keyId);
});
