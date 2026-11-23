import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../../../server/civic/core";
import { runConsultationJobs, submitFeedback } from "../../../server/civic/consultations";
import { clusterComments } from "../../../server/civic/consultations/similarity";
import { setCommentReviewer } from "../../../server/civic/consultations/reviewer";
import { DAY, admin, call, citizen, clock, endWorld, freshWorld, officer, openConsultation, person, startServer, stopServer, tick } from "./helpers";

beforeAll(startServer);
afterAll(stopServer);
beforeEach(freshWorld);
afterEach(endWorld);

const fb = (clause: number, stance: string, extra: Record<string, unknown> = {}) => ({ clause, stance, ...extra });

describe("feedback (S-35)", () => {
  it("@E2E-44 only authenticated, eligible adults give feedback; one row per person and clause, last edit wins", async () => {
    const { id } = await openConsultation();
    const p = citizen();
    expect((await call(null, "POST", `/${id}/feedback`, fb(1, "support"))).status).toBe(401);
    expect((await call(person({ tier: "T0", village: null }), "POST", `/${id}/feedback`, fb(1, "support"))).body.code).toBe("tier_too_low");
    expect((await call(person({ village: "DEMO-V-UNKNOWN" }), "POST", `/${id}/feedback`, fb(1, "support"))).status).toBe(403);
    expect((await call(p, "POST", `/${id}/feedback`, fb(9, "support"))).body.code).toBe("clause_invalid");
    expect((await call(p, "POST", `/${id}/feedback`, fb(1, "love"))).body.code).toBe("stance_invalid");
    const a = await call(p, "POST", `/${id}/feedback`, fb(1, "support"));
    expect(a.status).toBe(201);
    const b = await call(p, "POST", `/${id}/feedback`, fb(1, "oppose", { comment: "The yard fee should be lower for small farmers." }));
    expect(b.status).toBe(200);
    expect(b.body.edited).toBe(true);
    await call(p, "POST", `/${id}/feedback`, fb(2, "prefer_not"));
    const mine = await call(p, "GET", `/${id}/mine`);
    expect(mine.body.feedback).toHaveLength(2);
    expect(mine.body.feedback[0]).toMatchObject({ clause: 1, stance: "oppose", edits: 1 });
    expect(getStore("survey").prepare("SELECT COUNT(*) c FROM consultation_feedback WHERE clause_n = 1").get()).toMatchObject({ c: 1 });
    // no person id in the survey store
    expect(JSON.stringify(getStore("survey").prepare("SELECT * FROM consultation_feedback").all())).not.toContain(p.id);
    // an ineligible caller learns why on /mine
    expect((await call(person({ tier: "T0", village: null }), "GET", `/${id}/mine`)).body.eligible).toBe(false);
  });

  it("@E2E-44 comments: 1500 character cap, EN or TE only, moderation holds personal data", async () => {
    const { id } = await openConsultation();
    const p = citizen();
    expect((await call(p, "POST", `/${id}/feedback`, fb(1, "support", { comment: "a".repeat(1501) }))).body.code).toBe("comment_too_long");
    expect((await call(p, "POST", `/${id}/feedback`, fb(1, "support", { comment: "a".repeat(1500) }))).status).toBe(201);
    expect((await call(p, "POST", `/${id}/feedback`, fb(1, "support", { comment: "这个条款不好 这个条款不好" }))).body.code).toBe("comment_language");
    const te = await call(p, "POST", `/${id}/feedback`, fb(1, "support", { comment: "ఈ నిబంధన చిన్న రైతులకు మేలు చేస్తుంది", public_ok: true }));
    expect(te.status).toBe(200);
    const held = await call(p, "POST", `/${id}/feedback`, fb(2, "oppose", { comment: "call me on 9876543210 about this", public_ok: true }));
    expect(held.body).toMatchObject({ comment_status: "held", comment_public: false });
  });

  it("@E2E-44 figures are never live; aggregates are k-suppressed and rounded; held and unconsented comments are not public", async () => {
    process.env.SURVEY_MIN_CELL = "5"; process.env.SURVEY_ROUND_TO = "5"; process.env.SURVEY_PUBLISH_DELAY_HOURS = "24";
    const { id } = await openConsultation();
    const people = Array.from({ length: 12 }, () => citizen());
    for (const [i, p] of people.entries()) {
      const r = await call(p, "POST", `/${id}/feedback`, fb(1, i < 7 ? "support" : "oppose", i === 0 ? { comment: "Please keep the yard fee low for small farmers.", public_ok: true } : i === 1 ? { comment: "Private note about fees.", public_ok: false } : i === 2 ? { comment: "reach me at 9876543211", public_ok: true } : {}));
      expect(r.status).toBe(201);
    }
    await call(people[0], "POST", `/${id}/feedback`, fb(2, "support")); // clause 2: 1 person only
    expect((await call(null, "GET", `/${id}/figures`)).status).toBe(403); // still open
    tick(20 * DAY + 3_600_000); runConsultationJobs(clock.now);
    expect((await call(null, "GET", `/${id}/figures`)).body.reason).toBe("too_early");
    tick(25 * 3_600_000);
    const f = await call(null, "GET", `/${id}/figures`);
    expect(f.status).toBe(200);
    expect(f.body.participation.participants).toBe(10); // 12 rounded to a multiple of 5
    const c1 = f.body.clauses.find((x: any) => x.clause === 1);
    expect(c1.published).toBe(true);
    expect(c1.participants).toBe(10);
    expect(c1.stances.find((s: any) => s.id === "support").count).toBe(5); // 7 rounded to a multiple of 5
    expect(c1.stances.find((s: any) => s.id === "oppose").count).toBe(5);
    const c2 = f.body.clauses.find((x: any) => x.clause === 2);
    expect(c2.published).toBe(false);
    expect(c2.suppressed_reason).toBe("fewer_than_k_participants");
    expect(f.body.weighted.applied).toBe(false);
    expect(JSON.stringify(f.body)).not.toMatch(/\b(vote|ballot|result)s?\b/i);
    const cm = await call(null, "GET", `/${id}/comments`);
    expect(cm.status).toBe(200);
    expect(cm.body.comments).toHaveLength(1);
    expect(cm.body.comments[0]).toMatchObject({ clause: 1, comment: "Please keep the yard fee low for small farmers." });
    expect(JSON.stringify(cm.body.comments)).not.toContain("9876543211");
    expect(cm.body.comments[0].location).toMatchObject({ level: "mandal" }); // 12 >= k in the mandal cell
    expect((await call(people[0], "POST", `/${id}/feedback`, fb(1, "support"))).body.code).toBe("consultation_closed");
  });

  it("@E2E-45 rate limits per person and per network prefix; limited requests are counted for the report", async () => {
    process.env.CONSULT_FEEDBACK_PER_MIN_PERSON = "3";
    const { id } = await openConsultation();
    const p = citizen();
    for (let i = 0; i < 3; i++) expect((await call(p, "POST", `/${id}/feedback`, fb(1, "support"))).status).toBeLessThan(300);
    expect((await call(p, "POST", `/${id}/feedback`, fb(1, "oppose"))).status).toBe(429);
    delete process.env.CONSULT_FEEDBACK_PER_MIN_PERSON; process.env.CONSULT_FEEDBACK_PER_MIN_NET = "5";
    let limited = 0;
    for (let i = 0; i < 9; i++) if ((await call(citizen(), "POST", `/${id}/feedback`, fb(2, "support"))).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(4);
    expect((getStore("survey").prepare("SELECT SUM(limited) s FROM consultation_burst").get() as any).s).toBeGreaterThanOrEqual(5);
  });
});

describe("anti-astroturf and the closing report (S-36)", () => {
  it("@E2E-45 near-duplicate similarity: variants cluster, different views do not", () => {
    const c = clusterComments([
      { id: "a", text: "Please withdraw clause 4, it hurts small farmers badly!" },
      { id: "b", text: "please withdraw CLAUSE 7 it hurts small farmers badly" },
      { id: "c", text: "This clause is fine but the yard fee needs a cap for women growers." },
      { id: "d", text: "దయచేసి ఈ నిబంధనను ఉపసంహరించండి ఇది చిన్న రైతులకు నష్టం" },
      { id: "e", text: "దయచేసి ఈ నిబంధనను ఉపసంహరించండి, ఇది చిన్న రైతులకు నష్టం!!" },
    ]);
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.ids.sort().join())).toEqual(expect.arrayContaining(["a,b", "d,e"]));
  });

  it("@E2E-45 500 near-identical comments in one minute: one cluster, flagged, each person counted once", async () => {
    process.env.SURVEY_MIN_CELL = "5"; process.env.SURVEY_ROUND_TO = "5"; process.env.SURVEY_PUBLISH_DELAY_HOURS = "0";
    process.env.CONSULT_FEEDBACK_PER_MIN_NET = "100000"; process.env.CONSULT_FEEDBACK_PER_MIN_PERSON = "100000";
    const { id } = await openConsultation();
    const crowd = Array.from({ length: 500 }, () => person());
    crowd.forEach((p, i) => {
      const r = submitFeedback(p.id, id, { clause: 1, stance: "oppose", comment: `Withdraw this clause now it harms small farmers and traders, supporter number ${i}`, public_ok: true }, "203.0.113.9", new Date(clock.now.getTime() + (i % 50) * 1000));
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
    // the same people post again (edit): still one row each
    for (const p of crowd.slice(0, 100)) expect(submitFeedback(p.id, id, { clause: 1, stance: "oppose", comment: "Withdraw this clause now it harms small farmers and traders" }, "203.0.113.9", clock.now)).toMatchObject({ ok: true, edited: true });
    // 12 organic people with different views
    const organic = ["Support but cap the fee", "Needs a clearer definition of notified produce", "Good for market transparency", "Add an appeal process for traders", "Digital records should be free", "Extend the timeline to six months", "Explain how small yards are covered", "Add Telugu forms at every yard", "Fix payment delays first", "Women self help groups need a counter", "Include fisheries", "Review after one year"];
    organic.forEach((t, i) => submitFeedback(person().id, id, { clause: 1, stance: i % 2 ? "support_changes" : "support", comment: t }, "198.51.100." + i, clock.now));
    expect(getStore("survey").prepare("SELECT COUNT(*) c FROM consultation_feedback WHERE clause_n = 1").get()).toMatchObject({ c: 512 });
    expect(getStore("survey").prepare("SELECT COUNT(DISTINCT person_key) c FROM consultation_feedback").get()).toMatchObject({ c: 512 });

    tick(21 * DAY); runConsultationJobs(clock.now);
    const o = officer();
    const an = await call(admin(), "GET", `/${id}/analyst`);
    expect(an.status).toBe(200);
    expect(an.body.clusters[0]).toMatchObject({ clause: 1, flagged: true });
    expect(an.body.clusters[0].size).toBeGreaterThanOrEqual(495);
    expect(an.body.clusters.filter((c: any) => c.size >= 100)).toHaveLength(1); // one item for the analyst, not 500
    expect(an.body.flags.bursts.length).toBeGreaterThanOrEqual(1); // >= 100 per minute
    expect(an.body.flags.peak_per_minute).toBeGreaterThanOrEqual(500);
    expect((await call(citizen(), "GET", `/${id}/analyst`)).status).toBe(403);
    void o;

    const f = (await call(null, "GET", `/${id}/figures`)).body;
    const c1 = f.clauses.find((x: any) => x.clause === 1);
    expect(c1.participants).toBe(510); // 512 people, rounded to 5, NOT inflated by the cluster
    expect(c1.stances.find((s: any) => s.id === "oppose").count).toBe(500);
    // public comments mark the cluster, never amplify it
    const cm = await call(null, "GET", `/${id}/comments?clause=1&limit=200`);
    expect(cm.body.comments.filter((c: any) => c.flag === "near_duplicate").length).toBeGreaterThan(100);
    expect(cm.body.comments.every((c: any) => !("name" in c))).toBe(true);
  }, 120_000);

  it("@E2E-45 review coverage is exact: a no-op reviewer never claims machine summarisation, and only recorded reads count", async () => {
    const { id } = await openConsultation();
    for (let i = 0; i < 4; i++) await call(citizen(), "POST", `/${id}/feedback`, fb(1, "support", { comment: "Comment number " + "abcd"[i] + " about the yard fee for farmers in my area" }));
    tick(21 * DAY); runConsultationJobs(clock.now);
    const a = admin();
    const run = await call(a, "POST", `/${id}/review/run`);
    expect(run.body).toMatchObject({ kind: "none", summarised: 0 });
    let an = (await call(a, "GET", `/${id}/analyst`)).body;
    expect(an.coverage).toMatchObject({ comments_total: 4, reviewed_by_human: 0, machine_summarised: 0, machine_assisted: false });
    expect(an.coverage.method).toMatch(/No machine summarisation/);
    const ids = (getStore("survey").prepare("SELECT id FROM consultation_feedback").all() as any[]).map((r) => r.id);
    expect((await call(a, "POST", `/${id}/review/comments`, { feedback_ids: [ids[0], ids[1], "bogus"] })).body.recorded).toBe(2);
    an = (await call(a, "GET", `/${id}/analyst`)).body;
    expect(an.coverage).toMatchObject({ reviewed_by_human: 2, unreviewed: 2 });
    expect(an.coverage.human_reviewer_roles).toEqual([{ role: "admin", comments_read: 2 }]);
    // an installed machine reviewer: only ids it actually returned are counted
    setCommentReviewer({ name: "test-summariser", kind: "machine", review: (items) => ({ summarised_ids: [items[0].id, "not-an-id"], themes: [{ clause: 1, label_en: "Yard fee concerns" }] }) });
    expect((await call(a, "POST", `/${id}/review/run`)).body).toMatchObject({ kind: "machine", summarised: 1, themes: 1 });
    an = (await call(a, "GET", `/${id}/analyst`)).body;
    expect(an.coverage).toMatchObject({ machine_summarised: 1, machine_assisted: true });
    expect(an.coverage.machine_methods).toEqual([{ method: "test-summariser", comments_summarised: 1 }]);
    expect(an.themes[0]).toMatchObject({ source: "reviewer" });
  });

  async function closedWithFeedback() {
    process.env.SURVEY_MIN_CELL = "5"; process.env.SURVEY_PUBLISH_DELAY_HOURS = "0";
    const { id, creator } = await openConsultation();
    for (let i = 0; i < 6; i++) await call(citizen(), "POST", `/${id}/feedback`, fb(1 + (i % 2), i % 3 ? "support" : "oppose", { comment: "Remarks " + "abcdef"[i] + " on this clause for small farmers" }));
    tick(21 * DAY); runConsultationJobs(clock.now);
    return { id, creator };
  }

  it("@E2E-45 a consultation cannot be completed without a published closing report", async () => {
    const { id, creator } = await closedWithFeedback();
    const dept = officer("Agriculture");
    const done = await call(dept, "POST", `/${id}/complete`);
    expect(done.status).toBe(409);
    expect(done.body.code).toBe("closing_report_required");
    // the database refuses as well
    expect(() => getStore("survey").prepare("UPDATE consultations SET status = 'completed' WHERE id = ?").run(id)).toThrow(/closing_report_required/);
    expect((await call(null, "GET", `/${id}/closing-report`)).body.code).toBe("report_not_published");

    // the panel cannot publish without a department response per clause
    const a = admin();
    let pub = await call(a, "POST", `/${id}/closing-report/publish`);
    expect(pub.status).toBe(409);
    expect(pub.body.missing.find((m: any) => m.code === "department_response_required").clauses).toEqual([1, 2]);
    // only an officer of the department answers
    expect((await call(a, "POST", `/${id}/closing-report/responses`, { clause: 1, kind: "response", text_en: "We will lower the fee for small farmers." })).status).toBe(403);
    expect((await call(officer("Revenue"), "POST", `/${id}/closing-report/responses`, { clause: 1, kind: "response", text_en: "We will lower the fee for small farmers." })).status).toBe(403);
    expect((await call(creator, "POST", `/${id}/closing-report/responses`, { clause: 1, kind: "no_change", text_en: "short" })).body.code).toBe("reasons_required");
    expect((await call(creator, "POST", `/${id}/closing-report/responses`, { clause: 1, kind: "response", text_en: "We will lower the fee for small farmers." })).status).toBe(200);
    pub = await call(a, "POST", `/${id}/closing-report/publish`);
    expect(pub.body.missing.find((m: any) => m.code === "department_response_required").clauses).toEqual([2]);
    expect((await call(creator, "POST", `/${id}/closing-report/responses`, { clause: 2, kind: "no_change", text_en: "No change: the payment period is already fixed by the parent Act." })).status).toBe(200);
    pub = await call(a, "POST", `/${id}/closing-report/publish`);
    expect(pub.body.missing).toEqual([{ code: "themes_required" }]); // comments exist, so a theme is required
    expect((await call(creator, "POST", `/${id}/themes`, { label_en: "Yard fee burden on small farmers", clause: 1 })).status).toBe(201);
    expect((await call(dept, "POST", `/${id}/complete`)).body.code).toBe("closing_report_required");
    pub = await call(a, "POST", `/${id}/closing-report/publish`);
    expect(pub.status).toBe(200);

    const rep = await call(null, "GET", `/${id}/closing-report`);
    expect(rep.status).toBe(200);
    const r = rep.body.report;
    expect(r.participation.participants).not.toBeUndefined();
    expect(r.clauses[0].department_response.kind).toBe("response");
    expect(r.clauses[1].department_response.kind).toBe("no_change");
    expect(r.clauses[0].themes[0].label_en).toMatch(/Yard fee/);
    expect(r.anti_astroturf).toMatchObject({ flagged_clusters: expect.any(Number), burst_threshold_per_minute: 100 });
    expect(r.review_coverage).toMatchObject({ comments_total: 6, reviewed_by_human: 0, machine_summarised: 0 });
    expect(r.review_coverage.method).toMatch(/NOT all read/);
    expect(r.signal_not_referendum).toBe(true);
    expect(rep.body.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => getStore("survey").prepare("UPDATE consultation_reports SET snapshot_json = '{}'").run()).toThrow(/append_only/);
    expect((await call(creator, "POST", `/${id}/closing-report/responses`, { clause: 2, kind: "response", text_en: "Changing the answer after the fact is refused." })).status).toBe(409);

    const ok = await call(dept, "POST", `/${id}/complete`);
    expect(ok.status).toBe(200);
    expect((await call(null, "GET", `/${id}`)).body.status).toBe("completed");
  });

  it("@E2E-45 overdue closing reports are flagged publicly in the registry and the log (default 30 days)", async () => {
    const { id } = await openConsultation();
    tick(21 * DAY); runConsultationJobs(clock.now);
    expect((await call(null, "GET", "?overdue=1")).body.consultations).toHaveLength(0);
    tick(29 * DAY);
    expect(runConsultationJobs(clock.now).overdue_flagged).toBe(0);
    tick(2 * DAY); // 31 days after close
    expect(runConsultationJobs(clock.now).overdue_flagged).toBe(1);
    expect(runConsultationJobs(clock.now).overdue_flagged).toBe(0); // once
    const list = await call(null, "GET", "?overdue=1");
    expect(list.body.consultations.map((c: any) => c.id)).toEqual([id]);
    expect(list.body.consultations[0].closing_report).toMatchObject({ status: "pending", overdue: true });
    expect((await call(null, "GET", `/${id}/log`)).body.entries.map((e: any) => e.kind)).toContain("report_overdue");
  });
});
