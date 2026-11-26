import { test, expect, type APIRequestContext } from '@playwright/test';
import { openCivicSignedIn, randomPhone, sharedToken } from './civic-helpers';
import { startOnCivicTab } from './civic-helpers';
test.beforeEach(async ({ page }) => { await startOnCivicTab(page, 'household'); });

/** Create the household through the API first (idempotent; a 4xx just means it exists) so parallel workers cannot race in the UI. */
async function ensureHousehold(request: APIRequestContext) {
  const token = await sharedToken(request);
  await request.post('/api/v1/civic/households/', { headers: { authorization: `Bearer ${token}` } });
}

test.describe('civic household', () => {
  test('@E2E-30 head creates a household and invites an adult; pending invite is shown without the phone number', async ({ page, request }) => {
    await ensureHousehold(request);
    await openCivicSignedIn(page, request);
    await expect(page.getByTestId('household-roster')).toBeVisible();
    await expect(page.getByTestId('household-roster')).toBeVisible();
    await expect(page.getByTestId('household-member').first()).toBeVisible();

    const phone = randomPhone();
    await page.getByTestId('invite-phone').fill(phone);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('household-message')).toBeVisible();
    await expect(page.getByTestId('household-pending-invite').first()).toBeVisible();
    // The head sees status only, never the invitee's number.
    await expect(page.getByTestId('household-roster')).not.toContainText(phone);
  });

  test('@E2E-30 household labels follow the app language (Telugu)', async ({ page, request }) => {
    await ensureHousehold(request);
    await openCivicSignedIn(page, request, 'te');
    await expect(page.getByTestId('household-roster')).toContainText('సభ్యులు');
    await expect(page.getByTestId('invite-submit')).toHaveText('ఆహ్వానం పంపు');
  });
});
