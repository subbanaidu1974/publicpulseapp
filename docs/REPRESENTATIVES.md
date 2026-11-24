# Representative replies, scheme tags and the grievance-system adapter (S-145)

Code: `server/civic/representatives/**` (router mounted at `/api/v1/civic/representatives`), public display in `src/components/civic/IssueDetail.tsx`, console `src/components/civic/consoles/PoliticianConsole.tsx`, moderation `consoles/ReplyModeration.tsx`. Tests: `tests/civic/representatives.test.ts`. Policy source: `docs/DESIGN_2028.md` sections 3.4 ("Credit") and 5.

**Status: engineering done, no real government system is connected.** The adapter is a contract and a mock.

## Who may reply

The `politician` role (docs/ROLES.md). It is granted only through the dual-control admin API, and the grant must name a **constituency** (`validateGrantUnit`). So "verified elected representative" is exactly "two admins checked this person and granted the role for this constituency". The checking itself is a human step (see below).

A representative may reply only on a **public** issue (moderation `ok`) whose village lies in the constituency of one of their grants at today's boundaries (`scopeCovers`; a village in two constituencies can be answered by either). Anything else is `403 outside_scope` (audited as `scope.denied`) or `404`.

## What a reply is

* **One reply thread per issue.** `POST /representatives/issues/:id/reply` creates version 1. A second post is `409 reply_exists`, also for a colleague of another party whose constituency overlaps.
* **Append only.** `POST .../reply/revise` adds version N+1 and only the author (a keyed pseudonym, never a person id) may do it. Nothing is updated in place; the earlier versions stay in the table and the earlier **visible** versions are listed publicly as "earlier versions". Up to 20 versions.
* **Clearly labelled.** The public payload has `official_reply.label = "representative_reply"` and the constituency name; the page prints "Official reply from the elected representative for <constituency>". No name, party or photo is shown or stored, so no representative gets more visual weight than another.
* **Scheme tags.** At most three ids from `data/civic/schemes.json` (`GET /representatives/schemes`). Tags are labels only. Ids outside the registry are `400 unknown_scheme`.
* **No ranking.** The reply is not part of the feed, the export, the counts, the status, the SLA or any order. A test checks the public report is byte-identical apart from the new `official_reply` field.
* **Limits.** 20 to 1000 characters; 10 posts or revisions per person per day (`CIVIC_REP_REPLIES_PER_DAY`).

## Moderation hold and audit

* The text goes through the same layered rules as citizen reports (`assessText`). A flagged version is stored with status `held` and its rule ids, and is **not public**. While a revision is held the previous visible version keeps showing.
* `GET /representatives/moderation/queue` (moderator or admin) lists held versions; `POST /representatives/replies/:id/review {decision: approve | hold | remove, note}`. Hold and remove need a reason. A moderator cannot moderate their own reply.
* Audit (hash-chained): `representative.reply.post | revise | review`, `representative.grievance.forward | failed`, `scope.denied`. Entries carry issue, version, status and tag ids, never the text.
* Account erasure keeps the reply (an official public record) and removes the pseudonymous author link.

## Grievance-system adapter contract

`server/civic/representatives/grievance.ts` defines `GrievanceSystemAdapter` (`contract: 1`, `name`, `submit(ticket, {idempotencyKey})`, `status(reference)`), the rules every adapter must keep (idempotent per key, **no reporter identity or exact location in the ticket**, errors thrown not swallowed), `validateTicket` (rejects any field outside the contract), a registry (`setGrievanceAdapter`) and `MockGrievanceAdapter` (in memory, scriptable). Nothing is installed by default: with no adapter the routes answer `501 grievance_adapter_unavailable`.

* `POST /representatives/issues/:id/grievance` (a representative covering the issue) forwards category, department, village and constituency codes, the sanitised public text and the scheme tags. Once per issue and system (second call returns the stored link, `200`). An adapter error is `502 grievance_system_error` and stores nothing.
* `GET /representatives/issues/:id/grievance` refreshes and returns `{system, reference, status}`.
* Table `grievance_link` (issues store) holds the reference and the last status.

A real adapter (for a state portal) is a separate piece of work after the owning department agrees terms and credentials; it must pass the same tests the mock passes.

## Human steps before launch

1. Verification of who is an elected representative (the dual-control grant). Agree the checklist (official gazette or Election Commission record of the member for that constituency) and who performs it.
2. The scheme registry `data/civic/schemes.json` ships with a short starter list. The programme owner decides the list; a native Telugu reviewer checks the labels.
3. Legal review of public replies by officials (defamation duty for held text, takedown route), and of whether a representative may reply during a model code of conduct period; this repository does not decide that.
4. Agree with a department before any real grievance system is connected; E2E-160 is not written here.
