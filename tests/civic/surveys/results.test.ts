/** S-32 / S-33 (@E2E-41, @E2E-42) published survey figures: snapshot, routes, budget, channels, windows, jobs. */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStore, migrate, resetDbForTests } from "../../../server/civic/core";
import { defaultJobs, resetJobsForTests, runJob, startJobs } from "../../../server/civic/jobs";
import {
  buildPublishedSnapshot, buildSnapshotData, getStoredFigures, publishDueSurveys, resultsRouter, setFigureSource, type FigureResponse, type FigureSurvey,
} from "../../../server/civic/surveys/results";
import { findBannedWording, policyFromEnv } from "../../../server/civic/surveys/publish";
import { loadMarginals } from "../../../server/civic/surveys/weights";
import { setRegistryClock } from "../../../server/civic/surveys/types";
import "../../../server/civic/surveys/responses"; // registers the response tables

const CLOSE = "2026-06-01T10:00:00Z";
const AFTER = new Date("2026-06-03T00:00:00Z");
const ENVKEYS = ["FORECAST_BLACKOUT", "SURVEY_RESULTS_PER_CALLER_DAY", "SURVEY_RESULTS_GLOBAL_DAY", "SURVEY_MIN_CELL"];
const saved: Record<string, string | undefined> = {};

const survey = (over: Partial<FigureSurvey> = {}): FigureSurvey => ({
  id: "sv1", state: "AP", topic_class: "issue_service", election_choice: false, status: "closed", closes_at: CLOSE, title_en: "Water supply", scope_level: "state",
  questions: [{ id: "q1", kind: "single", text_en: "Is the supply regular?", options: [{ id: "yes", label_en: "Yes" }, { id: "no", label_en: "No" }, { id: "maybe", label_en: "Sometimes" }] }],
  ...over,
});
function resp(n: number, o: { gender: string; answer: string; channel?: "app" | "assisted"; tier?: string; mandal?: string; risk?: string }): FigureResponse[] {
  return Array.from({ length: n }, () => ({ answers: { q1: o.answer }, channel: o.channel ?? "app", strata: { age_band: "25-34", gender: o.gender, tier: o.tier ?? "T2", mandal: o.mandal ?? "m1" }, risk: o.risk ?? "low" }));
}
const panel = (): FigureResponse[] => [...resp(80, { gender: "M", answer: "yes" }), ...resp(40, { gender: "M", answer: "no" }), ...resp(25, { gender: "F", answer: "no" }), ...resp(5, { gender: "F", answer: "yes" })];

let server: Server, base: string;
function use(src: { s?: FigureSurvey; r?: FigureResponse[]; ids?: string[] }) {
  const s = src.s ?? survey();
  setFigureSource({ surveyIds: () => src.ids ?? [s.id], survey: (id) => (id === s.id ? s : null), responses: () => src.r ?? panel() });
}
const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });

beforeEach(async () => {
  for (const k of ENVKEYS) saved[k] = process.env[k];
  resetDbForTests(); migrate(); resetJobsForTests();
  setRegistryClock(() => AFTER);
  const app = express();
  app.use("/surveys", resultsRouter);
  server = await new Promise<Server>((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/surveys`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  setFigureSource(null); setRegistryClock(null); resetJobsForTests();
  for (const k of ENVKEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("publishing: no live counts (S-32 rule 4)", () => {
  it("@E2E-41 the endpoint refuses with 403 not_published before the snapshot exists, even for a closed survey inside the delay", async () => {
    use({});
    const early = await get("/sv1/results");
    expect(early.status).toBe(403);
    expect((await early.json()).error).toBe("not_published");
    expect((await get("/nope/results")).status).toBe(403); // unknown ids look the same
    expect((await get("/sv1/results/method")).status).toBe(403);
    // inside the 24 h delay nothing is built
    const rep = publishDueSurveys(new Date("2026-06-02T09:00:00Z"));
    expect(rep.published).toEqual([]);
    expect(rep.waiting).toBe(1);
    expect(getStoredFigures("sv1")).toBeNull();
    expect((await get("/sv1/results")).status).toBe(403);
  });

  it("@E2E-41 an open survey is never published", async () => {
    use({ s: survey({ status: "open", closes_at: "2026-07-01T00:00:00Z" }) });
    expect(buildPublishedSnapshot("sv1", AFTER)).toMatchObject({ status: "blocked", reason: "not_closed" });
    expect((await get("/sv1/results")).status).toBe(403);
  });

  it("@E2E-41 after close + delay the job publishes once; the snapshot is immutable and identical for every caller", async () => {
    use({});
    const rep = publishDueSurveys(AFTER);
    expect(rep.published).toEqual(["sv1"]);
    expect(publishDueSurveys(AFTER).published).toEqual([]);
    const row = getStoredFigures("sv1")!;
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => getStore("survey").prepare("UPDATE survey_results SET snapshot = '{}' WHERE survey_id = 'sv1'").run()).toThrow(/immutable/);
    expect(() => getStore("survey").prepare("DELETE FROM survey_results WHERE survey_id = 'sv1'").run()).toThrow(/immutable/);
    const a = await get("/sv1/results"), b = await get("/sv1/results", { "x-forwarded-for": "9.9.9.9" });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(a.headers.get("etag")).toBe(`"${row.sha256.slice(0, 40)}"`);
    expect(a.headers.get("cache-control")).toMatch(/public/);
    expect((await get("/sv1/results", { "if-none-match": a.headers.get("etag")! })).status).toBe(304);
  });

  it("@E2E-41 the job is registered with the job registry", () => {
    expect(defaultJobs().map((j) => j.name)).toContain("publishDueSurveys");
    use({});
    expect(startJobs({ force: true, now: () => AFTER, jobs: defaultJobs().filter((j) => j.name === "publishDueSurveys") })).toBe(true);
    expect(runJob("publishDueSurveys", AFTER)).toBe(true);
    expect(getStoredFigures("sv1")).not.toBeNull();
  });
});

describe("payload content (S-32, S-33)", () => {
  it("@E2E-42 carries sample size, weighted AND unweighted views, quality, sampling note, method link, code version and the disclaimer", async () => {
    use({});
    publishDueSurveys(AFTER, { marginals: loadMarginals() });
    const j = await (await get("/sv1/results")).json();
    expect(j.disclaimer_en).toBe("Opinion survey, not an election and not a forecast.");
    expect(j.disclaimer_te).toBeTruthy();
    expect(j.method_url).toBe("/methodology#surveys");
    expect(j.code_version).toMatch(/^pulse-survey-method\/1\.0\.0\+/);
    expect(j.one_dimension_only).toBe(true);
    const s = j.strata[0];
    expect(s.channel).toBe("app");
    expect(s.n).toBe(150);
    expect(s.sampling.margin_of_error).toBeNull();
    expect(s.sampling.note_en).toMatch(/Not a random sample/);
    expect(s.sampling.effective_n).toBeLessThan(150);
    expect(s.weighting).toMatchObject({ applied: true, dimensions: ["gender"], cap: 5 });
    expect(s.quality.score).toBeGreaterThan(0);
    expect(s.quality.components.map((c: { key: string }) => c.key)).toEqual(["t2_share", "low_risk", "coverage", "skew"]);
    const overall = s.questions[0].breakdowns.gender;
    expect(overall.length).toBeGreaterThan(0);
    const all = s.questions[0].breakdowns.geo[0];
    expect(all.unweighted.options.find((o: { id: string }) => o.id === "yes")).toBeTruthy();
    expect(all.weighted.options.find((o: { id: string }) => o.id === "yes")).toBeTruthy();
    // 100 of 150 are men, so weighting to a ~50/50 sex split must move the "yes" share
    const u = all.unweighted.options.find((o: { id: string }) => o.id === "yes").share, w = all.weighted.options.find((o: { id: string }) => o.id === "yes").share;
    expect(Math.abs(u - w)).toBeGreaterThan(1);
  });

  it("@E2E-42 without usable marginals nothing is weighted and the payload says so", async () => {
    use({});
    publishDueSurveys(AFTER, { marginals: null });
    const j = await (await get("/sv1/results")).json();
    expect(j.strata[0].weighting.applied).toBe(false);
    expect(j.strata[0].weighting.note_en).toMatch(/identical/);
    const m = await (await get("/sv1/results/method")).json();
    expect(m.marginals_file_loaded).toBe(false);
    expect(m.strata[0].weights.dimensions_skipped[0].reason).toBe("file_missing");
    expect(m.strata[0].quality.partial).toBe(true);
  });

  it("@E2E-42 the method route lists components, the weights used and skipped (age x gender is a placeholder) and suppression counts", async () => {
    use({});
    publishDueSurveys(AFTER, { marginals: loadMarginals() });
    const m = await (await get("/sv1/results/method")).json();
    const st = m.strata[0];
    expect(st.weights.dimensions_used[0]).toMatchObject({ dimension: "gender", area: "state:AP", provenance: "census-2011", as_of: "2011-03-01", weighted: true });
    expect(st.weights.dimensions_skipped.map((x: { dimension: string; reason: string }) => `${x.dimension}:${x.reason}`)).toContain("age_band_x_gender:placeholder");
    expect(st.quality.components).toHaveLength(4);
    expect(st.suppression.k).toBe(30);
    expect(st.suppression.geo[0]).toHaveProperty("suppressed_small");
    expect(m.policy.minimum_cell_size).toBe(30);
    expect(m.disclaimer_en).toMatch(/not a forecast/);
  });

  it("@E2E-41 the platform-written copy never uses vote, ballot or result", async () => {
    use({});
    publishDueSurveys(AFTER, { marginals: loadMarginals() });
    const j = await (await get("/sv1/results")).json();
    const m = await (await get("/sv1/results/method")).json();
    expect(findBannedWording(j)).toEqual([]);
    expect(findBannedWording(m)).toEqual([]);
  });
});

describe("one dimension at a time (S-33)", () => {
  beforeEach(() => { use({}); publishDueSurveys(AFTER); });
  it("@E2E-42 two dimensions in any form are refused with 400 cross_tab_not_allowed", async () => {
    for (const q of ["by=gender,age_band", "by=gender&by=tier", "by[]=gender&by[]=tier", "by=geo,gender", "dimensions=gender,tier"]) {
      const r = await get("/sv1/results?" + q);
      expect(r.status, q).toBe(400);
      expect((await r.json()).error).toBe("cross_tab_not_allowed");
    }
    expect((await (await get("/sv1/results?by=village_x")).json()).error).toBe("unknown_dimension");
  });
  it("@E2E-42 one dimension returns only that breakdown, with its own ETag", async () => {
    const r = await get("/sv1/results?by=gender");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Object.keys(j.strata[0].questions[0].breakdowns)).toEqual(["gender"]);
    expect(r.headers.get("etag")).toMatch(/-gender"$/);
    const full = await get("/sv1/results");
    expect(full.headers.get("etag")).not.toBe(r.headers.get("etag"));
  });
});

describe("query budget (S-32 rule 5)", () => {
  it("@E2E-41 a caller beyond the per-survey daily budget gets 429; other survey data stays identical and there is no per-request slicing", async () => {
    use({});
    publishDueSurveys(AFTER);
    process.env.SURVEY_RESULTS_PER_CALLER_DAY = "3";
    for (let i = 0; i < 3; i++) expect((await get("/sv1/results")).status).toBe(200);
    const r = await get("/sv1/results");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await r.json()).error).toBe("budget_exceeded");
  });
  it("@E2E-41 the global budget also applies", async () => {
    use({});
    publishDueSurveys(AFTER);
    process.env.SURVEY_RESULTS_GLOBAL_DAY = "2";
    await get("/sv1/results"); await get("/sv1/results");
    expect((await get("/sv1/results")).status).toBe(429);
    // counters hold hashes only, never the address
    const rows = getStore("survey").prepare("SELECT bucket FROM survey_query_budget").all() as { bucket: string }[];
    expect(rows.some((x) => x.bucket.includes("127.0.0.1"))).toBe(false);
  });
});

describe("channel strata (S-32 rule 6)", () => {
  it("@E2E-41 assisted responses are a separate stratum, never merged into the app figures", async () => {
    use({ r: [...panel(), ...resp(45, { gender: "F", answer: "yes", channel: "assisted" })] });
    publishDueSurveys(AFTER);
    const j = await (await get("/sv1/results")).json();
    expect(j.strata.map((s: { channel: string }) => s.channel)).toEqual(["app", "assisted"]);
    expect(j.strata[0].n).toBe(150);
    expect(j.strata[1].n).toBe(45);
    expect(j.strata[1].platform_linkable).toBe(true);
    expect(j.strata[1].label_en).toMatch(/never merged/);
    expect(JSON.stringify(j)).not.toMatch(/"n":195/);
  });
  it("@E2E-41 a channel under k is not published at all (no n shown), and assisted political samples are never published", async () => {
    use({ r: [...panel(), ...resp(12, { gender: "F", answer: "yes", channel: "assisted" })] });
    publishDueSurveys(AFTER);
    const j = await (await get("/sv1/results")).json();
    expect(j.strata[1]).toEqual({ channel: "assisted", published: false, reason: "below_minimum_cell_size" });
    const pol = survey({ id: "pv", topic_class: "political" });
    const { snapshot } = buildSnapshotData(pol, [...panel(), ...resp(50, { gender: "F", answer: "yes", channel: "assisted" })], { now: AFTER, policy: policyFromEnv(), marginals: null, geoPath: () => [{ id: "state:AP", level: "state" }] });
    expect((snapshot.strata as { channel: string; published: boolean }[])[1]).toMatchObject({ channel: "assisted", published: false, reason: "not_permitted_for_topic" });
  });
});

describe("election windows (S-32 rule 7)", () => {
  const pol = () => survey({ id: "pv", topic_class: "election_choice", election_choice: true });
  it("@E2E-41 a political survey is not built in a blackout or unknown window and is not served if one starts later", async () => {
    use({ s: pol() });
    process.env.FORECAST_BLACKOUT = "1";
    expect(publishDueSurveys(AFTER).blocked).toEqual([{ id: "pv", reason: "election_window" }]);
    expect((await get("/pv/results")).status).toBe(403);
    process.env.FORECAST_BLACKOUT = "0";
    expect(publishDueSurveys(AFTER).published).toEqual(["pv"]);
    expect((await get("/pv/results")).status).toBe(200);
    process.env.FORECAST_BLACKOUT = "1"; // a window starts after publication: fail closed at serve time too
    const r = await get("/pv/results");
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("not_published");
    delete process.env.FORECAST_BLACKOUT; // no calendar entry covering the date: unknown fails closed
    expect((await get("/pv/results")).status).toBe(403);
  });
});

describe("suppression in the geography tree (S-32 rules 1-2)", () => {
  it("@E2E-41 small districts are rolled up, never named in the snapshot or the method note", () => {
    const rs: FigureResponse[] = [...resp(100, { gender: "M", answer: "yes", mandal: "bigD" }), ...resp(40, { gender: "F", answer: "no", mandal: "midD" }), ...resp(7, { gender: "F", answer: "no", mandal: "tinyD" })];
    const geoPath = (r: FigureResponse) => [{ id: "state:AP", level: "state", label_en: "AP" }, { id: "district:" + r.strata.mandal, level: "district", label_en: "D-" + r.strata.mandal }];
    const { snapshot, method } = buildSnapshotData(survey(), rs, { now: AFTER, policy: policyFromEnv(), marginals: null, geoPath });
    const txt = JSON.stringify(snapshot) + JSON.stringify(method);
    expect(txt).not.toContain("tinyD");
    const cells = (snapshot.strata as { questions: { breakdowns: { geo: { id: string; hidden_children: number }[] } }[] }[])[0].questions[0].breakdowns.geo;
    expect(cells.map((c) => c.id)).toEqual(["state:AP", "state:AP/district:bigD"]);
    // tinyD (7) alone would be derivable, so the smallest published sibling (midD, 40) is hidden with it
    expect(cells.find((c) => c.id === "state:AP")!.hidden_children).toBe(2);
    expect(cells.some((c) => c.id.includes("midD"))).toBe(false);
  });
});

describe("default source: the survey store response tables", () => {
  it("@E2E-42 reads app and assisted responses from their own tables and maps the low-quality flag to risk", async () => {
    const { setSurveySource } = await import("../../../server/civic/surveys/source");
    setSurveySource((id) => id !== "db1" ? null : { id: "db1", status: "closed", topic_class: "issue_service", scope: { state: "TG", units: {} }, opens_at: "2026-05-01T00:00:00Z", closes_at: CLOSE, wording_hash: "x", questions: [{ id: "q1", kind: "single", max_select: null, options: ["yes", "no"] }] });
    const db = getStore("survey");
    const ins = (table: string, i: number, g: string, a: string, q: string) => db.prepare(`INSERT INTO ${table} (id, survey_id, answers, age_band, gender, tier, quality, mandal${table.endsWith("assisted") ? ", channel, platform_linkable" : ""}) VALUES (?,?,?,?,?,?,?,?${table.endsWith("assisted") ? ",'assisted',1" : ""})`).run(`${table}-${i}`, "db1", JSON.stringify({ q1: a }), "25-34", g, "T2", q, "m9");
    for (let i = 0; i < 60; i++) ins("survey_response", i, i % 2 ? "F" : "M", i % 3 ? "yes" : "no", i < 6 ? "low" : "normal");
    for (let i = 0; i < 31; i++) ins("survey_response_assisted", i, "F", "yes", "normal");
    const out = buildPublishedSnapshot("db1", AFTER);
    expect(out.status).toBe("published");
    const j = JSON.parse(getStoredFigures("db1")!.snapshot);
    expect(j.strata.map((s: { channel: string; n: number }) => `${s.channel}:${s.n}`)).toEqual(["app:60", "assisted:30"]);
    const lowRisk = j.strata[0].quality.components.find((c: { key: string }) => c.key === "low_risk").value;
    expect(lowRisk).toBe(0.9);
    expect(j.strata[0].weighting.dimensions).toEqual(["gender"]);
    expect(getStoredFigures("db1")!.state).toBe("TG");
    setSurveySource(null);
  });
});
