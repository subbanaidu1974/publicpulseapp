import { expect, test } from "@playwright/test";

/** People pages (S-104..S-114). Hash routes: /#/people/... ; data comes from the real AP/TG snapshot. */

test("@E2E-119 party chip shows a licensed flag with credit, a caption for identification-only files, and a text chip otherwise", async ({ page }) => {
  await page.goto("/#/people/party/INC");
  await expect(page.getByTestId("profile-party")).toBeVisible();
  // INC media is identification-only: caption must be shown
  await expect(page.getByTestId("identonly-caption").first()).toContainText(/identify the party/i);
  await expect(page.getByTestId("party-media-flag")).toBeVisible();
  await page.goto("/#/people/party/YSRCP");
  // YSRCP has a logo (no flag) under a free licence since 2026-11-25: shown to identify the party, with credit
  await expect(page.getByTestId("party-media-symbol").first()).toBeVisible();
  await expect(page.getByTestId("identonly-caption").first()).toContainText(/identify the party/i);
  // home list: TDP chip has an image with a credit popover
  await page.goto("/#/people");
  const chip = page.getByTestId("party-list").getByTestId("party-chip-TDP");
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("party-media-TDP")).toBeVisible();
  await page.getByTestId("party-credit-TDP").locator("summary").click();
  await expect(page.getByTestId("party-credit-TDP")).toContainText(/CC0/);
});

test("@E2E-121 party profile shows seats, vote share and alliance kind labels per election", async ({ page }) => {
  await page.goto("/#/people/party/TDP");
  await expect(page.getByTestId("profile-title")).toContainText(/Telugu Desam/);
  const rows = page.getByTestId("party-election-row");
  await expect(rows.first()).toBeVisible();
  const ap24 = rows.filter({ hasText: "AP Assembly 2024" });
  await expect(ap24).toContainText("135 / 175");
  await expect(ap24.getByTestId("alliance-label").first()).toHaveAttribute("data-kind", /pre-poll|post-hoc/);
  await expect(page.getByTestId("party-wikidata")).toHaveAttribute("href", /wikidata\.org\/wiki\/Q\d+/);
  await expect(page.getByTestId("section-sources")).toBeVisible();
});

test("@E2E-122 office holders list cites sources and as-of dates", async ({ page }) => {
  await page.goto("/#/people/leaders");
  const items = page.getByTestId("office-holder");
  await expect(items.filter({ hasText: "N. Chandrababu Naidu" }).first()).toContainText("Chief Minister");
  await expect(items.filter({ hasText: "Revanth Reddy" })).toContainText("2023-12-07");
  expect(await items.count()).toBeGreaterThanOrEqual(7);
  await expect(items.first().locator("a")).toHaveCount(await items.first().locator("a").count());
  expect(await items.first().locator("a").count()).toBeGreaterThanOrEqual(2);
});

test("@E2E-123 member roster covers every seat and the by-election change is cited", async ({ page }) => {
  await page.goto("/#/people/members/TG/assembly");
  await expect(page.getByTestId("member-row")).toHaveCount(119);
  const jh = page.getByTestId("member-row").filter({ hasText: "JUBILEE HILLS" });
  await expect(jh).toContainText("Naveen Yadav");
  await expect(jh.getByTestId("member-note").first()).toBeVisible();
  await expect(jh.getByTestId("member-note").last().locator("a").first()).toHaveAttribute("href", /wikipedia\.org/);
  await page.getByTestId("members-tab-AP-ls").click();
  await expect(page.getByTestId("member-row")).toHaveCount(25);
});

test("@E2E-124 contestant search and profile: fixed layout, affidavit link-outs, no rankings or turncoat labels", async ({ page }) => {
  await page.goto("/#/people");
  await page.getByTestId("people-search").fill("revanth");
  await page.getByTestId("people-search-go").click();
  const hit = page.getByTestId("people-hit").first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByTestId("profile-candidate")).toBeVisible();
  const links = page.getByTestId("affidavit-link");
  await expect(links.first()).toHaveAttribute("href", /myneta\.info\/search_myneta\.php\?q=/);
  const text = (await page.getByTestId("profile-candidate").innerText()).toLowerCase();
  for (const bad of ["turncoat", "criminal", "assets", "ranking"]) expect(text).not.toContain(bad);
});

test("@E2E-125 winner photo shows credit; seats without a licensed match show the initials avatar", async ({ page, request }) => {
  const r = await request.get("/api/v1/members/TG?type=assembly");
  const body = await r.json();
  const withPhoto = body.members.filter((m: { photo: unknown }) => m.photo);
  expect(withPhoto.length).toBeGreaterThan(5);
  await page.goto("/#/people/members/TG/assembly");
  await expect(page.getByTestId("person-photo").first()).toBeVisible();
  await page.getByTestId("photo-credit").first().locator("summary").click();
  await expect(page.getByTestId("photo-credit").first()).toContainText(/CC|Public|PD/);
  await expect(page.getByTestId("person-initials").first()).toBeVisible();
});

test("@E2E-128 report / correct this: submit without login, SLA shown; photo takedown hides the photo at once", async ({ page, request }) => {
  const body = await (await request.get("/api/v1/members/TG?type=assembly")).json();
  const m = body.members.find((x: { photo: unknown }) => x.photo);
  await page.goto("/#/people/process");
  await expect(page.getByTestId("process-sla")).toContainText("7");
  await page.getByTestId("report-open").click();
  await page.getByTestId("report-reason").fill("This detail looks wrong, please check it.");
  await page.getByTestId("report-send").click();
  await expect(page.getByTestId("report-done")).toContainText("7");
  // photo takedown via API (same data layer the page reads)
  const key = `TG-assembly-${m.acNo}`;
  const t = await request.post("/api/v1/people/requests", { data: { kind: "takedown", page: "/p", targetKind: "photo", targetKey: key, reason: "Please remove this photo of me." } });
  expect(t.status()).toBe(201);
  const after = await (await request.get(`/api/v1/members/TG/assembly/${m.acNo}`)).json();
  expect(after.photo).toBeNull();
});

test("@E2E-129 neutral layout: every candidate page has the same sections in the same order", async ({ page }) => {
  const ids = ["TG-assembly-2023-72-1", "AP-assembly-2024-1-2", "TG-assembly-2023-5-3"];
  let ref: string[] | null = null;
  for (const id of ids) {
    await page.goto(`/#/people/candidate/${id}`);
    await expect(page.getByTestId("profile-candidate")).toBeVisible();
    const sections = await page.locator("[data-testid^='section-']").evaluateAll(els => els.map(e => e.getAttribute("data-testid")));
    ref ??= sections as string[];
    expect(sections).toEqual(ref);
  }
  expect(ref).toEqual(["section-identity", "section-record", "section-attributes", "section-otherElections", "section-links", "section-source"]);
});

test("people pages fit a 375px screen without sideways page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const route of ["/#/people", "/#/people/party/TDP", "/#/people/candidate/TG-assembly-2023-72-1", "/#/people/leaders"]) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
});

test("@E2E-122 Telugu leaders page shows Telugu portfolio names with an unreviewed notice", async ({ page }) => {
  await page.goto("/?lang=te#/people/leaders");
  const pf = page.getByTestId("office-portfolio").first();
  await expect(pf).toBeVisible();
  await expect(pf).toContainText(/[\u0C00-\u0C7F]/);
  await expect(pf.getByTestId("portfolio-unreviewed")).toBeVisible();
});
