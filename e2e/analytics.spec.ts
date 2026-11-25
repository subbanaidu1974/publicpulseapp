import { expect, test } from "@playwright/test";

/** Turnout, comparison, history, by-elections and cited party changes (S-112, S-115, S-116, S-117, S-120). Real AP/TG snapshot. */

test("@E2E-135 turnout page shows turnout by district and seat with sources, NOTA, and says gender turnout is not available", async ({ page }) => {
  await page.goto("/?state=AP#/analytics/turnout");
  await expect(page.getByTestId("turnout-page")).toBeVisible();
  await expect(page.getByTestId("analytics-source")).toContainText(/TCPD|Election Commission/);
  await expect(page.getByTestId("analytics-source")).toContainText(/Provenance/);
  await expect(page.getByTestId("state-turnout")).toContainText(/^\d\d\.\d\d%$/);
  await expect(page.getByTestId("state-nota")).toContainText(/%$/);
  await expect(page.getByTestId("turnout-seat-row")).toHaveCount(175);
  await expect(page.getByTestId("chart-district-turnout").locator("svg")).toBeVisible();
  // table fallback holds the same figures
  await page.getByTestId("chart-district-turnout-table").locator("summary").click();
  expect(await page.getByTestId("chart-district-turnout-table").locator("tbody tr").count()).toBeGreaterThanOrEqual(20);
  // gender turnout is never fabricated
  await expect(page.getByTestId("gender-turnout-na")).toContainText(/not available/i);
  await expect(page.getByTestId("cand-sex-summary")).toContainText("/");
  // sorting works
  await page.getByTestId("turnout-sort").selectOption("turnout");
  const first = await page.getByTestId("turnout-seat-row").first().innerText();
  const last = await page.getByTestId("turnout-seat-row").last().innerText();
  const pct = (t: string) => Number(/(\d+\.\d+)%/.exec(t)![1]);
  expect(pct(first)).toBeGreaterThanOrEqual(pct(last));
});

test("@E2E-135 turnout page works in Telugu and for Telangana 2009 with the pre-bifurcation flag and no NOTA", async ({ page }) => {
  await page.goto("/?state=TG#/analytics/turnout");
  await page.getByTestId("turnout-year").selectOption("2009");
  await expect(page.getByTestId("prebif-flag")).toContainText(/undivided Andhra Pradesh/);
  await expect(page.getByTestId("state-nota")).toHaveText(/not available/i);
  await expect(page.getByTestId("turnout-seat-row")).toHaveCount(119);
  await page.evaluate(() => localStorage.setItem("pp-lang", "te"));
  await page.reload();
  await expect(page.getByTestId("gender-turnout-na")).toContainText(/అందుబాటులో లేదు/);
});

test("@E2E-132 comparison page: assembly vs Lok Sabha shares, per-seat table, incumbency with honest coverage, candidate trails with confidence", async ({ page }) => {
  await page.goto("/?state=AP#/analytics/compare");
  await page.getByTestId("compare-year").selectOption("2019");
  await expect(page.getByTestId("party-compare-row").first()).toBeVisible();
  await expect(page.getByTestId("pc-compare-row")).toHaveCount(25);
  await expect(page.getByTestId("analytics-source")).toBeVisible();
  await expect(page.getByTestId("compare-caveats")).toContainText(/per parliamentary constituency/);
  await expect(page.getByTestId("inc-winrate").first()).toContainText(/%/);
  await page.getByTestId("compare-year").selectOption("2024");
  await expect(page.getByTestId("inc-unavailable").first()).toContainText(/incumbent flag/);
  await page.getByTestId("trail-query").fill("naidu");
  await page.getByTestId("trail-go").click();
  await expect(page.getByTestId("trail-item").first()).toBeVisible();
  await expect(page.getByTestId("trail-confidence").first()).toContainText(/high|medium/);
  await expect(page.getByTestId("trails")).not.toContainText(/turncoat/i);
});

test("@E2E-131 history page lists 2009 and 2014 elections with comparability notes and shows their seat tally", async ({ page }) => {
  await page.goto("/?state=TG#/analytics/history");
  await expect(page.getByTestId("history-notes")).toContainText(/undivided Andhra Pradesh/);
  const pre = page.getByTestId("history-election").and(page.locator("[data-comparability='pre-bifurcation']"));
  await expect(pre).toHaveCount(3);
  await expect(pre.filter({ hasText: "2009" }).first()).toContainText(/119|17/);
  await page.getByTestId("history-pick").selectOption("2009|assembly");
  await expect(page.getByTestId("chart-history-tally")).toBeVisible();
  await page.getByTestId("chart-history-tally-table").locator("summary").click();
  await expect(page.getByTestId("chart-history-tally-table")).toContainText("INC");
  await expect(page.getByTestId("prebif-flag")).toBeVisible();
});

test("@E2E-130 Jubilee Hills 2025 by-election appears in the seat history and on the constituency page", async ({ page }) => {
  await page.goto("/?state=TG#/analytics/history");
  const jh = page.getByTestId("byelection-item").filter({ hasText: "JUBILEE HILLS" });
  await expect(jh).toContainText("2025-11");
  await expect(jh).toContainText(/NAVEEN YADAV/i);
  await expect(jh).toContainText("INC");
  await expect(jh.getByTestId("byelection-verified")).toContainText(/second source/);
  await page.goto("/?state=TG#/constituency/TG/61");
  await expect(page.getByTestId("profile-byelections")).toContainText("2025-11");
  await expect(page.getByTestId("profile-byelections")).toContainText(/Maganti Gopinath/);
  // a seat without one says so
  await page.goto("/?state=TG#/constituency/TG/1");
  await expect(page.getByTestId("profile-byelections")).toContainText(/No by-election/);
});

test("@E2E-127 party changes (cited): same section for every candidate, entries carry two sources and a date, none is invented", async ({ page, request }) => {
  const find = async (q: string) => (await (await request.get(`/api/v1/contestants?q=${encodeURIComponent(q)}&state=TG&type=assembly&year=2023`)).json()).results as { id: string; name: string }[];
  const [dn] = await find("Danam Nagender");
  expect(dn).toBeTruthy();
  await page.goto(`/#/people/candidate/${encodeURIComponent(dn.id)}`);
  const sec = page.getByTestId("partychanges-section");
  await expect(sec).toBeVisible();
  const item = sec.getByTestId("partychange-item");
  await expect(item).toContainText("2024-03-17");
  await expect(item).toContainText(/BRS/);
  await expect(item).toContainText(/INC/);
  expect(await item.locator("a").count()).toBeGreaterThanOrEqual(2);
  await expect(sec).not.toContainText(/turncoat|defect/i);
  // another candidate: identical section, neutral none-recorded sentence
  const other = (await find("Revanth"))[0];
  await page.goto(`/#/people/candidate/${encodeURIComponent(other.id)}`);
  await expect(page.getByTestId("partychanges-section").locator("h2")).toHaveText((await sec.locator("h2").textContent())!);
  await expect(page.getByTestId("partychanges-none")).toContainText(/No party change is recorded/);
});

test("@E2E-135 analytics pages fit a 375px screen without sideways page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const h of ["turnout", "compare", "history"]) {
    await page.goto(`/?state=AP#/analytics/${h}`);
    await expect(page.getByTestId("analytics-root")).toBeVisible();
    await expect(page.getByTestId("analytics-source")).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  }
});

test.describe('parties page (S-195)', () => {
  test('@E2E-203 every party with a seat or 1% of the vote is listed with its seats, votes and share per election, from the data only', async ({ page, request }) => {
    const api = await request.get('/api/v1/analytics/parties/TG');
    expect(api.status()).toBe(200);
    const body = await api.json();
    expect(body.parties.length).toBeGreaterThan(3);
    const brs = body.parties.find((p: { code: string }) => p.code === 'BRS');
    expect(brs.rows.map((r: { year: number; type: string }) => `${r.year}-${r.type}`)).toEqual(expect.arrayContaining(['2014-assembly', '2018-assembly', '2023-assembly']));
    expect(body.parties.find((p: { code: string }) => p.code === 'NOTA')).toBeUndefined();
    expect((await request.get('/api/v1/analytics/parties/XX')).status()).toBe(404);

    await page.goto('/?state=TG#/analytics/parties');
    await expect(page.getByTestId('parties-page')).toBeVisible();
    const card = page.locator('[data-testid=party-card][data-party=INC]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('party-row').first()).toContainText(/\d{4}/);
    // the 2023 assembly row for INC matches the Elections page tally (64 seats)
    await expect(card.getByTestId('party-row').filter({ hasText: '2023' }).filter({ hasText: /Assembly/ })).toContainText('64');
    await expect(page.getByTestId('parties-notes')).toContainText('NOTA');
  });

  test('@E2E-203 the parties page is reachable from the analytics links and shows Telugu names in Telugu', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('pp-lang', 'te'); } catch { /* ignore */ } });
    await page.goto('/?state=AP#/analytics/parties');
    await expect(page.getByTestId('parties-page')).toBeVisible();
    await expect(page.getByTestId('an-nav-parties')).toContainText('పార్టీలు');
    await expect(page.locator('[data-testid=party-card]').first()).toContainText(/[\u0C00-\u0C7F]/);
  });

  test('@E2E-210 the parties page can be searched, ordered and filtered by election type, and each card leads with its latest figures', async ({ page }) => {
    await page.goto('/?state=TG#/analytics/parties');
    const cards = page.getByTestId('party-card');
    await expect(cards.first()).toBeVisible();
    const total = await cards.count();
    await expect(page.getByTestId('parties-summary')).toContainText(/\d+ parties listed/);
    await expect(page.getByTestId('parties-count')).toContainText(`Showing ${total} of ${total}`);
    // every card has a stats strip and a vote-share bar
    await expect(cards.first().getByTestId('party-stats')).toBeVisible();
    expect(await page.getByTestId('party-bar').count()).toBeGreaterThan(0);
    // default order is most seats first
    const seatTotals = await cards.evaluateAll((els) => els.map((e) => Number(e.querySelector('[data-testid=party-facts] strong')?.textContent)));
    expect([...seatTotals].sort((x, y) => y - x)).toEqual(seatTotals);
    // search by code
    await page.getByTestId('parties-search').fill('BRS');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute('data-party', 'BRS');
    await page.getByTestId('parties-search').fill('zzzz-no-such-party');
    await expect(page.getByTestId('parties-empty')).toBeVisible();
    await page.getByTestId('parties-search').fill('');
    await expect(cards).toHaveCount(total);
    // election type filter keeps only that type's rows
    await page.getByTestId('parties-type-ls').click();
    await expect(page.getByTestId('parties-type-ls')).toHaveAttribute('aria-pressed', 'true');
    const rowTexts = await page.getByTestId('party-row').allInnerTexts();
    expect(rowTexts.length).toBeGreaterThan(0);
    expect(rowTexts.every((t) => /Lok Sabha/.test(t) && !/Assembly/.test(t))).toBe(true);
    // order by name
    await page.getByTestId('parties-type-all').click();
    await page.getByTestId('parties-sort').selectOption('name');
    const codes = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-party') ?? ''));
    expect([...codes].sort((x, y) => x.localeCompare(y))).toEqual(codes);
  });
});

test.describe('electors by constituency and gender (S-197)', () => {
  test('@E2E-204 electors are listed by constituency with men, women, third gender and a sex ratio; age is stated as not available, never estimated', async ({ page, request }) => {
    const api = await (await request.get('/api/v1/electors/TG')).json();
    expect(api.items.length).toBe(119);
    await page.goto('/?state=TG#/analytics/electors');
    await expect(page.getByTestId('electors-page')).toBeVisible();
    await expect(page.getByTestId('electors-row')).toHaveCount(119);
    const total = api.items.reduce((s: number, x: { total: number }) => s + x.total, 0);
    await expect(page.getByTestId('e-total')).toHaveText(total.toLocaleString('en-IN'));
    await expect(page.getByTestId('e-ratio')).toHaveText(/^\d{3,4}$/);
    await expect(page.getByTestId('electors-note')).toContainText('2024 general election');
    await expect(page.getByTestId('electors-age')).toContainText('Not available');
    await expect(page.getByTestId('electors-age')).not.toContainText(/\d/); // no age figure of any kind
    await page.getByTestId('electors-sort').selectOption('femaleHigh');
    const first = await page.getByTestId('electors-row').first().innerText();
    const top = [...api.items].sort((a: { female: number; male: number; thirdGender: number }, b: { female: number; male: number; thirdGender: number }) => b.female / (b.male + b.female + b.thirdGender) - a.female / (a.male + a.female + a.thirdGender))[0];
    expect(first).toContain(top.acName);
  });

  test('@E2E-204 the electors page is reachable from the analytics links and works in Telugu', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('pp-lang', 'te'); } catch { /* ignore */ } });
    await page.goto('/?state=AP#/analytics/electors');
    await expect(page.getByTestId('electors-page')).toBeVisible();
    await expect(page.getByTestId('an-nav-electors')).toContainText('ఓటర్లు');
    await expect(page.getByTestId('electors-row')).toHaveCount(175);
    await expect(page.getByTestId('electors-age')).toContainText('అందుబాటులో లేదు');
  });

  test('@E2E-204 each constituency name on the electors page opens that constituency profile', async ({ page }) => {
    await page.goto('/?state=TG#/analytics/electors');
    const link = page.getByTestId('electors-link').nth(2); // constituency number 3
    await expect(link).toHaveAttribute('href', '#/constituency/TG/3');
    await link.click();
    await expect(page.getByTestId('constituency-profile')).toBeVisible();
    await expect(page.getByTestId('profile-title')).toBeVisible(); // spelling can differ between the roll report and the profile, so only the target seat is checked
    await expect(page.getByTestId('constituency-profile')).toContainText('#3');
  });

  test('@E2E-206 a party card shows its head with a free-licence photo, credit and role; a party without one shows none', async ({ page, request }) => {
    const photos = (await (await request.get('/api/v1/photos/leaders.json')).json()).photos as { party: string; file: string; name: string }[];
    const brs = photos.find((p) => p.party === 'BRS')!;
    expect(brs).toBeTruthy();
    expect((await request.get(`/api/v1/photos/${brs.file}`)).status()).toBe(200);
    expect((await request.get('/api/v1/photos/leader-XX.png')).status()).toBe(404);
    await page.goto('/?state=TG#/analytics/parties');
    const card = page.locator('[data-testid="party-card"][data-party="BRS"]');
    await expect(card.getByTestId('party-leader')).toContainText(brs.name);
    await expect(card.getByTestId('party-leader')).toContainText(/Wikimedia Commons/);
    await expect(card.getByTestId('party-leader').locator('img')).toHaveJSProperty('complete', true);
    const without = page.locator('[data-testid="party-card"]').filter({ hasNot: page.getByTestId('party-leader') });
    expect(await without.count()).toBeGreaterThan(0);
  });

  test('@E2E-204 rows of the electors page show the winner photo when one exists, and the link opens the profile with the photo and credit', async ({ page, request }) => {
    const photos = (await (await request.get('/api/v1/photos/index.json')).json()).photos as { state: string; acNo: number }[];
    const p = photos.find((x) => x.state === 'TG')!;
    await page.goto('/?state=TG#/analytics/electors');
    const n = photos.filter((x) => x.state === 'TG').length;
    await expect(page.getByTestId('electors-photo')).toHaveCount(n);
    await page.locator(`[data-testid="electors-link"][href="#/constituency/TG/${p.acNo}"]`).click();
    await expect(page.getByTestId('winner-photo')).toBeVisible();
    await expect(page.getByTestId('winner-photo')).toContainText(/Wikimedia Commons/);
  });

  test('@E2E-209 party cards on the Parties page show the party flag or logo from our own server with a credit', async ({ page }) => {
    const foreign: string[] = [];
    page.on('request', (r) => { if (!/^(http:\/\/(localhost|127\.0\.0\.1)|data:)/.test(r.url())) foreign.push(r.url()); });
    await page.goto('/?state=AP#/analytics/parties');
    const tdp = page.locator('[data-testid="party-card"][data-party="TDP"]');
    await expect(tdp.getByTestId('party-flag').locator('img')).toHaveJSProperty('complete', true);
    await tdp.getByTestId('party-flag-credit-TDP').locator('summary').click();
    await expect(tdp.getByTestId('party-flag-credit-TDP')).toContainText(/CC0/);
    const ys = page.locator('[data-testid="party-card"][data-party="YSRCP"]');
    await ys.getByTestId('party-flag-credit-YSRCP').locator('summary').click();
    await expect(ys.getByTestId('party-flag-credit-YSRCP')).toContainText(/identify the party/i); // logo, not a flag: identification only
    expect(await page.getByTestId('party-flag').count()).toBeGreaterThan(3);
    expect(foreign).toEqual([]);
  });
});

test.describe('panchayat elections (S-203)', () => {
  test('@E2E-211 the panchayat page says no results are loaded, lists the three levels and shows no figures', async ({ page, request }) => {
    const api = await request.get('/api/v1/analytics/panchayat/TG');
    expect(api.status()).toBe(200);
    const body = await api.json();
    expect(body.loaded).toBe(false);
    expect(body.elections).toEqual([]);
    expect((await request.get('/api/v1/analytics/panchayat/XX')).status()).toBe(404);
    await page.goto('/?state=TG#/analytics/panchayat');
    await expect(page.getByTestId('panchayat-page')).toBeVisible();
    await expect(page.getByTestId('panchayat-empty')).toContainText(/No panchayat election results are loaded/);
    await expect(page.getByTestId('panchayat-level')).toHaveCount(3);
    await expect(page.getByTestId('panchayat-table')).toHaveCount(0);
    await expect(page.getByTestId('panchayat-notes')).toContainText(/No electoral-roll or voter-level data/);
    await expect(page.getByTestId('an-nav-panchayat')).toHaveAttribute('aria-current', 'page');
  });
  test('@E2E-211 the panchayat page works in Telugu', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('pp-lang', 'te'); } catch { /* ignore */ } });
    await page.goto('/?state=AP#/analytics/panchayat');
    await expect(page.getByTestId('panchayat-empty')).toContainText(/[ఀ-౿]/);
    await expect(page.getByTestId('an-nav-panchayat')).toContainText('పంచాయతీ');
  });
});
