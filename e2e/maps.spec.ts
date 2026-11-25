import { expect, test, type Page } from "@playwright/test";

const open = async (page: Page, hash = "#/map/TG", state = "TG") => {
  await page.goto(`/?state=${state}${hash}`);
  await expect(page.getByTestId("map-page")).toBeVisible();
  await expect(page.locator("[data-testid=geo-map] path.leaflet-interactive").first()).toBeVisible();
};
const polygons = (page: Page) => page.locator("[data-testid=geo-map] path.leaflet-interactive");

test.describe("maps: choropleth (S-96)", () => {
  test("@E2E-111 district polygons, legend, table and description for TG", async ({ page }) => {
    await open(page);
    await expect(polygons(page)).toHaveCount(33);
    await expect(page.getByTestId("map-table").getByTestId("map-row")).toHaveCount(33);
    await expect(page.getByTestId("map-legend")).toContainText(/INC|BRS|BJP/);
    await expect(page.getByTestId("map-desc")).toContainText(/33/);
    await expect(page.getByTestId("geo-map")).toHaveAttribute("aria-describedby", "map-desc");
  });

  test("@E2E-111 AP constituency level draws 175 polygons coloured by the party registry", async ({ page }) => {
    await open(page, "#/map/AP/ac", "AP");
    await expect(polygons(page)).toHaveCount(175);
    const fills = await polygons(page).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("fill")))]);
    expect(fills.length).toBeGreaterThan(1);
    await expect(page.getByTestId("map-legend")).toContainText(/TDP/);
    expect(fills).toContain("#9a7400"); // TDP colour from data/reference/parties.json
  });

  test("@E2E-111 metric switch recolours and the table sorts, missing values last", async ({ page }) => {
    await open(page, "#/map/TG/ac");
    await page.getByTestId("map-metric").selectOption("margin");
    await expect(page.getByTestId("map-legend")).toContainText("%");
    await page.getByTestId("map-sort-value").click();
    await page.getByTestId("map-sort-value").click(); // descending
    const first = await page.getByTestId("map-row").first().innerText();
    expect(first).toMatch(/\d+\.\d%/);
    await page.getByTestId("map-metric").selectOption("reservation");
    await expect(page.getByTestId("map-legend")).toContainText(/SC/);
    await expect(page.getByTestId("map-legend")).toContainText(/ST/);
  });

  test("@E2E-111 keyboard: a table row button selects the area and the tooltip opens on focus", async ({ page }) => {
    await open(page, "#/map/TG/ac");
    const btn = page.getByTestId("map-row").first().getByRole("button");
    await btn.focus();
    await expect(page.locator(".leaflet-tooltip.pp-map-tip")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/map\/TG\/ac\/\d+$/);
    await expect(page.getByTestId("map-panel-ac")).toBeVisible();
  });

  test("@E2E-111 the background map comes from this site only: no third-party request, no consent control, no CDN assets (S-191)", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto("/?state=TG#/map/TG");
    await expect(polygons(page).first()).toBeVisible();
    await page.waitForTimeout(1500);
    const foreign = urls.filter((u) => /^https?:/.test(u) && new URL(u).origin !== new URL(page.url()).origin);
    expect(foreign).toEqual([]);
    expect(urls.filter((u) => /arcgisonline|tile\.openstreetmap|unpkg|cdnjs|jsdelivr/.test(u))).toEqual([]);
    // When the tile file is installed on the server the background is drawn (canvas tiles) and credited; otherwise plain shapes.
    const installed = (await page.request.head("/basemap/ap-tg.pmtiles")).ok();
    if (installed) {
      await expect(page.locator("[data-testid=geo-map] .leaflet-tile").first()).toBeAttached();
      await expect(page.locator("[data-testid=geo-map] .leaflet-control-attribution")).toContainText("OpenStreetMap");
    } else {
      await expect(page.locator("[data-testid=geo-map] .leaflet-tile")).toHaveCount(0);
    }
    await expect(page.getByTestId("map-tiles-off")).toHaveCount(0);
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
  });

  test("@E2E-111 if the background tile file is missing the map still works as plain boundary shapes (S-191)", async ({ page }) => {
    await page.route("**/basemap/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"basemap_not_installed"}' }));
    const errors: string[] = [];
    page.on("pageerror", (e) => { if (!/WebSocket/.test(e.message)) errors.push(e.message); }); // the dev server hot-reload socket is not ours
    await page.goto("/?state=TG#/map/TG");
    await expect(polygons(page).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator("[data-testid=geo-map] .leaflet-tile")).toHaveCount(0);
    await expect(page.locator("[data-testid=geo-map] .leaflet-control-attribution")).not.toContainText("OpenStreetMap");
    expect(errors).toEqual([]);
  });

  test("@E2E-111 usable at the current viewport: no horizontal overflow", async ({ page }) => {
    await open(page, "#/map/TG/ac");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(1);
    const box = await page.getByTestId("geo-map").boundingBox();
    expect(box!.width).toBeGreaterThan(300);
  });

  test("@E2E-111 Telugu labels", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("pp-lang", "te"); } catch { /* ignore */ } });
    await open(page);
    await expect(page.getByTestId("map-page").getByRole("heading", { level: 2 })).toContainText("పటం");
    await expect(page.getByTestId("map-row").first()).toContainText(/[ఀ-౿]/);
  });

  test("@E2E-111 home map shows real district polygons and opens the full map", async ({ page }) => {
      await page.goto("/?state=TG");
    await expect(page.locator("[data-testid=home-map] path.leaflet-interactive").first()).toBeVisible();
    expect(await page.locator("[data-testid=home-map] path.leaflet-interactive").count()).toBe(33);
    await page.getByTestId("home-map-open").click();
    await expect(page.getByTestId("map-page")).toBeVisible();
    await expect(page).toHaveURL(/#\/map\/TG$/);
  });
});

test.describe("maps: drill-down and overlays (S-97)", () => {
  test("@E2E-112 state to district to constituency with breadcrumb, units and back", async ({ page }) => {
    await open(page);
    await page.getByTestId("map-row").filter({ hasText: "Adilabad" }).getByRole("button").click();
    await expect(page).toHaveURL(/#\/map\/TG\/district\/501$/);
    await expect(page.getByTestId("crumb-district")).toBeVisible();
    await expect(polygons(page).first()).toBeVisible();
    const n = await polygons(page).count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(33);
    await page.getByTestId("map-row").first().getByRole("button").click();
    await expect(page).toHaveURL(/#\/map\/TG\/district\/501\/ac\/\d+$/);
    await expect(page.getByTestId("crumb-ac")).toBeVisible();
    await expect(page.getByTestId("map-units")).toBeVisible();
    await expect(page.getByTestId("map-mandals")).toContainText(/[ఀ-౿]/); // Telugu mandal names
    await page.getByTestId("map-mandals").getByRole("button").first().click();
    await expect(page.getByTestId("map-villages")).toBeVisible();
    await page.getByTestId("map-back").click();
    await expect(page).toHaveURL(/#\/map\/TG\/district\/501$/);
    await page.getByTestId("crumb-state").click();
    await expect(page).toHaveURL(/#\/map\/TG$/);
    await expect(polygons(page)).toHaveCount(33);
  });

  test("@E2E-112 clicking a polygon on the map drills in", async ({ page }) => {
    await open(page, "#/map/TG/district/501");
    await polygons(page).first().dispatchEvent("click");
    await expect(page).toHaveURL(/#\/map\/TG\/district\/501\/ac\/\d+$/);
  });

  test("@E2E-112 deep link restores the constituency panel and browser back returns to the district", async ({ page }) => {
    await open(page, "#/map/TG/district/501/ac/8");
    await expect(page.getByTestId("map-panel-ac")).toContainText("Boath");
    await page.evaluate(() => { window.location.hash = "#/map/TG/district/501"; });
    await expect(page.getByTestId("map-panel-district")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("map-panel-ac")).toContainText("Boath");
  });

  test("@E2E-112 population overlay: honest unavailable state when the census endpoint has no rows", async ({ page }) => {
    await page.route("**/api/v1/census/TG/districts", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "none", code: "no_data" }) }));
    await open(page);
    await page.getByTestId("map-metric").selectOption("population");
    await expect(page.getByTestId("map-unavailable")).toContainText(/not available/i);
  });

  test("@E2E-112 population overlay with rows colours matched districts and reports partial coverage", async ({ page }) => {
    await page.route("**/api/v1/census/TG/districts", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ districts: [{ district: "Adilabad", population: 2737738 }, { district: "Hyderabad", population: 3943323 }] }) }));
    await open(page);
    await page.getByTestId("map-metric").selectOption("population");
    await expect(page.getByTestId("map-partial")).toContainText(/2 \/ 33/);
    await expect(page.getByTestId("map-row").filter({ hasText: "Hyderabad" })).toContainText("39,43,323");
  });

  test("@E2E-112 issue overlay suppresses cells under 30 and says so when nothing qualifies", async ({ page }) => {
    await page.route("**/api/v1/civic/issues/metrics*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ level: "department", min_cell: 30, cells: [], masked: [] }) }));
    await open(page);
    await page.getByTestId("map-metric").selectOption("issues");
    await expect(page.getByTestId("map-unavailable")).toContainText(/30/);
  });

  test("@E2E-112 issue overlay shows only cells of at least 30", async ({ page }) => {
    await page.route("**/api/v1/civic/issues/metrics*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ cells: [{ unit_level: "district", unit_lgd: "501", total: 45 }, { unit_level: "district", unit_lgd: "507", total: 12 }] }) }));
    await open(page);
    await page.getByTestId("map-metric").selectOption("issues");
    await expect(page.getByTestId("map-row").filter({ hasText: "Adilabad" })).toContainText("45");
    await expect(page.getByTestId("map-row").filter({ hasText: "Hyderabad" })).toContainText(/no data/i);
  });

  test("@E2E-112 panel shows an honest empty state when the constituency service has no detail", async ({ page }) => {
    await page.route("**/api/v1/constituencies/TG/8", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "x", code: "unknown_constituency" }) }));
    await open(page, "#/map/TG/district/501/ac/8");
    await expect(page.getByTestId("map-units-unavailable")).toBeVisible();
  });
});
