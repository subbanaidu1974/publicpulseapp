import crypto from 'node:crypto';
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, bearer, enrolAdmin, seedPerson, uniq, type Seeded } from './civic-seed';

// Real server, real WebAuthn: a CDP virtual authenticator (ctap2, usb, user verification on, automatic presence) answers
// navigator.credentials.create/get, so registration, approval and send are verified by the server's own WebAuthn code.
// Run with --workers=1: the kill-switch test engages a switch scoped to its own organisation only.
const N = `${API}/notify`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const isMobile = () => test.info().project.name === 'mobile';

async function openNotify(page: Page, token: string | null, hash: string, lang: 'en' | 'te' = 'en') {
  await page.addInitScript(([t, l]) => { try { localStorage.setItem('pp-lang', l as string); if (t) sessionStorage.setItem('civic-token', t as string); } catch { /* ignore */ } }, [token, lang]);
  await page.goto('/' + hash);
  await expect(page.locator('.notify-root')).toBeVisible();
}
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { cdp, authenticatorId };
}
// The public notify reads (policy, status, keys, senders, block log...) are limited per client address (60-120 a minute), and every notify screen
// loads some of them on mount. All pages and API calls of every worker here come from one address, so under load the limit answers 429, and a
// screen never retries a refused load (the compose form then has an empty category list, the window notice never shows). The server's limit is
// left alone; what changes is that these specs wait out a 429 (the window is a minute) instead of failing on it: page requests are re-issued by
// the route handler, direct API reads go through publicGet.
const PUBLIC_READ = /\/api\/v1\/civic\/notify\/(policy|status|keys|senders|block-log|templates)(\/[^?]*)?(\?.*)?$/;
const backoff = (retryAfter: string | undefined, i: number) => new Promise((res) => setTimeout(res, Math.min(15_000, (Number(retryAfter) || 0) * 1000 || 3000 * (i + 1))));
async function publicGet(request: APIRequestContext, url: string) {
  for (let i = 0; ; i++) {
    const r = await request.get(url);
    if (r.status() !== 429 || i >= 12) return r;
    await backoff(r.headers()['retry-after'], i);
  }
}
const retryPublicReads = async (ctx: BrowserContext) => {
  await ctx.route(PUBLIC_READ, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    try {
      let res = await route.fetch();
      for (let i = 0; res.status() === 429 && i < 12; i++) { await backoff(res.headers()['retry-after'], i); res = await route.fetch(); }
      await route.fulfill({ response: res });
    } catch { /* the test (and its page) ended while this read was waiting out a 429 */ }
  });
};
test.beforeEach(async ({ context }) => { await retryPublicReads(context); });
async function newSenderPage(browser: Browser, token: string, hash = '#/notifications/send', lang: 'en' | 'te' = 'en'): Promise<{ ctx: BrowserContext; page: Page; va: Awaited<ReturnType<typeof virtualAuthenticator>> }> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
  await retryPublicReads(ctx);
  const page = await ctx.newPage();
  const va = await virtualAuthenticator(page);
  await openNotify(page, token, hash, lang);
  return { ctx, page, va };
}
async function seedOrgWithSenders(request: APIRequestContext, n: number) {
  const o = await (await request.post(`${API}/e2e/notify/org`, { data: {} })).json() as { org_id: string; name: string };
  const people: Seeded[] = [];
  for (let i = 0; i < n; i++) {
    const p = await seedPerson(request);
    const r = await request.post(`${API}/e2e/notify/sender`, { data: { org_id: o.org_id, person_id: p.personId } });
    expect(r.status(), await r.text()).toBe(201);
    people.push(p);
  }
  return { org: o, people };
}
async function registerKey(page: Page) {
  await page.getByTestId('key-register').click();
  await expect(page.getByTestId('key-msg')).toBeVisible();
  await expect(page.getByTestId('key-count')).toContainText('1');
}
async function recipient(request: APIRequestContext, unit: string, word: string) {
  const r = await request.post(`${API}/e2e/person`, { data: { residence_unit: unit } });
  const j = await r.json() as { token: string; person_id: string };
  const h = (new Date().getUTCHours() + 5) % 24; // IST hour (the half hour is close enough: the quiet window is two hours away)
  const hh = (n: number) => String((h + n) % 24).padStart(2, '0') + ':00';
  const put = await request.put(`${N}/prefs`, { headers: bearer(j.token), data: { categories: { civic: true }, quiet_hours: { start: hh(3), end: hh(4) } } });
  expect(put.ok(), await put.text()).toBe(true);
  expect((await request.put(`${N}/antiphish`, { headers: bearer(j.token), data: { word } })).ok()).toBe(true);
  return j;
}
const windowOf = async (request: APIRequestContext) => (await (await request.get('/api/v1/election-window?state=AP')).json()).window as string;

test.describe('recipient screens', () => {
  test('@E2E-46 settings: emergency is locked on, categories opt in, quiet hours and word save, banner is standing', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openNotify(page, me.token, '#/notifications/settings');
    await expect(page.getByTestId('antiphish-banner')).toContainText('never ask for OTP, PIN or passwords');
    await expect(page.getByTestId('cat-emergency').locator('input')).toBeChecked();
    await expect(page.getByTestId('cat-emergency').locator('input')).toBeDisabled();
    await expect(page.getByTestId('word-warning')).toBeVisible();
    await expect(page.getByTestId('quiet-state')).toContainText('21:00 to 07:00');
    await page.getByTestId('cat-service').locator('input').click();
    await expect(page.getByTestId('cat-service').locator('input')).toBeChecked();
    await expect(page.getByTestId('settings-msg')).toBeVisible();
    await page.getByTestId('quiet-start').fill('22:30');
    await page.getByTestId('quiet-end').fill('06:30');
    await page.getByTestId('quiet-save').click();
    await expect(page.getByTestId('quiet-state')).toContainText('22:30 to 06:30');
    await page.getByTestId('word-input').fill('mango tree');
    await page.getByTestId('word-save').click();
    await expect(page.getByTestId('word-current')).toContainText('mango tree');
    await page.getByTestId('sms-ok').click();
    await expect(page.getByTestId('sms-ok')).toBeChecked();
    await expect(page.getByTestId('push-state')).toBeVisible();
    const prefs = await (await request.get(`${N}/prefs`, { headers: bearer(me.token) })).json();
    expect(prefs.categories.service.opted_in).toBe(true);
    expect(prefs.sms_ok).toBe(true);
    // unsubscribe keeps emergency
    await page.getByTestId('unsub-start').click();
    await page.getByTestId('unsub-confirm').click();
    await expect(page.getByTestId('cat-service').locator('input')).not.toBeChecked();
    await expect(page.getByTestId('cat-emergency').locator('input')).toBeChecked();
  });

  test('@E2E-170 settings list the real registered devices (no token is ever shown) and removal empties the list', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openNotify(page, me.token, '#/notifications/settings');
    await expect(page.getByTestId('devices-none')).toBeVisible();
    const token = 'e2e-device-token-' + uniq();
    expect((await request.post(`${N}/devices`, { headers: bearer(me.token), data: { token, platform: 'android' } })).status()).toBe(201);
    expect((await request.post(`${N}/devices`, { headers: bearer(me.token), data: { token: token + '-web', platform: 'web' } })).status()).toBe(201);
    const api = await (await request.get(`${N}/devices`, { headers: bearer(me.token) })).json();
    expect(api.count).toBe(2);
    expect(JSON.stringify(api)).not.toContain(token);
    await page.reload();
    await expect(page.getByTestId('devices-count')).toContainText('2 device');
    await expect(page.getByTestId('device-item')).toHaveCount(2);
    await expect(page.getByTestId('device-item').first()).toContainText(/Android phone|Web browser/);
    expect(await page.getByTestId('devices-panel').textContent()).not.toContain(token);
    await page.getByTestId('devices-remove').click();
    await expect(page.getByTestId('devices-none')).toBeVisible();
    expect((await (await request.get(`${N}/devices`, { headers: bearer(me.token) })).json()).count).toBe(0);
  });

  test('@E2E-170 the public home shows the election-period notice from the status route', async ({ page, request }) => {
    const st = await (await publicGet(request, `${N}/status?state=AP`)).json();
    expect(['open', 'blackout', 'unknown']).toContain(st.window.status);
    expect(st.kill).toHaveProperty('engaged');
    await openNotify(page, null, '#/notifications');
    await expect(page.getByTestId('mcc-AP')).toHaveAttribute('data-window', st.window.status);
    await expect(page.getByTestId('mcc-notice-AP')).toContainText(st.window.notice_en.slice(0, 30));
    const te = await page.context().newPage();
    await openNotify(te, null, '#/notifications', 'te');
    await expect(te.getByTestId('mcc-notice-AP')).toContainText(st.window.notice_te.slice(0, 12));
  });

  test('@E2E-46 a too-short anti-phishing word is refused with a plain message', async ({ page, request }) => {
    const me = await seedPerson(request);
    await openNotify(page, me.token, '#/notifications/settings');
    await page.getByTestId('word-input').fill('ab');
    await expect(page.getByTestId('word-save')).toBeDisabled();
  });

  test('@E2E-46 signed-out visitors are asked to sign in, public pages still load', async ({ page }) => {
    await openNotify(page, null, '#/notifications/inbox');
    await expect(page.getByTestId('nt-signin')).toBeVisible();
    await page.goto('/#/notifications/keys');
    await expect(page.getByTestId('notify-keys')).toBeVisible();
    await expect(page.getByTestId('how-verify')).toBeVisible();
    await expect(page.getByTestId('key-item').first()).toBeVisible();
  });
});

test.describe('sender console and delivery (virtual FIDO2 authenticator)', () => {
  test.beforeEach(() => { test.skip(isMobile(), 'WebAuthn virtual authenticator tests run on the chromium project only'); });

  test('@E2E-47 register keys, write, approve with a different sender, send, recipient sees the word, public logs show it', async ({ browser, request }) => {
    test.skip((await windowOf(request)) === 'blackout', 'AP is in a blackout window: free-text civic messages are blocked');
    const { org, people } = await seedOrgWithSenders(request, 2);
    const unit = 'e2e-unit-' + uniq();
    const word = 'jasmine ' + uniq().replace(/[0-9]/g, 'x').slice(0, 4);
    const rcpt = await recipient(request, unit, word);
    const a = await newSenderPage(browser, people[0].token);
    const b = await newSenderPage(browser, people[1].token);
    try {
      await expect(a.page.getByTestId('sender-binding')).toContainText(org.name);
      await expect(a.page.getByTestId('need-key')).toBeVisible(); // no key yet: composing is not offered
      await registerKey(a.page);
      await registerKey(b.page);
      await expect(a.page.getByTestId('compose')).toBeVisible();

      await a.page.getByTestId('compose-category').selectOption('civic');
      await a.page.getByTestId('compose-en').fill('Water supply will be off on Monday for repairs.');
      await a.page.getByTestId('compose-te').fill('సోమవారం మరమ్మతుల కోసం నీటి సరఫరా ఉండదు.');
      await a.page.getByTestId('compose-units').fill(unit);
      await a.page.getByTestId('compose-submit').click();
      await expect(a.page.getByTestId('compose-msg')).toBeVisible();
      const rowA = a.page.getByTestId('msg-row').first();
      await expect(rowA).toHaveAttribute('data-status', 'pending_approval');
      await expect(rowA.getByTestId('msg-wait-other')).toBeVisible();
      await expect(rowA.getByTestId('msg-approve')).toHaveCount(0); // never approves its own message
      const id = (await rowA.getAttribute('data-id'))!;

      // the creator cannot approve through the API either
      const ch = await (await request.post(`${N}/messages/${id}/challenge`, { headers: bearer(people[0].token), data: { purpose: 'approve' } })).json();
      expect(ch.challenge).toBeTruthy();

      await b.page.reload();
      await expect(b.page.getByTestId('approval-queue').getByTestId('msg-row')).toHaveCount(1);
      await b.page.getByTestId('msg-approve').click();
      await expect(b.page.getByTestId('my-messages').locator(`[data-id="${id}"]`)).toHaveAttribute('data-status', 'approved');

      await a.page.reload();
      const sendRow = a.page.locator(`[data-id="${id}"]`);
      await expect(sendRow).toHaveAttribute('data-status', 'approved');
      await sendRow.getByTestId('msg-send').click();
      await expect(sendRow).toHaveAttribute('data-status', 'sent');
      await expect(sendRow.getByTestId('msg-stats')).toBeVisible();

      // recipient inbox: word shown in the message, read state changes
      const rp = await browser.newPage({ baseURL: test.info().project.use.baseURL as string });
      await openNotify(rp, rcpt.token, '#/notifications/inbox');
      const item = rp.getByTestId('inbox-item');
      await expect(item).toHaveCount(1);
      await expect(item.getByTestId('inbox-word')).toContainText(word);
      await expect(item).toHaveAttribute('data-read', '0');
      await item.getByTestId('inbox-mark-read').click();
      await expect(item).toHaveAttribute('data-read', '1');
      await item.getByTestId('inbox-details').click();
      // verify the signature with the published key, as the page explains
      const inbox = await (await request.get(`${N}/inbox`, { headers: bearer(rcpt.token) })).json();
      const it = inbox.items[0];
      const keys = (await (await publicGet(request, `${N}/keys`)).json()).keys as { key_id: string; spki: string }[];
      const key = keys.find((k) => k.key_id === it.key_id)!;
      const pub = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64url'), format: 'der', type: 'spki' });
      expect(crypto.verify(null, Buffer.from(it.signed_payload), pub, Buffer.from(it.signature, 'base64url'))).toBe(true);
      await rp.close();

      // public transparency: directory, per-sender log with signature
      const pp = await browser.newPage({ baseURL: test.info().project.use.baseURL as string });
      await openNotify(pp, null, '#/notifications');
      await expect(pp.getByTestId('dir-org').filter({ hasText: org.name })).toHaveCount(1);
      await pp.goto(`/#/notifications/log/${org.org_id}`);
      await expect(pp.getByTestId('slog-item')).toHaveCount(1);
      await expect(pp.getByTestId('slog-sig')).toContainText(it.key_id);
      await pp.close();
    } finally { await a.ctx.close(); await b.ctx.close(); }
  });

  test('@E2E-47 content linter findings are shown, cancel works, and the refusal reaches the public block log', async ({ browser, request }) => {
    test.skip((await windowOf(request)) === 'blackout', 'AP is in a blackout window');
    const { org, people } = await seedOrgWithSenders(request, 1);
    const a = await newSenderPage(browser, people[0].token);
    try {
      await registerKey(a.page);
      await a.page.getByTestId('compose-category').selectOption('civic');
      await a.page.getByTestId('compose-en').fill('Please share your OTP to continue.');
      await a.page.getByTestId('compose-te').fill('కొనసాగడానికి మీ ఓటీపీ ఇవ్వండి.');
      await a.page.getByTestId('compose-units').fill('x-' + uniq());
      await a.page.getByTestId('compose-submit').click();
      await expect(a.page.getByTestId('lint-findings').locator('[data-rule=otp]')).toBeVisible();
      await expect(a.page.getByTestId('msg-row')).toHaveCount(0);
      await a.page.getByTestId('compose-en').fill('Health camp on Friday at the village hall.');
      await a.page.getByTestId('compose-te').fill('శుక్రవారం గ్రామ సభా భవనంలో ఆరోగ్య శిబిరం.');
      await a.page.getByTestId('compose-submit').click();
      await a.page.getByTestId('msg-cancel').click();
      await expect(a.page.getByTestId('msg-row').first()).toHaveAttribute('data-status', 'cancelled');
      await expect(a.page.getByTestId('tl-cancelled')).toBeVisible();
      const pp = await browser.newPage({ baseURL: test.info().project.use.baseURL as string });
      await openNotify(pp, null, '#/notifications/log');
      const row = pp.getByTestId('block-row').filter({ hasText: org.name });
      await expect(row.first()).toHaveAttribute('data-code', 'content_policy');
      await expect(row.first()).toContainText('content rules');
      await pp.close();
    } finally { await a.ctx.close(); }
  });

  test('@E2E-170 compose checks the text live on the server before anything is created', async ({ browser, request }) => {
    const { people } = await seedOrgWithSenders(request, 1);
    const a = await newSenderPage(browser, people[0].token);
    try {
      await registerKey(a.page);
      const lint = a.page.getByTestId('lint-live');
      await a.page.getByTestId('compose-en').fill('Please share your OTP to continue.');
      await expect(lint).toHaveAttribute('data-clean', '0');
      await expect(lint.locator('[data-rule=otp]')).toBeVisible();
      await a.page.getByTestId('compose-en').fill('Please open https://evil.example/pay now.');
      await expect(lint.locator('[data-rule=link_not_allowed]')).toBeVisible();
      await a.page.getByTestId('compose-en').fill('Health camp on Friday at the village hall.');
      await a.page.getByTestId('compose-te').fill('శుక్రవారం గ్రామ సభా భవనంలో ఆరోగ్య శిబిరం.');
      await expect(lint).toHaveAttribute('data-clean', '1');
      await expect(lint).toContainText('No problems found');
      // nothing was created and nothing reached the block log by typing
      await expect(a.page.getByTestId('msg-row')).toHaveCount(0);
      const mine = await (await request.get(`${N}/messages`, { headers: bearer(people[0].token) })).json();
      expect(mine.messages).toHaveLength(0);
      // the status route is what the console banner and window note read
      await expect(a.page.getByTestId('compose-window-notice')).toBeVisible();
    } finally { await a.ctx.close(); }
  });

  test('@E2E-47 a cancelled or failed key prompt is explained, and an unsupported browser is told so', async ({ browser, request }) => {
    const { people } = await seedOrgWithSenders(request, 2);
    const a = await newSenderPage(browser, people[0].token);
    try {
      await a.va.cdp.send('WebAuthn.setUserVerified', { authenticatorId: a.va.authenticatorId, isUserVerified: false });
      await a.page.getByTestId('key-register').click();
      await expect(a.page.getByTestId('civic-error')).toContainText(/cancelled|could not be used/);
      await expect(a.page.getByTestId('key-count')).toContainText('0');
    } finally { await a.ctx.close(); }
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); });
    await openNotify(page, people[1].token, '#/notifications/send');
    await expect(page.getByTestId('key-unsupported')).toBeVisible();
    await expect(page.getByTestId('key-register')).toBeDisabled();
    await ctx.close();
  });

  test.setTimeout(240_000);
  test('@E2E-48 admin: two admins verify an organisation and bind a sender; kill switch blocks the sender; release needs a different admin', async ({ browser, request }) => {
    const adminA = await seedPerson(request, [{ role: 'admin' }]);
    const adminB = await seedPerson(request, [{ role: 'admin' }]);
    const totpA = await enrolAdmin(request, adminA.token);
    const totpB = await enrolAdmin(request, adminB.token);
    const senderLabel = 'snd-' + uniq();
    const senderSeed = await (await request.post(`${API}/e2e/person`, { data: { label: senderLabel } })).json() as { token: string; person_id: string };
    const sender = { token: senderSeed.token, personId: senderSeed.person_id };
    const name = 'E2E Directorate ' + uniq();
    const pa = await newSenderPage(browser, adminA.token, '#/notifications/admin');
    const pb = await newSenderPage(browser, adminB.token, '#/notifications/admin');
    const ps = await newSenderPage(browser, sender.token);
    try {
      // A files the organisation (needs a code); a wrong-length code keeps the button off
      await pa.page.getByTestId('org-name').fill(name);
      await pa.page.getByTestId('org-letter').fill('GO/E2E/' + uniq());
      await pa.page.getByTestId('org-domain').fill('health.gov.in');
      await pa.page.getByTestId('org-contact').fill('desk@health.gov.in');
      await expect(pa.page.getByTestId('org-file')).toBeDisabled();
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      await pa.page.getByTestId('org-file').click();
      await expect(pa.page.getByTestId('adm-msg')).toBeVisible();
      await expect(pa.page.getByTestId('adm-totp-input')).toHaveValue(''); // a code is single use and cleared
      const rowA = pa.page.getByTestId('adm-org').filter({ hasText: name });
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      await rowA.getByTestId('adm-org-verify').click(); // self-verification refused by the server
      await expect(pa.page.getByTestId('civic-error')).toContainText('different');
      // B verifies
      await pb.page.reload();
      const rowB = pb.page.getByTestId('adm-org').filter({ hasText: name });
      await pb.page.getByTestId('adm-totp-input').fill(await totpB.next());
      await rowB.getByTestId('adm-org-verify').click();
      await expect(rowB).toHaveAttribute('data-status', 'verified');
      const orgId = (await publicGet(request, `${N}/senders`).then((r) => r.json())).senders.find((s: { name: string }) => s.name === name).id as string;
      // A binds the sender, B approves
      await pa.page.reload();
      await pa.page.getByTestId('sender-org').selectOption(orgId);
      // the admin finds the person by a label hint: an opaque id, the last digits and roles, never a number or a name
      await pa.page.getByTestId('sender-find').fill(senderLabel);
      await pa.page.getByTestId('sender-find-btn').click();
      const hit = pa.page.getByTestId('adm-person');
      await expect(hit).toHaveCount(1);
      expect(await hit.getAttribute('data-person-id')).toBe(sender.personId);
      await expect(hit).toContainText('number ending');
      expect(await hit.textContent()).not.toMatch(/\+91\d{10}|\b99\d{8}\b/);
      await hit.getByTestId('adm-person-pick').click();
      await expect(pa.page.getByTestId('sender-picked')).toHaveAttribute('data-person-id', sender.personId);
      await pa.page.getByTestId('sender-role').selectOption('department_sender');
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      await pa.page.getByTestId('sender-file').click();
      await expect(pa.page.getByTestId('adm-msg')).toBeVisible();
      await pb.page.reload();
      await pb.page.getByTestId('adm-totp-input').fill(await totpB.next());
      await pb.page.getByTestId('adm-sender').filter({ hasText: name }).getByTestId('adm-sender-approve').click();
      await expect(pb.page.getByTestId('adm-sender').filter({ hasText: name })).toHaveAttribute('data-status', 'active');

      // the sender registers a key and can compose
      await ps.page.reload();
      await registerKey(ps.page);
      // A engages a kill switch for this organisation only
      await pa.page.reload();
      await pa.page.getByTestId('kill-scope').selectOption('org');
      await pa.page.getByTestId('kill-org').selectOption(orgId);
      // a reason of its own: the admin console lists every kill switch, and a parallel run's switch must not be released (or asserted on) by mistake
      const killReason = 'e2e: suspected account takeover ' + uniq();
      await pa.page.getByTestId('kill-reason').fill(killReason);
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      await expect(pa.page.getByTestId('kill-engage')).toBeEnabled({ timeout: 5000 });
      await pa.page.getByTestId('kill-engage').click();
      // (kill-active shows while ANY kill switch is engaged, e.g. a parallel run's: wait for this run's own row)
      await expect(pa.page.getByTestId('adm-kill').filter({ hasText: killReason })).toBeVisible();
      // the public status route shows it (no reason) before the sender tries anything, and the console banner reads it
      const pubStatus = await (await publicGet(request, `${N}/status?state=AP&org_id=${orgId}`)).json();
      expect(pubStatus.kill).toMatchObject({ engaged: true, scope: 'org' });
      expect(JSON.stringify(pubStatus)).not.toContain(killReason);
      await ps.page.reload();
      await expect(ps.page.getByTestId('status-kill')).toContainText('suspended');
      // the sender is stopped and the banner explains it
      await expect(ps.page.getByTestId('compose')).toBeVisible();
      await ps.page.getByTestId('compose-category').selectOption('civic');
      await ps.page.getByTestId('compose-en').fill('Library opens at nine on Monday.');
      await ps.page.getByTestId('compose-te').fill('సోమవారం ఉదయం తొమ్మిదికి గ్రంథాలయం తెరుస్తారు.');
      await ps.page.getByTestId('compose-units').fill('x-' + uniq());
      await ps.page.getByTestId('compose-submit').click();
      await expect(ps.page.getByTestId('kill-banner')).toBeVisible();
      // release: A requests, A cannot approve, B approves
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      const killA = pa.page.getByTestId('adm-kill').filter({ hasText: killReason });
      await killA.getByTestId('kill-release-request').click();
      await expect(killA.getByTestId('kill-release-pending')).toBeVisible();
      await pa.page.getByTestId('adm-totp-input').fill(await totpA.next());
      await killA.getByTestId('kill-release-approve').click();
      await expect(pa.page.getByTestId('civic-error')).toContainText('different');
      await pb.page.reload();
      await pb.page.getByTestId('adm-totp-input').fill(await totpB.next());
      const killB = pb.page.getByTestId('adm-kill').filter({ hasText: killReason });
      await killB.getByTestId('kill-release-approve').click();
      await expect(killB).toHaveAttribute('data-released', '1');
      expect((await (await publicGet(request, `${N}/status?state=AP&org_id=${orgId}`)).json()).kill.engaged).toBe(false);
      // the security keys are listed per sender (no pasted ids) and one is revoked
      await pb.page.reload();
      const srow = pb.page.getByTestId('adm-sender').filter({ hasText: name });
      await srow.getByTestId('adm-keys-show').click();
      await expect(srow.getByTestId('adm-key')).toHaveCount(1);
      await pb.page.getByTestId('adm-totp-input').fill(await totpB.next());
      await srow.getByTestId('cred-revoke').click();
      await expect(srow.getByTestId('adm-key')).toHaveAttribute('data-revoked', '1');
    } finally { await pa.ctx.close(); await pb.ctx.close(); await ps.ctx.close(); }
  });
});

test.describe('accessibility and layout', () => {
  for (const lang of ['en', 'te'] as const) {
    test(`@E2E-57 axe: no critical or serious violations on notification screens (${lang})`, async ({ page, request }) => {
      const me = await seedPerson(request);
      const admin = await seedPerson(request, [{ role: 'admin' }]);
      await enrolAdmin(request, admin.token);
      for (const [token, hash] of [[null, '#/notifications'], [me.token, '#/notifications/inbox'], [me.token, '#/notifications/settings'], [null, '#/notifications/log'], [null, '#/notifications/keys'], [me.token, '#/notifications/send'], [admin.token, '#/notifications/admin']] as const) {
        await page.addInitScript(([t, l]) => { try { localStorage.setItem('pp-lang', l as string); if (t) sessionStorage.setItem('civic-token', t as string); else sessionStorage.removeItem('civic-token'); } catch { /* ignore */ } }, [token, lang]);
        await page.goto('/' + hash);
        await page.reload();
        await expect(page.locator('.notify-root')).toBeVisible();
        await expect(page.locator('.notify-root [role=status]:has-text("Loading"), .notify-root [role=status]:has-text("లోడ్")')).toHaveCount(0);
        const v = (await new AxeBuilder({ page }).include('.notify-root').withTags(TAGS).analyze()).violations.filter((x) => x.impact === 'critical' || x.impact === 'serious');
        expect(v.map((x) => `${hash}: ${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${hash} scrolls sideways`).toBeLessThanOrEqual(1);
        if (lang === 'te') await expect(page.getByTestId('translation-review-note')).toBeVisible();
      }
    });
  }
});
