# Civic data stores (S-74, E2E-89)

The civic data is four **separate SQLite databases**, each with its own file, migration runner, backup and erasure. Nothing joins across them: no `ATTACH`, no SQL statement that names tables of two stores. When a feature needs data from two stores it reads each store on its own and combines the results in code (`tests/civic/stores.test.ts` enforces this).

This is DESIGN_2028 section 3.8 item 3 and RELEASE_GATE row 5. Read the "what this does not give you" section before relying on it.

```
                         key provider (HMAC / AES-GCM, purpose-bound)
                                       |
   +------------------+   pseudonym    |    +------------------+
   | identity store   | -------------- | -> | issues store     |
   | persons, roles,  |  (HMAC only,   |    | issue, me_too,   |
   | sessions, otps,  |   no id)       |    | events, media,   |
   | households,      |                |    | moderation, geo, |
   | enrolments,      | <- issue_links |    | ivr_call         |
   | officer_role,    |  (encrypted)   |    | NO persons.id    |
   | has_responded,   |                |    +------------------+
   | issue_links,     |                |
   | erasure_outbox   |                |    +------------------+
   +------------------+                |    | survey store     |  Phase 2 placeholder:
                                       |    | survey_meta      |  responses will carry
   +------------------+                |    +------------------+  no person id
   | audit store      | <- audit() from every module (append only, hash chain)
   | audit_log,       |
   | audit_anchors    |
   +------------------+
```

## Layout

| Store | Tables | Notes |
|---|---|---|
| identity | `persons`, `sessions`, `consents`, `roles`, `otps`, `rate_events`, `attestations`, `has_responded`, `survey_closures`, `pin_failures`, `enrolments`, `hh_*` (households), `admin_mfa*`, `role_requests`, `officer_role`, `officer_application` (S-141), `people_requests`, `people_takedowns`, `store_meta`, `issue_links`, `erasure_outbox` | The historical single database. `getDb()` still returns it. `has_responded` stays here (turnout counts, "has this person answered"); survey answers never come here. |
| issues | `issue`, `issue_me_too`, `issue_event`, `issue_sample`, `issue_appeal`, `officer_rebuttal`, `moderation_action`, `lexicon_change`, `issue_media`, `admin_unit`, `hamlet`, `village_constituency`, `ivr_call`, `rep_reply`, `grievance_link` (S-145; author and requester are keyed pseudonyms), `assist_pair`, `assisted_record`, `assist_recheck`, `assisted_switch_request` (S-49; assistants, coordinators, reviewers and admins are actor pseudonyms; no identifier of the assisted person; the receipt code is stored only as a keyed hash under purpose `assist-receipt`), plus the `issue.channel` column | Holds **no `persons.id`**. Columns still called `person_id` / `reporter_id` / `actor_id` / `owner_id` hold keyed pseudonyms. |
| survey | `survey_meta` | Placeholder with its own file and migration runner so Phase 2 can add response tables. Responses must carry no person id. |
| audit | `audit_log`, `audit_anchors` | The hash chain, in a file that a compromise of another store cannot rewrite. Still anchored externally (`CIVIC_ANCHOR_URL`). |

The authoritative list is `STORE_TABLES` in `server/civic/core/stores.ts`. A table that is not on it fails the placement test; a known table found in the wrong store fails `migrate()`.

Decisions worth knowing:

- **Assisted participation** (S-49): the four tables above hold only actor pseudonyms. Account erasure of an assistant, coordinator, reviewer or admin blanks their pseudonyms (hook `assisted.pseudonyms`) and suspends a pair that loses a member; records, outcomes and receipt hashes remain because they name nobody. A person's deletion request by receipt erases the words and keeps a stub.
- **officer_role** (the Phase 1 officer/moderator claim stub) and **roles** are keyed to persons, so they live in identity. The issues service asks identity "is this person an officer here" and only ever writes pseudonyms into issue rows.
- **Geography** (`admin_unit`, `hamlet`, `village_constituency`) is public reference data used by issues and IVR; it is in the issues store, not identity.
- **IVR call state** (`ivr_call`) is in the issues store but holds person ids (caller, adults on a SIM). They are stored **encrypted** (`ivr-call-person`) and matched for erasure through keyed pseudonyms in `person_keys`; there is no plain id. Rows expire after 15 minutes.
- **people_requests / people_takedowns** (corrections and takedown requests for public people pages) have no person ids; they stay in identity by default (it is the store that already holds contact details).
- **audit** is its own store, not a table of identity, so that rewriting identity does not rewrite the evidence.

## Files and environment

| Variable | Meaning |
|---|---|
| `CIVIC_DB` | Base path (default `data/civic.db`; `:memory:` under vitest). Used to derive the four store files when they are not set explicitly. A directory (existing, or ending in `/`) gives `<dir>/identity.db` etc. |
| `CIVIC_IDENTITY_DB`, `CIVIC_ISSUES_DB`, `CIVIC_SURVEY_DB`, `CIVIC_AUDIT_DB` | Explicit file per store; override the derived name. Put them on different volumes to separate access. `:memory:` works for all four. |

Derivation: `data/civic.db` becomes `data/civic.identity.db`, `data/civic.issues.db`, `data/civic.survey.db`, `data/civic.audit.db`.

## API (server/civic/core)

- `getStore("identity" | "issues" | "survey" | "audit")` returns that store's `node:sqlite` handle. `getDb()` is `getStore("identity")` (backward compatible).
- `registerMigration(id, sql, store = "identity")`: migrations are registered per store; each store has its own `migrations` table with checksum/drift detection (`CIVIC_ALLOW_DRIFT=1` overrides) and its own pre-migrate copy (`backups/pre-migrate-<store>-<ts>.db`).
- `migrate()` migrates all four, runs the placement check (`assertStorePlacement()`), then the one-time legacy import. `migrationStatus()` sums the stores and adds `stores: {identity, issues, survey, audit}`.
- `runInTransaction(fn)` is an **identity** transaction; `runInStore(store, fn)` is a transaction of one store. A transaction never spans two stores.
- `audit()` called inside a transaction is **held** and written to the audit store just before the outermost transaction commits: a rollback discards it, and an action never commits without its audit row (a failing audit write rolls the action back). The only gap the split leaves is a crash between the audit commit and the action commit: a spurious audit row, never a missing one.
- `pingStores()` for readiness.

## Pseudonymous reporter link

The issues store refers to people only through keyed HMACs (`server/civic/core/pseudonyms.ts`, key purpose `reporter-pseudonym` / `actor-pseudonym`):

| Value | Derived from | Used for |
|---|---|---|
| `reporterPseudonym(issueId, personId)` | one per (issue, person) | `issue.reporter_id`, `issue_me_too`, `issue_sample`, `issue_appeal` of that issue. Reporter, supporter and sampled neighbour of the same issue share it (so "is this the reporter" and uniqueness work); two issues of one person do not share it. |
| `mediaOwnerPseudonym(mediaId, personId)` | one per upload | `issue_media.owner_id` (the upload exists before the issue does) |
| `actorPseudonym(personId)` | one per staff member | `moderation_action`, `lexicon_change`, `officer_rebuttal.author_id`; stable so dual control (proposer is not reviewer) and moderator accountability work |
| `ivrPseudonym(personId)` | one per person | matching `ivr_call` rows for erasure |

Limits that move to identity because the issues store cannot count a person across issues: the per-person daily me-too cap and the daily media upload quota use identity `rate_events`.

The way back is `identity.issue_links(person_id, link_key, kind, ref_enc, village_lgd, ts)`: `link_key` is a different keyed hash and `ref_enc` is the object id **encrypted** (`issue-link`), so no value in it equals anything in the issues store and no SQL join is possible even with both files open. It serves "my issues" (`myIssueIds`), erasure, and neighbour sampling by village (`village_lgd` is the village of the issues the person **reported**).

## Retention and erasure per store

- identity: `purgeExpired` job (OTPs, sessions, rate counters, stale PIN sources, phone copies and residence after the retention window).
- issues: `sweep` job and `purgeExpiredMedia` (media retention, exact GPS expiry, IVR call state). Public issue text is a public record until taken down.
- audit: never deleted; erasure redacts the clear actor/object/meta of rows naming the person (the chain still verifies).

**Account deletion across stores** (`deleteAccount`):

1. One identity transaction (all or nothing): read the person's pseudonyms from `issue_links`, run every identity hook, wipe the person row, delete the links, and write an `erasure_outbox` row holding the pseudonyms.
2. After commit: the issues-store hooks unlink those pseudonyms (reporter set to `erased`, exact GPS dropped, me-too rows pseudonymised, samples deleted, appeals blanked, moderation and lexicon actors erased, media files deleted, IVR rows deleted) in ONE issues transaction, then the audit rows naming the person are redacted, then the outbox row is deleted.
3. Every step is idempotent. If step 2 fails (issues file locked, disk full) the response says `pending_cross_store: true`, the outbox row keeps `attempts` and `last_error`, and the `retryErasureOutbox` job (every 5 minutes) finishes it. The identity data is already gone, and what is left in the issues store is a keyed pseudonym that nothing in identity can resolve any more (the link was deleted in step 1).

Hook kinds (`server/civic/core`): `registerErasureHook` (identity, receives the person id), `registerErasureSubjects` (returns the person's pseudonyms, read before the identity hooks run), `registerStoreErasureHook(store, name, fn(subjects))`.

## Backup and restore

`createBackup` writes four encrypted files and one manifest per run (`civic-<ts>.<store>.db.enc`, `civic-<ts>.manifest.json`); `restoreBackupSet` decrypts them; `restoreDrill` restores to a temp directory, compares row counts per store, checks table placement and verifies the audit chain. See `docs/RUNBOOK.md`.

## One-time import of a pre-split database

When `CIVIC_DB` names an existing regular file that is not a store file (the single `civic.db` of the earlier release), the first `migrate()`:

1. creates the four stores, then copies each table into its store, **one transaction per store** (audit, then issues, then identity), with `INSERT OR IGNORE`;
2. replaces every person id in issue tables by its pseudonym and writes the matching `issue_links` rows; IVR rows get encrypted person ids; audit rows are copied verbatim, so the hash chain still verifies; `rate_events` are transient and not copied;
3. writes `store_meta.legacy_import` (file, size, mtime, row counts) **last**, appends an audit entry, and makes the old file **read-only** (`chmod 0444`); it is never written to again and never read again once recorded;
4. is idempotent: a crash before step 3 just repeats the import; a restart afterwards does nothing.

The legacy file must be at the schema of the release before the split (`otps.purpose`, `roles.department`, `sessions.id`); an older file makes startup fail with a message to run the previous release once. A `CIVIC_DB` file that is not a civic database (no `persons` table) is left alone. After you have verified the new stores, the old file can be archived or deleted by an operator.

## What this does not give you

- **One host, one volume, one key provider, one operator** in the pilot. Whoever controls the host and the keys can read all four files and rejoin them: the pseudonym is a keyed HMAC and the link ledger is encrypted under the same provider. Separate volumes or hosts, per-store credentials and a KMS/HSM adapter are what turn this from separate files into separate trust domains.
- **Content identifies people.** Free-text issue descriptions, voice notes and photos can identify a reporter without any id; the issues store stays sensitive even without person ids.
- **Not atomic across stores.** Backups of the four files are taken one after the other, and account erasure is staged (above). Both are designed so that a partial state is safe (a spurious audit row; a pseudonym that nothing resolves).
- **Pseudonyms are keyed, not random.** Rotating the key provider's HMAC key invalidates the mapping; a rotation needs a re-pseudonymisation migration that holds both old and new keys.
- The `issue_links` village column and `persons.residence_unit` are plaintext in identity (coarse, used for sampling and eligibility).

The local **history store** (public election/people/geo history, `data/history.db`) is not one of these four stores and is not part of their encrypted backups; see docs/HISTORY_STORE.md.
