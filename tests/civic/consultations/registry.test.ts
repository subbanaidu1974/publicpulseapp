import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../../../server/civic/core";
import { runConsultationJobs } from "../../../server/civic/consultations";
import { DAY, P, admin, call, citizen, clock, draft, endWorld, freshWorld, officer, openConsultation, person, startServer, stopServer, tick } from "./helpers";

beforeAll(startServer);
afterAll(stopServer);
beforeEach(freshWorld);
afterEach(endWorld);

describe("bill consultation registry (S-35)", () => {
  it("@E2E-44 an officer registers a consultation; anyone reads it without login", async () => {
    const creator = officer();
    const c = await call(creator, "POST", "", draft());
    expect(c.status).toBe(201);
    const id = c.body.id as string;
    expect((await call(null, "GET", `/${id}`)).status).toBe(404); // drafts are private
    expect((await call(creator, "POST", `/${id}/submit`)).status).toBe(200);
    const pub = await call(null, "GET", `/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ status: "in_review", department: "Agriculture", bill_ref: "Draft Bill 2026/14", version: 1 });
    expect(pub.body.clauses).toHaveLength(2);
    expect(pub.body.clauses[0]).toMatchObject({ n: 1, summary_en: expect.any(String), summary_te: expect.any(String) });
    expect(pub.body.clauses[0].audio[0]).toMatchObject({ group: "farmers", status: "placeholder", duration_s: 40 });
    expect(pub.body.affected_groups).toEqual(["farmers", "women", "students"]);
    expect(pub.body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pub.body.disclaimer_en).toMatch(/signal, not a referendum/);
    const list = await call(null, "GET", "");
    expect(list.body.consultations.map((x: any) => x.id)).toContain(id);
    const cl = await call(null, "GET", `/${id}/clauses/2`);
    expect(cl.body.clause.summary_te).toContain("వ్యాపారులు");
    expect((await call(null, "GET", `/${id}/clauses/9`)).status).toBe(404);
  });

  it("@E2E-44 creation rules: official source URL, both summaries, audio metadata, creator roles", async () => {
    const o = officer();
    expect((await call(citizen(), "POST", "", draft())).status).toBe(403);
    expect((await call(o, "POST", "", draft({ source_url: "https://example.com/bill.pdf" }))).body.code).toBe("source_url_not_official");
    expect((await call(o, "POST", "", draft({ source_url: "http://www.ap.gov.in/b.pdf" }))).body.code).toBe("source_url_not_official");
    const reviewed = draft(); (reviewed.clauses[0] as any).audio = [{ group: "farmers", status: "reviewed", duration_s: 30, file_id: "a1" }];
    expect((await call(o, "POST", "", reviewed)).body.code).toBe("audio_review_is_a_human_step");
    const long = draft(); (long.clauses[0] as any).audio = [{ group: "farmers", status: "placeholder", duration_s: 61 }];
    expect((await call(o, "POST", "", long)).body.code).toBe("audio_duration_invalid");
    const grp = draft(); (grp.clauses[0] as any).audio = [{ group: "pilots", status: "placeholder", duration_s: 10 }];
    expect((await call(o, "POST", "", grp)).body.code).toBe("audio_group_unknown");
    // a draft may lack a TE summary but cannot be submitted
    const noTe = draft(); (noTe.clauses[1] as any).summary_te = "";
    const c = await call(o, "POST", "", noTe);
    expect(c.status).toBe(201);
    expect((await call(o, "POST", `/${c.body.id}/submit`)).body.code).toBe("summaries_required");
    // an admin creates on behalf of a named department
    expect((await call(admin(), "POST", "", draft())).body.code).toBe("department_required");
    expect((await call(admin(), "POST", "", draft({ department: "Revenue" }))).status).toBe(201);
  });

  it("@E2E-44 panel: two distinct reviewers on the content hash, never the department's own; content is frozen", async () => {
    const o = officer("Agriculture");
    const id = (await call(o, "POST", "", draft())).body.id as string;
    await call(o, "POST", `/${id}/submit`);
    expect((await call(o, "PATCH", `/${id}`, { title_en: "Changed title" })).body.code).toBe("content_frozen");
    expect((await call(citizen(), "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(403);
    const sameDept = person({ role: "survey_panel", dept: "Agriculture" });
    // survey_panel seat with the department as its nominating org: government:Agriculture conflicts only for officers; use an officer+panel holder
    const both = officer("Agriculture");
    expect((await call(both, "POST", `/${id}/panel/review`, { decision: "approve" })).status).toBe(403);
    void sameDept;
    const a = admin();
    expect((await call(a, "POST", `/${id}/panel/review`, { decision: "approve" })).body.result).toBe("in_review");
    expect((await call(a, "POST", `/${id}/panel/review`, { decision: "approve" })).body.code).toBe("already_reviewed");
    expect((await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve" })).body.result).toBe("approved");
    expect((await call(null, "GET", `/${id}`)).body.status).toBe("approved");
    // a rejection returns it to draft (private) with notes
    const id2 = (await call(o, "POST", "", draft())).body.id as string;
    await call(o, "POST", `/${id2}/submit`);
    expect((await call(admin(), "POST", `/${id2}/panel/review`, { decision: "reject", notes: "x" })).body.code).toBe("rejection_needs_notes");
    expect((await call(admin(), "POST", `/${id2}/panel/review`, { decision: "reject", notes: "the TE summary is not plain language" })).body.result).toBe("draft");
    // the database refuses edits to frozen content too
    expect(() => getStore("survey").prepare("UPDATE consultations SET title_en = 'x' WHERE id = ?").run(id)).toThrow(/content_frozen/);
    expect(() => getStore("survey").prepare("DELETE FROM consultation_versions WHERE consultation_id = ?").run(id)).toThrow(/append_only/);
  });

  it("@E2E-44 a correction is a new sha256 version with a public change log; it needs the same panel approvals", async () => {
    const { id, creator } = await openConsultation();
    const before = (await call(null, "GET", `/${id}`)).body;
    const fix = { reason_en: "Corrected the payment period in clause 2", clauses: [{ n: 2, summary_en: "Traders must pay farmers within five days of a sale.", summary_te: "అమ్మకం జరిగిన ఐదు రోజుల్లోగా వ్యాపారులు రైతులకు చెల్లించాలి." }] };
    expect((await call(citizen(), "POST", `/${id}/corrections`, fix)).status).toBe(403);
    expect((await call(creator, "POST", `/${id}/corrections`, { ...fix, reason_en: "x" })).body.code).toBe("reason_required");
    const corr = await call(creator, "POST", `/${id}/corrections`, fix);
    expect(corr.status).toBe(201);
    // still the old version publicly until approved
    expect((await call(null, "GET", `/${id}/clauses/2`)).body.clause.summary_en).toContain("seven days");
    expect((await call(creator, "POST", `/${id}/corrections`, fix)).body.code).toBe("correction_pending");
    const r1 = await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    expect(r1.body.result).toBe("correction_pending");
    const r2 = await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    expect(r2.body.result).toBe("correction_applied");
    const after = (await call(null, "GET", `/${id}`)).body;
    expect(after.version).toBe(2);
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.clauses[1].summary_en).toContain("five days");
    const v1 = await call(null, "GET", `/${id}/versions/1`);
    expect(v1.body.content.clauses[1].summary_en).toContain("seven days");
    expect(v1.body.content_hash).toBe(before.content_hash);
    const log = await call(null, "GET", `/${id}/log`);
    const kinds = log.body.entries.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["registered", "approved", "published", "correction_proposed", "corrected"]));
    expect(log.body.entries.find((e: any) => e.kind === "corrected").detail.reason_en).toMatch(/payment period/);
    expect(() => getStore("survey").prepare("UPDATE consultation_log SET kind = 'x'").run()).toThrow(/append_only/);
  });

  it("@E2E-44 audio is never auto-marked reviewed: only a human panel review of a real recording does", async () => {
    const { id, creator } = await openConsultation();
    expect((await call(admin(), "POST", `/${id}/audio/review`, { clause: 1, group: "farmers" })).body.code).toBe("audio_not_recorded");
    const rec = { reason_en: "Added the recorded farmers audio", clauses: [{ n: 1, audio: [{ group: "farmers", file_id: "aud-001", duration_s: 42, status: "recorded" }] }] };
    const corr = await call(creator, "POST", `/${id}/corrections`, rec);
    expect(corr.status).toBe(201);
    await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    expect((await call(null, "GET", `/${id}/clauses/1`)).body.clause.audio[0].status).toBe("recorded");
    expect((await call(creator, "POST", `/${id}/audio/review`, { clause: 1, group: "farmers" })).status).toBe(403);
    expect((await call(admin(), "POST", `/${id}/audio/review`, { clause: 1, group: "farmers" })).status).toBe(200);
    expect((await call(null, "GET", `/${id}/clauses/1`)).body.clause.audio[0].status).toBe("reviewed");
  });

  it("@E2E-44 the job closes a consultation at closes_at", async () => {
    const { id } = await openConsultation();
    expect(runConsultationJobs(clock.now).closed).toBe(0);
    tick(21 * DAY);
    expect(runConsultationJobs(clock.now).closed).toBe(1);
    expect(runConsultationJobs(clock.now).closed).toBe(0);
    const d = (await call(null, "GET", `/${id}`)).body;
    expect(d.status).toBe("closed");
    expect(d.closing_report.status).toBe("pending");
    expect(d.closing_report.due_at).toBeTruthy();
  });
});

export type { P };
