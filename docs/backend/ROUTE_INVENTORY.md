# Route inventory (generated)

Generated from the route declarations in `server/` by `npm run backend:contract` (scripts/route-inventory.ts). It lists what exists today; it is the baseline the backend stories must keep working (or version) when the database moves to MySQL. Do not edit by hand: `tests/backend/routeInventory.test.ts` fails when this file and the code disagree.

Total: 357 routes in 21 groups.

## Admin and audit (14)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/breakglass/requests` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/breakglass/requests` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/breakglass/requests/:id/approve` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/breakglass/requests/:id/deny` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/breakglass/requests/:id/export` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/entries` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/head` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/me` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/mfa/confirm` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/mfa/enrol` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| POST | `/mfa/verify` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/roles` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/summary` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |
| GET | `/verify` | `/api/v1/civic/admin (and /audit)` | `server/civic/admin/routes.ts` |

## Assisted participation (26)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/alerts` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/areas/:lgd/resume` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/areas/:lgd/suspend` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/areas/holds` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/delete-requests` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/delete-requests` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/delete-requests/:id/approve` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/delete-requests/:id/reject` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/my-pair` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/pairs` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/pairs` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/pairs/:id/records` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/pairs/:id/reinstate` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/pairs/:id/reinstate-request` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/pairs/:id/suspend` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/receipts/delete` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/receipts/report` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/receipts/status` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/rechecks` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/rechecks/:id` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/records` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/segment` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| GET | `/switch` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/switch/requests` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/switch/requests/:id/approve` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |
| POST | `/switch/requests/:id/reject` | `/api/v1/civic/assisted` | `server/civic/assisted/routes.ts` |

## Bill consultations (32)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/:id/comments` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| POST | `/:id/comments/:fid/moderate` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| GET | `/:id/comments/held` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| POST | `/:id/feedback` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| GET | `/:id/figures` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| GET | `/:id/mine` | `/api/v1/civic/consultations` | `server/civic/consultations/feedback.ts` |
| GET | `/` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/:id` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| PATCH | `/:id` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/audio/review` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/:id/clauses/:n` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/close` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/corrections` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/:id/log` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/panel/review` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/publish` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| POST | `/:id/submit` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/:id/versions/:n` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/mine` | `/api/v1/civic/consultations` | `server/civic/consultations/registry.ts` |
| GET | `/:id/analyst` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| GET | `/:id/closing-report` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| GET | `/:id/closing-report/preview` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/closing-report/publish` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/closing-report/responses` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/complete` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/review/comments` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/review/run` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/themes` | `/api/v1/civic/consultations` | `server/civic/consultations/report.ts` |
| POST | `/:id/audio/upload` | `/api/v1/civic/consultations` | `server/civic/consultations/staff.ts` |
| GET | `/:id/clauses/:n/audio/:group` | `/api/v1/civic/consultations` | `server/civic/consultations/staff.ts` |
| GET | `/:id/corrections` | `/api/v1/civic/consultations` | `server/civic/consultations/staff.ts` |

## Broadcast polls (6)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/:id/answer` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |
| GET | `/admin` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |
| POST | `/admin` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |
| POST | `/admin/:id/close` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |
| GET | `/admin/:id/results` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |
| GET | `/pending` | `/api/v1/civic/broadcast` | `server/civic/broadcast/index.ts` |

## demo.ts (2)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/login` | `/api/v1/civic/demo (dev only)` | `server/civic/demo.ts` |
| GET | `/personas` | `/api/v1/civic/demo (dev only)` | `server/civic/demo.ts` |

## e2e-seed.ts (3)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/notify/org` | `/api/v1/civic/e2e (test only)` | `server/civic/e2e-seed.ts` |
| POST | `/notify/sender` | `/api/v1/civic/e2e (test only)` | `server/civic/e2e-seed.ts` |
| POST | `/person` | `/api/v1/civic/e2e (test only)` | `server/civic/e2e-seed.ts` |

## Geography (5)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/hamlets/:id/${decision}` | `/api/v1/civic/geo` | `server/civic/geo/routes.ts` |
| GET | `/hamlets/review` | `/api/v1/civic/geo` | `server/civic/geo/routes.ts` |
| GET | `/search` | `/api/v1/civic/geo` | `server/civic/geo/routes.ts` |
| GET | `/units/:lgd` | `/api/v1/civic/geo` | `server/civic/geo/routes.ts` |
| GET | `/village/:lgd/constituency` | `/api/v1/civic/geo` | `server/civic/geo/routes.ts` |

## Government notifications (44)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/admin/credentials` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/credentials/:id/revoke` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/admin/kill` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/kill` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/kill/:id/release-approve` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/kill/:id/release-request` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/admin/orgs` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/orgs` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/orgs/:id/reject` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/orgs/:id/verify` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/admin/people` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/admin/senders` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/senders` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/senders/:id/approve` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/senders/:id/reject` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/admin/senders/:id/revoke` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/antiphish` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| PUT | `/antiphish` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/block-log` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| DELETE | `/devices` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/devices` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/devices` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/inbox` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/inbox/:id/read` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/keys` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/messages` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/messages/:id` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages/:id/approve` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages/:id/cancel` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages/:id/challenge` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages/:id/send` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/messages/lint` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/policy` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/prefs` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| PUT | `/prefs` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/sender/me` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/senders` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/senders/:org_id/log` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/status` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| GET | `/templates` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/unsubscribe` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/webauthn/register/options` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |
| POST | `/webauthn/register/verify` | `/api/v1/civic/notify` | `server/civic/notify/routes.ts` |

## Households (18)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| DELETE | `/` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/consents` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/dependents` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| GET | `/grievance-officer` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| GET | `/invites/:inviteId/notice` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/invites/accept` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/invites/decline` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/invites/report-not-agreed` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| DELETE | `/members/:id` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/members/invite` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| GET | `/mine` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| GET | `/notices/:purpose` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/transfer-head` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/transfer-head/accept` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/transfer-head/cancel` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/transfer-head/decline` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |
| POST | `/volunteer/enrol` | `/api/v1/civic/households` | `server/civic/households/routes.ts` |

## Identity and sessions (29)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/login/email` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/phone/add` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/pin/recover/email` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/pin/recover/email/request` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/signup/email/request` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/signup/email/verify` | `/api/v1/civic/identity` | `server/civic/identity/email.ts` |
| POST | `/activate` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/attest` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/attest/requests` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/login` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/logout` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| DELETE | `/me` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/me` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/pin/change` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/pin/recover` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/pin/recover/request` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/residence` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/sessions` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| DELETE | `/sessions/:id` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/sessions/:id/revoke` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/signup/request` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/signup/verify` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/sim/link` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/sim/members` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/volunteer/enrol` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/volunteer/enrolments` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/volunteer/enrolments/:id/cancel` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| GET | `/volunteer/rechecks` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |
| POST | `/volunteer/rechecks/:id/result` | `/api/v1/civic/identity` | `server/civic/identity/routes.ts` |

## index.ts (3)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/degraded` | `/api/v1/civic` | `server/civic/index.ts` |
| GET | `/ops/jobs` | `/api/v1/civic` | `server/civic/index.ts` |
| GET | `/ops/providers` | `/api/v1/civic` | `server/civic/index.ts` |

## Issues (citizen reports) (27)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/:id` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/appeal` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/confirm` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/escalate` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/me-too` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/moderate` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/rebuttal` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/:id/transition` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/categories` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/export` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/feed` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/media` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/media/:id` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/metrics` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/mine` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/mine/:id` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/moderation/lexicon` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/moderation/lexicon` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/moderation/lexicon/:id/review` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/moderation/lexicon/changes` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/moderation/lexicon/changes` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| POST | `/moderation/lexicon/changes/:id/review` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/moderation/metrics` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/moderation/queue` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |
| GET | `/officer/queue` | `/api/v1/civic/issues` | `server/civic/issues/routes.ts` |

## Media hub (news, live, reports) (17)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/admin/numbers` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/admin/reports` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/reports/:id/resolve` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/admin/sources` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources/:id/check` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources/:id/disable` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources/:id/enable` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources/:id/permission` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/sources/:id/refresh` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/admin/videos` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/click` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/demo-videos` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/live` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/news` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| GET | `/preview` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |
| POST | `/report` | `/api/v1/civic/media` | `server/civic/mediahub/index.ts` |

## Officer onboarding (10)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/admin/applications/:id/letter` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/admin/applications/:id/reject` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/admin/applications/:id/verify` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| GET | `/admin/queue` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/applications` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/applications/:id/email/confirm` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/applications/:id/email/resend` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| POST | `/applications/:id/withdraw` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| GET | `/applications/mine` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |
| GET | `/domains` | `/api/v1/civic/officers` | `server/civic/officers/index.ts` |

## Phone channels (missed call, IVR, voice note) (3)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/ivr` | `/api/v1/civic/channels` | `server/civic/channels/routes.ts` |
| POST | `/missed-call` | `/api/v1/civic/channels` | `server/civic/channels/routes.ts` |
| POST | `/voice-note` | `/api/v1/civic/channels` | `server/civic/channels/routes.ts` |

## providers (1)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| POST | `/` | `/api/v1/civic/channels/sms-receipt` | `server/civic/providers/sms.ts` |

## Public data and ops (74)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/analytics/candidates/:state` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/analytics/compare/:state` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/analytics/panchayat/:state` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/analytics/panchayat/:state/trends` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/analytics/panchayat/:state/units` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/analytics/parties/:state` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/byelections` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/elections` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/elections/:state/summary` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/elections/:state/turnout` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/history/:state` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/party-switches` | `/api/v1 (public)` | `server/analytics-api.ts` |
| GET | `/census/:state/districts` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/data-status` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/data-status/admin` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/election-window` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/elections` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/elections/:state/forecast` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/elections/:state/marginal` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/elections/:state/summary` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/elections/:state/swing` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/health` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/states` | `/api/v1 (public)` | `server/api.ts` |
| GET | `/basemap/${BASEMAP_NAME}` | `/ (static map)` | `server/basemap.ts` |
| GET | `/:state/ac/:acNo` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/:state/index` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/:state/latest` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/:state/review` | `/api/v1/countday` | `server/countday/router.ts` |
| POST | `/:state/review/:id/approve` | `/api/v1/countday` | `server/countday/router.ts` |
| POST | `/:state/review/:id/reject` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/:state/snapshots/:seq` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/keys` | `/api/v1/countday` | `server/countday/router.ts` |
| GET | `/constituencies/:state/:acNo` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/elections/:state/split-voting` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/electors/:state` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/:file(ac|pc|district|mandal).geojson` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/places.json` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/places/:level/:code` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/polling-stations` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/search` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/units` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/village-labels.json` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/village-points` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/geo/:state/village-polygons` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/photos/:file` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/photos/index.json` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/photos/leaders.json` | `/api/v1 (public)` | `server/geo-api.ts` |
| GET | `/history/constituency/:state/:acNo` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/history/datasets` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/history/elections` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/history/office-holders` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/history/party/:id/seats-over-time` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/history/revisions` | `/api/v1 (public)` | `server/history/api.ts` |
| GET | `/api/v1/degraded` | `/ (ops)` | `server/obs.ts` |
| GET | `/healthz` | `/ (ops)` | `server/obs.ts` |
| GET | `/metrics` | `/ (ops)` | `server/obs.ts` |
| GET | `/readyz` | `/ (ops)` | `server/obs.ts` |
| GET | `/contestants` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/contestants/:id` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/members/:state` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/members/:state/:type/:acNo` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/office-holders` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/parties` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/parties/:code` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/people/admin/requests` | `/api/v1 (public)` | `server/people-api.ts` |
| POST | `/people/admin/requests/:id/resolve` | `/api/v1 (public)` | `server/people-api.ts` |
| POST | `/people/admin/takedowns` | `/api/v1 (public)` | `server/people-api.ts` |
| POST | `/people/requests` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/people/status` | `/api/v1 (public)` | `server/people-api.ts` |
| GET | `/photos/admin/submissions` | `/api/v1 (public)` | `server/photo-submissions.ts` |
| POST | `/photos/admin/submissions/:id/decide` | `/api/v1 (public)` | `server/photo-submissions.ts` |
| GET | `/photos/admin/submissions/:id/file` | `/api/v1 (public)` | `server/photo-submissions.ts` |
| POST | `/photos/submissions` | `/api/v1 (public)` | `server/photo-submissions.ts` |
| GET | `/data-freshness` | `/api/v1 (ops)` | `server/refresh.ts` |

## Pulse surveys (19)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/:id/credential/eligibility` | `/api/v1/civic/surveys` | `server/civic/surveys/credential.ts` |
| GET | `/:id/credential/key` | `/api/v1/civic/surveys` | `server/civic/surveys/credential.ts` |
| POST | `/:id/credential/request` | `/api/v1/civic/surveys` | `server/civic/surveys/credential.ts` |
| POST | `/:id/respond` | `/api/v1/civic/surveys` | `server/civic/surveys/credential.ts` |
| GET | `/` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/:id` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| PATCH | `/:id` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/:id/cancel` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/:id/close` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/:id/open` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/:id/panel/review` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| POST | `/:id/submit` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/:id/versions/:n` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/mine` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/quota` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/registry/log` | `/api/v1/civic/surveys` | `server/civic/surveys/registry.ts` |
| GET | `/:id/results` | `/api/v1/civic/surveys` | `server/civic/surveys/results.ts` |
| GET | `/:id/results/method` | `/api/v1/civic/surveys` | `server/civic/surveys/results.ts` |

## Representatives (8)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/issues/:id/grievance` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| POST | `/issues/:id/grievance` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| POST | `/issues/:id/reply` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| GET | `/issues/:id/reply/mine` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| POST | `/issues/:id/reply/revise` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| GET | `/moderation/queue` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| POST | `/replies/:id/review` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |
| GET | `/schemes` | `/api/v1/civic/representatives` | `server/civic/representatives/index.ts` |

## Role dashboards (6)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/audit/summary` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |
| GET | `/export` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |
| GET | `/issues/summary` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |
| GET | `/me` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |
| GET | `/surveys/summary` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |
| GET | `/units` | `/api/v1/civic/scope` | `server/civic/scope/routes.ts` |

## Video broadcasts (10)

| Method | Path (relative to mount) | Mount | Source |
|---|---|---|---|
| GET | `/` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/:id/view` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| GET | `/admin` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin/:id/approve` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin/:id/recall` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin/:id/reject` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| GET | `/admin/windows` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin/windows` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |
| POST | `/admin/windows/:id/end` | `/api/v1/civic/videocast` | `server/civic/videocast/index.ts` |

