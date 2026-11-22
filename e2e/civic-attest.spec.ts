import { test, expect } from '@playwright/test';
import { randomPhone } from './civic-helpers';
import { auth, openCivicAs, seedPerson } from './civic-identity-helpers';

const API = '/api/v1/civic/identity';

/** A T1 person (residence declared) that a volunteer can see in the attestation queue. */
async function subject(request: Parameters<typeof seedPerson>[0], label: string) {
  const s = await seedPerson(request, [], label);
  const r = await request.post(`${API}/residence`, { headers: auth(s.token), data: { residence: 'Kolluru, Bapatla, Guntur, AP', unit_id: 'v-test' } });
  expect(r.ok()).toBeTruthy();
  return s;
}

test.describe('civic volunteer attestation and enrolment (real routes; volunteer role seeded)', () => {
  test('@E2E-149 volunteer sees a pending request, the two-volunteer rule is explained, confirming reports progress', async ({ page, request }) => {
    const label = 'Lakshmi' + Math.floor(Math.random() * 1e6);
    await subject(request, label);
    const vol = await seedPerson(request, [{ role: 'volunteer' }]);
    await openCivicAs(page, vol.token, 'en');
    await expect(page.getByTestId('attestation')).toBeVisible();
    await expect(page.getByTestId('att-two')).toContainText(/two different volunteers/);
    await expect(page.getByTestId('att-two')).toContainText(/different SIM cards/);
    const row = page.getByTestId('att-request').filter({ hasText: label });
    await expect(row).toBeVisible();
    await row.getByTestId('att-confirm').click();
    await expect(page.getByTestId('att-done')).toContainText(/1$/);
    await expect(page.getByTestId('att-request').filter({ hasText: label })).toHaveCount(0);
  });

  test('@E2E-149 confirming the same person twice is explained; a non-volunteer is told only volunteers can confirm', async ({ page, request }) => {
    const s = await subject(request, 'Twice');
    const vol = await seedPerson(request, [{ role: 'volunteer' }]);
    expect((await request.post(`${API}/attest`, { headers: auth(vol.token), data: { person_id: s.personId } })).ok()).toBeTruthy();
    await openCivicAs(page, vol.token, 'en');
    await page.getByTestId('att-manual').fill(s.personId);
    await page.getByTestId('att-manual-confirm').click();
    await expect(page.getByTestId('civic-error')).toContainText(/cannot confirm the same person twice/);
    // A plain citizen does not get the volunteer screen (and the server refuses the list).
    const plain = await seedPerson(request);
    expect((await request.get(`${API}/attest/requests`, { headers: auth(plain.token) })).status()).toBe(403);
  });

  test('@E2E-149 enrolling an adult never asks for a PIN; the server refuses one; my enrolments list can cancel', async ({ page, request }) => {
    const vol = await seedPerson(request, [{ role: 'volunteer' }]);
    const bad = await request.post(`${API}/volunteer/enrol`, { headers: auth(vol.token), data: { phone: '+91' + randomPhone(), context: 'household', pin: '4821' } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).code).toBe('pin_not_allowed');

    await openCivicAs(page, vol.token, 'te');
    await expect(page.getByTestId('attestation')).toContainText('ఇద్దరు వేర్వేరు వాలంటీర్లు');
    await expect(page.getByTestId('attestation').locator('input[type=password]')).toHaveCount(0);
    const req = page.waitForRequest((r) => r.url().endsWith('/volunteer/enrol'));
    await page.getByTestId('enrol-phone').fill(randomPhone());
    await page.getByTestId('enrol-context').selectOption('shg');
    await page.getByTestId('enrol-label').fill('SK');
    await page.getByTestId('enrol-send').click();
    const sent = (await req).postDataJSON();
    expect(Object.keys(sent).sort()).toEqual(['context', 'label', 'phone']);
    expect(sent.context).toBe('shg');
    await expect(page.getByTestId('enrol-sent')).toBeVisible();
    await expect(page.getByTestId('enrol-row').first()).toContainText('SK');
    await page.getByTestId('enrol-cancel').first().click();
    await expect(page.getByTestId('enrol-row').first()).toContainText('రద్దు');
  });

  test('@E2E-149 adult activates on their own device: ?activate= prefills the code; OTP and own PIN are sent (fixture: the SMS cannot be read back)', async ({ page, request }) => {
    const { token } = await seedPerson(request);
    let sent: Record<string, unknown> | null = null;
    await page.route('**/identity/activate', async (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ token, person: { id: 'x', tier: 'T0' } }) });
    });
    await page.addInitScript(() => { try { localStorage.setItem('pp-lang', 'en'); } catch { /* ignore */ } });
    await page.goto('/?activate=ABCD-EFGH');
    await expect(page.getByTestId('activate-flow')).toBeVisible();
    await expect(page.getByTestId('act-code')).toHaveValue('ABCD-EFGH');
    await expect(page.getByTestId('activate-flow')).toContainText(/never know it/);
    await page.getByTestId('act-otp').fill('123456');
    await page.getByTestId('act-pin').fill('7302');
    await page.getByTestId('act-submit').click();
    await expect(page.getByTestId('civic-signed-in')).toBeVisible();
    expect(sent).toEqual({ code: 'ABCD-EFGH', otp: '123456', pin: '7302' });
    expect(page.url()).not.toContain('activate=');
  });

  test('@E2E-149 activation with a wrong code (real server) is explained', async ({ page }) => {
    await page.goto('/?activate=NOPE-NOPE');
    await page.getByTestId('act-otp').fill('000000');
    await page.getByTestId('act-pin').fill('7302');
    await page.getByTestId('act-submit').click();
    await expect(page.getByTestId('civic-error')).toBeVisible();
  });
});
