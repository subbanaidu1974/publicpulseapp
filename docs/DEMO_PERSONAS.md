# Demo personas: sign in without registering (S-166)

For local development, demonstrations and user-acceptance testing. **Never on in production.**

## Turn it on

```powershell
$env:CIVIC_DEMO_PERSONAS = "1"; npm run dev
```

Open the Civic page: a "Demo sign-in" panel lists the personas. One click signs in; there is no phone, email, PIN or registration. The panel and the routes do not exist unless the flag is set.

## Safety

* Needs `CIVIC_DEMO_PERSONAS=1` **and** `NODE_ENV` / `CIVIC_ENV` not `production` **and** a request addressed to `localhost`, `127.0.0.1` or `::1`. Otherwise both routes answer 404.
* Production start-up refuses to run with `CIVIC_DEMO_PERSONAS=1` (`server/civic/guards.ts`), the same as the other dev switches.
* A persona is a real account with real core roles, so the consoles go through the real authorisation path. It has no phone, email or PIN, so it cannot be reached any other way. Every persona row carries the flag `demo`, so any figure builder can exclude them. Demo data must never feed a published result.
* Persona sign-ins and creations are audited (`demo.persona_created`, `demo.login`).

## The personas

| Key | Roles | Notes |
|---|---|---|
| `resident_new` | none | Unverified (T0), inside the 14-day waiting period |
| `resident_verified` | none | Declared a village (T1), past the waiting period: survey-eligible |
| `resident_email_only` | none | No phone: can report issues, not survey-eligible (S-165) |
| `volunteer` | volunteer | Can enrol adults and confirm neighbours |
| `officer` | officer (Demo Department) | |
| `politician` | politician (DEMO) | |
| `moderator`, `journalist`, `geo_reviewer`, `eci_liaison` | the same-named role | |
| `survey_panel` | survey_panel (Demo Panel) | |
| `assist_coordinator`, `assist_reviewer` | the same-named role | Assisted participation stays off unless enabled |
| `admin` | admin | Reads work at once; actions that need step-up MFA still ask for it |

API: `GET /api/v1/civic/demo/personas`, `POST /api/v1/civic/demo/login { persona }` returns `{ token, person, roles, persona }`. Use the token as `Authorization: Bearer <token>`.

## In automated tests

Playwright's web server sets the flag, so specs can sign in as any persona in one call (`e2e/civic-persona-matrix.spec.ts`). The role matrix there checks that each role-gated route answers 200 to the roles that may use it and 403 to everyone else, and 401 without a session. Add a route to its table when you add a role-gated route.

## Which personas the sign-in screen offers

The screen and `GET /demo/personas` list five: Resident, Volunteer, Government officer, Journalist and Platform admin. The other personas in `server/civic/demo.ts` are marked `listed: false`. They are not shown, but `POST /demo/login` still accepts them because automated tests sign in as them (moderator, politician, email-only resident and so on).
