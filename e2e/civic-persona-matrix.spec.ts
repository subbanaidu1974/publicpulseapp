import { test, expect } from '@playwright/test';
import { auth } from './civic-identity-helpers';

/**
 * S-168: the role matrix. Every demo persona is signed in without registration and calls a representative role-gated route of each kind on the
 * real server. A route answers 200 only for the roles that may use it and 403 for everyone else, and 401 without a session. This is the
 * regression net for "who can reach what" and it keeps working as roles and routes are added.
 */
const API = '/api/v1/civic';
const PERSONAS = ['resident_new', 'resident_verified', 'resident_email_only', 'volunteer', 'officer', 'politician', 'moderator', 'journalist', 'geo_reviewer', 'eci_liaison', 'survey_panel', 'assist_coordinator', 'assist_reviewer', 'admin'];

interface Route { path: string; allow: string[]; name: string }
const ROUTES: Route[] = [
  { name: 'admin ops: job status', path: '/ops/jobs', allow: ['admin'] },
  { name: 'admin ops: provider health', path: '/ops/providers', allow: ['admin'] },
  { name: 'admin: role register', path: '/admin/roles', allow: ['admin'] },
  { name: 'admin: officer application queue', path: '/officers/admin/queue', allow: ['admin'] },
  { name: 'admin: notification sender orgs', path: '/notify/admin/orgs', allow: ['admin'] },
  { name: 'moderation: held queue', path: '/issues/moderation/queue', allow: ['moderator', 'admin'] },
  { name: 'volunteer: own enrolments', path: '/identity/volunteer/enrolments', allow: ['volunteer'] },
  { name: 'volunteer: attestation requests', path: '/identity/attest/requests', allow: ['volunteer'] },
];

const tokens: Record<string, string> = {};
test.beforeAll(async ({ request }) => {
  for (const p of PERSONAS) {
    const r = await request.post(`${API}/demo/login`, { data: { persona: p } });
    expect(r.status(), p).toBe(200);
    tokens[p] = (await r.json()).token;
  }
});

test.describe('role matrix over the demo personas (S-168)', () => {
  for (const route of ROUTES) {
    test(`@E2E-195 ${route.name} (${route.path}): allowed for ${route.allow.join(', ')} only`, async ({ request }) => {
      expect((await request.get(`${API}${route.path}`)).status(), 'no session').toBe(401);
      for (const p of PERSONAS) {
        const status = (await request.get(`${API}${route.path}`, { headers: auth(tokens[p]) })).status();
        if (route.allow.includes(p)) expect(status, `${p} should be allowed`).toBe(200);
        else expect(status, `${p} should be refused`).toBe(403);
      }
    });
  }

  test('@E2E-195 every persona can read its own profile with the roles it was given and nothing more', async ({ request }) => {
    const expected: Record<string, string[]> = {
      resident_new: [], resident_verified: [], resident_email_only: [], volunteer: ['volunteer'], officer: ['officer'], politician: ['politician'], moderator: ['moderator'],
      journalist: ['journalist'], geo_reviewer: ['geo_reviewer'], eci_liaison: ['eci_liaison'], survey_panel: ['survey_panel'], assist_coordinator: ['assist_coordinator'],
      assist_reviewer: ['assist_reviewer'], admin: ['admin'],
    };
    for (const p of PERSONAS) {
      const me = await (await request.get(`${API}/identity/me`, { headers: auth(tokens[p]) })).json();
      expect([...me.roles].sort(), p).toEqual(expected[p]);
    }
  });

  test('@E2E-195 a demo session can be signed out, after which it is refused everywhere', async ({ request }) => {
    const r = await (await request.post(`${API}/demo/login`, { data: { persona: 'moderator' } })).json();
    expect((await request.get(`${API}/issues/moderation/queue`, { headers: auth(r.token) })).status()).toBe(200);
    expect((await request.post(`${API}/identity/logout`, { headers: auth(r.token) })).status()).toBe(200);
    expect((await request.get(`${API}/issues/moderation/queue`, { headers: auth(r.token) })).status()).toBe(401);
  });
});
