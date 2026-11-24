/** S-159 (@E2E-183): scheduled re-check sampler with a task queue for independent volunteers, and the per-SIM adult cap (T-08). */
import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, getDb, getStore, migrate, resetDbForTests } from "../../../server/civic/core";
import { createPerson, grantVolunteer, runRecheckSampler, deleteAccount } from "../../../server/civic/identity/routes";
import { defaultJobs, resetJobsForTests, runJob, startJobs, stopJobs } from "../../../server/civic/jobs";
import { caller, serveIdentity, signupVia } from "./helpers";

let server: Server, call: ReturnType<typeof caller>;
beforeAll(async () => { const s = await serveIdentity(); server = s.server; call = caller(s.base); });
afterAll(() => { server.close(); });
beforeEach(() => { process.env.CIVIC_EXPOSE_DEV_OTP = "1"; resetDbForTests(); migrate(); resetJobsForTests(); });
afterEach(() => { resetJobsForTests(); delete process.env.CIVIC_EXPOSE_DEV_OTP; delete process.env.CIVIC_RECHECK_FRACTION; });

let n = 0;
const phone = () => "+9198765" + String(70000 + ++n);
function volunteer(org: string | null) {
  const p = createPerson({ phone: phone(), pin: "5827", consentVersion: "v1" });
  grantVolunteer(p.id, org ?? undefined);
  return { id: p.id, token: createSession(p.id) };
}
/** An adult enrolled by `vol` and activated, as the enrolment flow leaves it. */
function activated(vol: { id: string }, label = "Lakshmi", ref = "HH-7") {
  const adult = createPerson({ phone: phone(), pin: "9051", label, consentVersion: "v1" });
  const eid = crypto.randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO enrolments (id, volunteer_id, context_kind, context_ref, label, person_id, status, created_at, expires_at, activated_at) VALUES (?,?,?,?,?,?, 'activated', ?,?,?)")
    .run(eid, vol.id, "household", ref, label, adult.id, now, now, now);
  return { adult, eid };
}
const rechecks = (token: string) => call("GET", "/volunteer/rechecks", undefined, token);

describe("re-check sampler as a scheduled job with a task queue (S-159)", () => {
  it("@E2E-183 the job is registered, runs on a schedule and honours CIVIC_RECHECK_FRACTION", () => {
    const j = defaultJobs().find((x) => x.name === "enrolmentRecheck");
    expect(j).toBeTruthy();
    expect(j!.intervalMs).toBeGreaterThan(0);
    const vol = volunteer("org-a");
    activated(vol); activated(vol); activated(vol);
    process.env.CIVIC_RECHECK_FRACTION = "0"; // sampling off
    startJobs({ force: true });
    expect(runJob("enrolmentRecheck")).toBe(true);
    stopJobs();
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM enrolment_rechecks").get()).toEqual({ c: 0 });
    process.env.CIVIC_RECHECK_FRACTION = "1";
    startJobs({ force: true });
    runJob("enrolmentRecheck");
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM enrolment_rechecks WHERE status='open'").get()).toEqual({ c: 3 });
    stopJobs();
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'enrolment.recheck%'").all() as { action: string }[]).map((r) => r.action);
    expect(acts.filter((a) => a === "enrolment.recheck_task")).toHaveLength(3);
    expect(acts).toContain("enrolment.recheck_sampled");
  });

  it("@E2E-183 each enrolment gets ONE draw: a run that skips it does not leave it eligible for the next run", () => {
    const vol = volunteer("org-a");
    for (let i = 0; i < 20; i++) activated(vol);
    const first = runRecheckSampler({ fraction: 0.2, rng: () => 0.9 }); // nobody drawn
    expect(first).toMatchObject({ sampled: 0, tasks: 0 });
    const second = runRecheckSampler({ fraction: 1, rng: () => 0 }); // would draw everybody if they were still undecided
    expect(second.sampled).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM enrolments WHERE recheck_state = 'not_sampled'").get()).toEqual({ c: 20 });
  });

  it("@E2E-183 only an INDEPENDENT volunteer sees and answers a task: not the enrolling volunteer, not their organisation, not a resident", async () => {
    const enrolling = volunteer("org-a"), colleague = volunteer("org-a"), independent = volunteer("org-b");
    const { adult } = activated(enrolling, "Lakshmi", "HH-7");
    expect(runRecheckSampler({ fraction: 1, rng: () => 0 })).toMatchObject({ sampled: 1, tasks: 1 });

    expect((await rechecks(enrolling.token)).json.rechecks).toEqual([]);
    expect((await rechecks(colleague.token)).json.rechecks).toEqual([]);
    const resident = await signupVia(call, phone());
    expect((await rechecks(resident.token)).status).toBe(403);
    expect((await call("GET", "/volunteer/rechecks")).status).toBe(401);

    const list = await rechecks(independent.token);
    expect(list.status).toBe(200);
    expect(list.json.rechecks).toHaveLength(1);
    const task = list.json.rechecks[0];
    expect(task).toMatchObject({ label: "Lakshmi", context_kind: "household", context_ref: "HH-7" });
    expect(JSON.stringify(list.json)).not.toMatch(/\+91|phone|volunteer_id|person_id/); // no phone, no enrolling volunteer, no person id
    expect(JSON.stringify(list.json)).not.toContain(adult.id);

    expect((await call("POST", `/volunteer/rechecks/${task.id}/result`, { outcome: "confirmed" }, enrolling.token)).status).toBe(403);
    expect((await call("POST", `/volunteer/rechecks/${task.id}/result`, { outcome: "confirmed" }, colleague.token)).status).toBe(403);
    expect((await call("POST", `/volunteer/rechecks/${task.id}/result`, { outcome: "maybe" }, independent.token)).status).toBe(400);
    const ok = await call("POST", `/volunteer/rechecks/${task.id}/result`, { outcome: "disputed" }, independent.token);
    expect(ok.json).toEqual({ ok: true, outcome: "disputed" });
    expect((await call("POST", `/volunteer/rechecks/${task.id}/result`, { outcome: "confirmed" }, independent.token)).status).toBe(409); // answered once
    expect((await rechecks(independent.token)).json.rechecks).toEqual([]);
    expect(getDb().prepare("SELECT recheck_state FROM enrolments").get()).toEqual({ recheck_state: "disputed" });
    const rows = getStore("audit").prepare("SELECT actor, action FROM audit_log WHERE action = 'enrolment.recheck_disputed'").all() as { actor: string; action: string }[];
    expect(rows).toEqual([{ actor: independent.id, action: "enrolment.recheck_disputed" }]);
  });

  it("@E2E-183 an unanswered task expires after CIVIC_RECHECK_DUE_DAYS and cannot be answered late; erasing the adult deletes the task", async () => {
    const enrolling = volunteer("org-a"), reviewer = volunteer("org-b");
    activated(enrolling);
    const t0 = new Date();
    runRecheckSampler({ fraction: 1, rng: () => 0, now: t0 });
    const id = (getDb().prepare("SELECT id FROM enrolment_rechecks").get() as { id: string }).id;
    const late = runRecheckSampler({ fraction: 0, now: new Date(t0.getTime() + 15 * 86400000) });
    expect(late.expired).toBe(1);
    expect(getDb().prepare("SELECT status FROM enrolment_rechecks").get()).toEqual({ status: "expired" });
    expect((await call("POST", `/volunteer/rechecks/${id}/result`, { outcome: "confirmed" }, reviewer.token)).status).toBe(409);
    const second = activated(enrolling, "Sita");
    runRecheckSampler({ fraction: 1, rng: () => 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM enrolment_rechecks WHERE status='open'").get()).toEqual({ c: 1 });
    deleteAccount(second.adult.id);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM enrolment_rechecks WHERE status='open'").get()).toEqual({ c: 0 });
  });
});

describe("per-SIM adult cap (T-08)", () => {
  it("@E2E-183 at most CIVIC_MAX_ADULTS_PER_SIM (default 5) adults can share a number; the sixth link is refused and nothing is created", async () => {
    const PH = phone();
    const first = await signupVia(call, PH, "4821");
    for (const [i, pin] of ["5827", "9051", "6203", "7391"].entries()) {
      const r = await call("POST", "/sim/link", { pin, consent_version: "v1", label: "adult " + (i + 2) }, first.token);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    expect((await call("GET", "/sim/members", undefined, first.token)).json.members).toHaveLength(5);
    const sixth = await call("POST", "/sim/link", { pin: "8462", consent_version: "v1" }, first.token);
    expect(sixth.status).toBe(409);
    expect(sixth.json.error).toMatch(/at most 5 adults/);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM persons WHERE phone_hash IS NOT NULL").get()).toEqual({ c: 5 });
  });
});
