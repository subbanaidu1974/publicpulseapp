import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, bearer } from './civic-seed';
import { openCivic } from './civic-helpers';

// S-201: the admin screen for photos people send for a constituency page. Photos are held for review; only an admin sees the queue.
test.describe.configure({ mode: 'serial' });

const jpg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9]),
]);
const meta = (o: Record<string, unknown>) => Buffer.from(JSON.stringify({ state: 'TG', acNo: 1, relationship: 'party office', claimedName: 'Review Tester', holder: 'Photo: Review Tester', contact: 'review.tester@example.org', consent: true, ...o })).toString('base64');
async function adminToken(request: APIRequestContext): Promise<string> {
  return (await (await request.post(`${API}/demo/login`, { data: { persona: 'admin' } })).json()).token as string;
}
async function decideAll(request: APIRequestContext, token: string, status: 'approved' | 'rejected') {
  const l = await (await request.get(`${API.replace('/civic', '')}/photos/admin/submissions`, { headers: bearer(token) })).json();
  for (const s of l.submissions ?? []) await request.post(`${API.replace('/civic', '')}/photos/admin/submissions/${s.id}/decide`, { headers: bearer(token), data: { status } });
}

test.describe('photo review screen (S-201)', () => {
  test('@E2E-208 the queue needs an admin; an admin sees the sender, the winner and the picture, approves it, and the photo appears and can be withdrawn', async ({ page, request }) => {
    const root = API.replace('/civic', '');
    const token = await adminToken(request);
    await decideAll(request, token, 'rejected'); // start from an empty queue
    try {
      // anyone can send; nobody but an admin can read the queue
      const sent = await request.post(`${root}/photos/submissions`, { headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Meta': meta({}) }, data: jpg });
      expect(sent.status()).toBe(201);
      expect((await request.get(`${root}/photos/admin/submissions`)).status()).toBe(401);

      await openCivic(page);
      await page.getByTestId('demo-admin').click();
      await expect(page.getByTestId('civic-signed-in')).toBeVisible();
      await page.getByTestId('civic-tab-roles').click();
      await page.getByTestId('console-tab-admin').click();
      const review = page.getByTestId('photo-review');
      await expect(review).toBeVisible();
      await expect(review.getByTestId('pr-warning')).toContainText(/no automatic identity check/i);
      const item = review.getByTestId('pr-item').first();
      await expect(item.getByTestId('pr-claimed')).toHaveText('Review Tester');
      await expect(item.getByTestId('pr-contact')).toContainText('review.tester@example.org'); // the admin sees the private contact
      await expect(item.getByTestId('pr-winner')).not.toBeEmpty();
      await expect(item.locator('img')).toHaveCount(1); // the picture is fetched with the admin sign-in (the test file is not a decodable image, so only its presence is checked)
    } finally { /* nothing to undo: the queue is emptied at the end */ }
    // not shown to visitors while pending
    expect(((await (await request.get(`${root}/photos/index.json`)).json()).photos as { origin?: string }[]).some((p) => p.origin === 'upload')).toBe(false);

    const review = page.getByTestId('photo-review');
    await review.getByTestId('pr-note').first().fill('Checked with the contact');
    await review.getByTestId('pr-approve').first().click();
    await expect(review.getByTestId('pr-msg')).toContainText(/Approved/);
    expect(((await (await request.get(`${root}/photos/index.json`)).json()).photos as { origin?: string }[]).some((p) => p.origin === 'upload')).toBe(true);
    await review.getByTestId('pr-status').selectOption('approved');
    await expect(review.getByTestId('pr-item').first().getByTestId('pr-state')).toContainText('Approved');
    await review.getByTestId('pr-withdraw').first().click();
    await expect(review.getByTestId('pr-msg')).toContainText(/not shown/i);
    expect(((await (await request.get(`${root}/photos/index.json`)).json()).photos as { origin?: string }[]).some((p) => p.origin === 'upload')).toBe(false);
    await decideAll(request, token, 'rejected');
  });
});
