import { expect, test } from "@playwright/test";
import { gotoTab, openConstituency, openHome } from "./helpers";

/** S-98 / S-99 / S-100: constituency, mandal and village profile pages and the geography search that reaches them. */

test.describe("profile pages", () => {
  test("@E2E-113 constituency profile shows boundary, electors, history, units, PC and sources", async ({ page, request }) => {
    const seats = (await (await request.get("/api/v1/elections?state=TG&type=assembly")).json()).seats as { acName: string }[];
    await openHome(page, "TG");
    await gotoTab(page, /constituenc/i);
    await openConstituency(page, seats[0].acName);
    const profile = page.getByTestId("constituency-profile");
    await expect(profile.getByTestId("boundary-thumb").locator("svg path")).toHaveCount(1);
    await expect(profile.getByTestId("profile-history").getByTestId("history-row").first()).toBeVisible();
    await expect(profile.getByTestId("profile-units")).toContainText(/mandals/i);
    await expect(profile.getByTestId("profile-pc")).toBeVisible();
    await expect(profile.getByTestId("profile-electors")).toBeVisible();
    await expect(profile.getByTestId("profile-sources")).toContainText(/Election Commission|TCPD/i);
    await expect(profile).not.toContainText(/survey/i);
    // civic issue aggregates are suppressed below 30 reports and say so
    await expect(profile.getByTestId("profile-issues")).toContainText(/30|not available/i);
  });

  test("@E2E-113 deep link opens the profile page and Back returns to the tab", async ({ page }) => {
    await page.goto("/?state=TG#/constituency/TG/1");
    const profile = page.getByTestId("constituency-profile");
    await expect(profile).toContainText("Sirpur");
    await expect(profile.getByTestId("profile-reservation")).toContainText(/General/);
    await page.getByTestId("profile-back").click();
    await expect(page.getByTestId("profile-page")).toHaveCount(0);
  });

  test("@E2E-114 village profile: census by Census 2011 code, Telugu name, linked constituency", async ({ page }) => {
    await page.goto("/?state=TG#/place/TG/village/568945");
    const prof = page.getByTestId("place-profile");
    await expect(prof).toBeVisible();
    await expect(prof.getByTestId("census-population")).toContainText("2,232");
    await expect(prof.getByTestId("census-literacy")).toContainText(/\d+(\.\d+)?%/); // literacy now ingested from the Census PCA (S-84)
    await expect(prof.getByTestId("profile-name-other")).toContainText("కరంజి");
    await expect(prof.getByTestId("constituency-link").first()).toBeVisible();
    await expect(prof.getByTestId("profile-sources")).toContainText(/Census/i);
    // a constituency link leads to the constituency profile
    await prof.getByTestId("constituency-link").first().click();
    await expect(page.getByTestId("constituency-profile")).toBeVisible();
  });

  test("@E2E-114 village without census row says not available, never zero", async ({ page, request }) => {
    const items = (await (await request.get("/api/v1/geo/AP/units?level=village&limit=200")).json()).items as { code: string }[];
    let code: string | null = null;
    for (const v of items) {
      const p = await (await request.get(`/api/v1/geo/AP/places/village/${v.code}`)).json();
      if (!p.census.available) { code = v.code; break; }
    }
    test.skip(!code, "every sampled AP village has a census row");
    await page.goto(`/?state=AP#/place/AP/village/${code}`);
    await expect(page.getByTestId("census-unavailable")).toBeVisible();
    await expect(page.getByTestId("census-population")).toHaveCount(0);
  });

  test("@E2E-114 Telugu language shows Telugu names and a note when a village has none", async ({ page }) => {
    await page.goto("/?state=TG&lang=te#/place/TG/village/568945");
    await expect(page.getByTestId("profile-title")).toContainText("కరంజి");
    await page.goto("/?state=TG&lang=te#/place/TG/mandal/4305");
    await expect(page.getByTestId("place-profile")).toHaveAttribute("data-level", "mandal");
    await expect(page.getByTestId("census-population")).toContainText("39,631");
  });

  test("@E2E-114 S-90 village boundaries (SHRUG) on mandal and village profiles with the attribution in EN and TE", async ({ page }) => {
    const attrEn = "Village boundaries: SHRUG, Development Data Lab, CC BY-NC-SA 4.0, 2011 Census based; for non-commercial use";
    await page.goto("/?state=TG#/place/TG/mandal/4305");
    const vb = page.getByTestId("village-boundaries");
    await expect(vb.getByTestId("village-boundaries-svg")).toBeVisible();
    expect(Number(await vb.getByTestId("village-boundaries-svg").getAttribute("data-polygons"))).toBeGreaterThan(5);
    await expect(vb.getByTestId("village-boundaries-attribution")).toHaveText(attrEn);
    await page.goto("/?state=TG#/place/TG/village/568945");
    await expect(page.getByTestId("village-boundaries").locator('path[data-focus="true"]')).toHaveCount(1);
    await expect(page.getByTestId("village-boundaries-attribution")).toHaveText(attrEn);
    await page.goto("/?state=TG&lang=te#/place/TG/village/568945");
    await expect(page.getByTestId("village-boundaries-attribution")).toContainText("SHRUG");
    await expect(page.getByTestId("village-boundaries-attribution")).toContainText("వాణిజ్యేతర");
  });

  test("@E2E-114 mandal page is reachable from a constituency profile; unknown place shows an error", async ({ page }) => {
    await page.goto("/?state=TG#/constituency/TG/1");
    await page.getByTestId("mandal-link").first().click();
    await expect(page.getByTestId("place-profile")).toHaveAttribute("data-level", "mandal");
    await page.goto("/?state=TG#/place/TG/village/99999999");
    await expect(page.getByTestId("error-banner-inline")).toBeVisible();
  });

  test("@E2E-115 place search finds districts, mandals and villages and opens the profile", async ({ page }) => {
    await openHome(page, "TG");
    await gotoTab(page, /constituenc/i);
    await page.getByTestId("place-search").fill("Tamsi");
    const hit = page.getByTestId("place-result").first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.getByTestId("place-profile")).toBeVisible();
  });

  test("@E2E-113 profile page has no horizontal overflow at the current viewport", async ({ page }) => {
    await page.goto("/?state=TG#/constituency/TG/1");
    await expect(page.getByTestId("constituency-profile")).toContainText("Sirpur");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });

  test("@E2E-205 a winner with a free-licence photo shows it from our own server with credit and licence", async ({ page, request }) => {
    const photos = (await (await request.get("/api/v1/photos/index.json")).json()).photos as { state: string; acNo: number; file: string }[];
    const p = photos.find((x) => x.state === "TG")!;
    expect(photos.length).toBeGreaterThan(20);
    expect((await request.get(`/api/v1/photos/${p.file}`)).status()).toBe(200);
    expect((await request.get("/api/v1/photos/..%2Findex.json")).status()).toBe(404);
    const foreign: string[] = [];
    page.on("request", (r) => { if (!r.url().startsWith("http://localhost") && !r.url().startsWith("http://127.0.0.1") && !r.url().startsWith("data:")) foreign.push(r.url()); });
    await page.goto(`/?state=TG#/constituency/TG/${p.acNo}`);
    const fig = page.getByTestId("winner-photo");
    await expect(fig).toBeVisible();
    await expect(fig.locator("img")).toHaveJSProperty("complete", true);
    await expect(fig).toContainText(/Wikimedia Commons/);
    await expect(fig).toContainText(/CC|GODL|Public domain/);
    expect(foreign).toEqual([]);
    // a seat with no photo shows none
    const none = Array.from({ length: 119 }, (_, i) => i + 1).find((n) => !photos.some((x) => x.state === "TG" && x.acNo === n))!;
    await page.goto(`/?state=TG#/constituency/TG/${none}`);
    await expect(page.getByTestId("constituency-profile")).toBeVisible();
    await expect(page.getByTestId("winner-photo")).toHaveCount(0);
    await expect(page.getByTestId("winner-photo-missing")).toContainText(/no free-licence photo/i);
  });

  test("@E2E-207 a person can send a photo for a constituency: it is held for review, refused without consent, and never shown meanwhile", async ({ page, request }) => {
    const photos = (await (await request.get("/api/v1/photos/index.json")).json()).photos as { state: string; acNo: number }[];
    const none = Array.from({ length: 119 }, (_, i) => i + 1).find((n) => !photos.some((x) => x.state === "TG" && x.acNo === n))!;
    await page.goto(`/?state=TG#/constituency/TG/${none}`);
    const box = page.getByTestId("photo-submit");
    await expect(box).toBeVisible();
    await box.locator("summary").click();
    await expect(box).toContainText(/not shown until a person has checked/i);
    await expect(box).toContainText(/never shown|kept private/i);
    // a tiny valid JPEG
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]);
    await box.locator('input[name="claimedName"]').fill("Test Person");
    await box.locator('input[name="holder"]').fill("Photo: Test Person");
    await box.locator('input[name="contact"]').fill("test@example.org");
    await box.locator('input[name="photo"]').setInputFiles({ name: "p.jpg", mimeType: "image/jpeg", buffer: jpg });
    await page.getByTestId("photo-submit-send").click();
    await expect(page.getByTestId("photo-submit-error")).toContainText(/right to give this photo/i); // consent not ticked
    await box.locator('input[name="consent"]').check();
    await page.getByTestId("photo-submit-send").click();
    await expect(page.getByTestId("photo-submit-done")).toContainText(/after a person checks/i);
    await expect(page.getByTestId("winner-photo")).toHaveCount(0); // pending: not shown
    const idx = (await (await request.get("/api/v1/photos/index.json")).json()).photos as { origin?: string }[];
    expect(idx.some((p) => p.origin === "upload")).toBe(false);
  });
});
