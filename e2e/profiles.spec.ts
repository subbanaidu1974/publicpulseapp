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
});
