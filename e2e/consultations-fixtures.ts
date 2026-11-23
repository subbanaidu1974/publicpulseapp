import type { Page } from '@playwright/test';
import { C } from './consultations-helpers';

/**
 * FIXTURES (the only place in the consultation specs that fakes a response). Used for what a real server cannot give on demand:
 *  1. a closing report that is OVERDUE (the due date is closes_at + 30 days and a consultation cannot be created with a past close);
 *  2. server refusals the UI must word properly: rate limit (429 too_many_requests), a window that closed mid-edit (409 consultation_closed)
 *     and a held comment (the moderation lexicon decides; the real path is covered by the server tests).
 * Everything else in the specs runs against the real server.
 */
export async function mockOverdueReport(page: Page, id: string) {
  const state = { status: 'pending', due_at: new Date(Date.now() - 86_400_000).toISOString(), overdue: true };
  await page.route(new RegExp(`${C}/${id}/closing-report$`), (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'report_not_published', code: 'report_not_published', closing_report: state }) }));
  await page.route(new RegExp(`${C}[?]`), async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, consultations: j.consultations.map((x: { id: string }) => (x.id === id ? { ...x, closing_report: state } : x)) } }); });
  await page.route(new RegExp(`${C}/${id}$`), async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, status: 'closed', closing_report: state } }); });
}
export async function mockFeedback(page: Page, id: string, status: number, body: Record<string, unknown>) {
  await page.route(new RegExp(`${C}/${id}/feedback$`), (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}
