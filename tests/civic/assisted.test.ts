import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession, getDb, getStore, grantRole, migrate, resetDbForTests, verifyAuditChain } from "../../server/civic/core";
import { actorPseudonym } from "../../server/civic/core/pseudonyms";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { adminRouter, base32Decode, totp } from "../../server/civic/admin/routes";
import { createIssuesRouter } from "../../server/civic/issues/routes";
import { createAssistedRouter } from "../../server/civic/assisted/routes";
import { setAssistedRandom } from "../../server/civic/assisted/service";
import { exportRows, feedPage, listIssues, publicIssue, resetExportRate } from "../../server/civic/issues/public";
import { departmentMetrics, officerQueue, grantRole as grantOfficer, clock } from "../../server/civic/issues/service";
import { resetLexiconCache } from "../../server/civic/issues/moderation";

let server: Server, base = "";
const T0 = new Date("2026-03-01T10:00:00Z");
const ENV_KEYS = ["ASSISTED_ENABLED", "ASSISTED_SUNSET_DATE", "ASSISTED_PAIR_DAILY_CAP", "ASSISTED_VILLAGE_DAILY_CAP", "ASSISTED_RECHECK_SAMPLE", "ASSISTED_RECHECK_NEW_PAIR_N", "ASSISTED_SUNSET", "ASSISTED_SUSPEND_THRESHOLD", "ASSISTED_SUSPEND_MIN_CHECKED", "ASSISTED_RATE_PER_MIN", "ASSISTED_RECEIPT_ATTEMPTS_PER_HOUR", "ASSISTED_ALERT_SHARE", "ASSISTED_ALERT_MIN_ISSUES", "ASSISTED_ALERT_UNCONFIRMED_RATE", "ASSISTED_ALERT_MIN_CHECKED", "ASSISTED_ALERT_DAYS"];
const on = (extra: Record<string, string> = {}) => { process.env.ASSISTED_ENABLED = "1"; process.env.ASSISTED_SUNSET_DATE = "2999-12-31"; Object.assign(process.env, extra); };

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/civic/admin", adminRouter);
  app.use("/api/v1/civic/assisted", createAssistedRouter());
  app.use("/api/v1/civic/issues", express.json(), createIssuesRouter());
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  process.env.CIVIC_TOTP_WINDOW = "60";
  resetDbForTests(); migrate(); loadDemoGeo(); resetLexiconCache(); resetExportRate(); setAssistedRandom(null);
  for (const k of ENV_KEYS) delete process.env[k];
  clock.now = () => new Date();
});
afterEach(() => { delete process.env.CIVIC_TOTP_WINDOW; for (const k of ENV_KEYS) delete process.env[k]; setAssistedRandom(null); clock.now = () => new Date(); });

function person(roles: ("volunteer" | "assist_coordinator" | "assist_reviewer" | "admin")[] = [], jurisdiction: string | null = null) {
  const id = randomUUID(), now = new Date().toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from) VALUES (?,?,?)").run(id, now, now);
  for (const r of roles) grantRole("system", id, r, r === "volunteer" || r === "admin" ? null : jurisdiction);
  return { id, token: createSession(id) };
}
type P = ReturnType<typeof person>;
async function call(token: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: Record<string, any> = {};
  try { json = t ? JSON.parse(t) : {}; } catch { /* not json */ }
  return { status: r.status, body: json, text: t };
}
const ticks = { adult: true, explained: true, willing_self: true, deletion_known: true };
let n = 0;
const words = ["pump", "road", "school", "lamp", "drain", "bridge", "clinic", "canal", "well", "market"];
const fresh = () => { n++; return `${words[n % words.length]} ${["alpha", "beta", "gamma", "delta", "kappa", "sigma", "omega", "theta"][n % 8]} ${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + ((n * 7) % 26))} needs repair near the temple`; };
const entry = (over: Record<string, unknown> = {}) => ({ category: "water", description_en: fresh(), adult_attested: true, consent_a: ticks, consent_b: ticks, ...over });

/** A coordinator, two volunteers, and an active pair in DEMO-V-KLR. */
async function setup(village = "DEMO-V-KLR") {
  const coord = person(["assist_coordinator"]);
  const a = person(["volunteer"]), b = person(["volunteer"]);
  const made = await call(coord.token, "POST", "/assisted/pairs", { village_lgd: village, member_a: a.id, member_b: b.id, label: "SHG pair" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { coord, a, b, pairId: made.body.id as string };
}
const record = (a: P, b: P, body: Record<string, unknown> = entry()) => call(a.token, "POST", "/assisted/records", body, { "x-assist-partner-authorization": "Bearer " + b.token });
const q = <T = Record<string, any>>(sql: string, ...args: unknown[]) => getStore("issues").prepare(sql).all(...(args as never[])) as T[];

async function adminWithMfa() {
  const p = person(["admin"]);
  const en = await call(p.token, "POST", "/admin/mfa/enrol");
  const secret = base32Decode(en.body.secret);
  let step = 0;
  const code = () => totp(secret, Date.now() + 30_000 * ++step);
  expect((await call(p.token, "POST", "/admin/mfa/confirm", { code: totp(secret, Date.now()) })).status).toBe(200);
  return { ...p, mfa: () => ({ "x-totp-code": code() }) };
}

describe("feature off by default (S-49)", () => {
  it("every route answers 404 assisted_disabled with no env, without a sunset date, and after the sunset date", async () => {
    const p = person(["volunteer"]);
    const probes: [string, string, unknown?][] = [["GET", "/assisted/my-pair"], ["POST", "/assisted/records", {}], ["GET", "/assisted/segment"], ["POST", "/assisted/receipts/status", { code: "x" }], ["POST", "/assisted/receipts/delete", {}], ["POST", "/assisted/pairs", {}], ["GET", "/assisted/pairs"], ["GET", "/assisted/rechecks"], ["GET", "/assisted/switch"]];
    const all = async () => { for (const [m, path_, b] of probes) { const r = await call(p.token, m, path_, b); expect([m, path_, r.status, r.body.code]).toEqual([m, path_, 404, "assisted_disabled"]); } };
    await all(); // nothing set
    process.env.ASSISTED_ENABLED = "1"; await all(); // enabled but no sunset date
    process.env.ASSISTED_SUNSET_DATE = "not-a-date"; await all();
    process.env.ASSISTED_SUNSET_DATE = "2020-01-01"; await all(); // sunset passed: switches itself off
    process.env.ASSISTED_ENABLED = "0"; process.env.ASSISTED_SUNSET_DATE = "2999-12-31"; await all(); // sunset fine but not enabled
    on(); expect((await call(p.token, "GET", "/assisted/segment")).status).toBe(200);
  });

  it("the public issue detail of an assisted report disappears when the feature is switched off", async () => {
    on();
    const { a, b } = await setup();
    const r = await record(a, b);
    expect(r.status).toBe(201);
    expect(publicIssue(r.body.id).channel).toBe("assisted");
    process.env.ASSISTED_ENABLED = "0";
    expect(() => publicIssue(r.body.id)).toThrow(/not found/);
  });
});

describe("pairs (coordinator)", () => {
  it("only a coordinator in scope forms a pair, of two different enrolled volunteers, never self-formed", async () => {
    on();
    const coord = person(["assist_coordinator"], "DEMO-M-KLP");
    const a = person(["volunteer"]), b = person(["volunteer"]), plain = person([]);
    expect((await call(a.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: b.id })).status).toBe(403); // a volunteer cannot form their own pair
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-HNK", member_a: a.id, member_b: b.id })).body.code).toBe("outside_scope");
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: a.id })).body.code).toBe("two_assistants_required");
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: plain.id })).body.code).toBe("not_a_volunteer");
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: "nobody" })).body.code).toBe("volunteer_not_found");
    const ok = await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: b.id });
    expect(ok.status).toBe(201);
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-KLR", member_a: a.id, member_b: person(["volunteer"]).id })).body.code).toBe("already_paired");
    expect(JSON.stringify(q("SELECT * FROM assist_pair"))).not.toContain(a.id); // pseudonyms only
    expect((await call(a.token, "GET", "/assisted/my-pair")).body).toMatchObject({ in_pair: true, pair_id: ok.body.id });
  });

  it("a coordinator suspends a pair; the pair can no longer record; the suspension is audited", async () => {
    on();
    const { coord, a, b, pairId } = await setup();
    expect((await record(a, b)).status).toBe(201);
    expect((await call(coord.token, "POST", `/assisted/pairs/${pairId}/suspend`, { reason: "x" })).status).toBe(400);
    expect((await call(coord.token, "POST", `/assisted/pairs/${pairId}/suspend`, { reason: "complaint from the village" })).status).toBe(200);
    const r = await record(a, b);
    expect(r.status).toBe(403); expect(r.body.code).toBe("pair_suspended");
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.pair.suspend'").get()).toMatchObject({ c: 1 });
  });
});

describe("recording: the two-assistant rule, consent, adults only, no personal fields", () => {
  it("needs both assistants signed in on the request, and they must be the formed pair", async () => {
    on();
    const { a, b } = await setup();
    const outsider = person(["volunteer"]);
    expect((await call(a.token, "POST", "/assisted/records", entry())).body.code).toBe("partner_auth_required"); // no second login
    expect((await call(null, "POST", "/assisted/records", entry(), { "x-assist-partner-authorization": "Bearer " + b.token })).status).toBe(401);
    expect((await call(a.token, "POST", "/assisted/records", entry(), { "x-assist-partner-authorization": "Bearer bogus-token" })).body.code).toBe("partner_auth_required");
    expect((await call(a.token, "POST", "/assisted/records", entry(), { "x-assist-partner-authorization": "Bearer " + a.token })).body.code).toBe("two_assistants_required"); // the same person twice
    expect((await record(a, outsider)).body.code).toBe("not_a_pair");
    expect((await record(outsider, a)).body.code).toBe("not_a_pair");
    expect(q("SELECT * FROM assisted_record")).toEqual([]);
    expect((await record(b, a)).status).toBe(201); // either order
  });

  it("refuses without both assistants' consent ticks, and refuses when adulthood is not attested (minors)", async () => {
    on();
    const { a, b } = await setup();
    const miss = await record(a, b, entry({ consent_b: { ...ticks, willing_self: false } }));
    expect(miss.status).toBe(422); expect(miss.body).toMatchObject({ code: "consent_required", assistant: "b", missing: ["willing_self"] });
    expect((await record(a, b, entry({ consent_a: undefined }))).body.code).toBe("consent_required");
    expect((await record(a, b, entry({ adult_attested: false }))).body.code).toBe("adult_required");
    expect((await record(a, b, entry({ adult_attested: undefined }))).body.code).toBe("adult_required");
    expect((await record(a, b, entry({ minor: true }))).body.code).toBe("adult_required");
    expect(q("SELECT * FROM assisted_record")).toEqual([]);
  });

  it("refuses any field about the person, media and GPS; stores no personal field; keeps the receipt only as a keyed hash", async () => {
    on();
    const { a, b, pairId } = await setup();
    for (const f of ["name", "phone", "aadhaar", "age", "dob", "address", "voter_id", "person_id", "photo_ref", "voice_ref", "lat", "email"]) {
      const r = await record(a, b, entry({ [f]: "x" }));
      expect([f, r.status, r.body.code]).toEqual([f, 400, "personal_field_not_allowed"]);
    }
    const ok = await record(a, b);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ channel: "assisted", held: false, pair_id: pairId });
    expect(ok.body.receipt_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const rec = q("SELECT * FROM assisted_record")[0];
    expect(Object.keys(rec).sort()).toEqual(["consent_at", "consent_by_a", "consent_by_b", "created_at", "deleted_at", "flagged", "issue_id", "pair_id", "receipt_code_hash", "recheck_due", "recheck_state", "village_lgd"]);
    const dump = JSON.stringify([q("SELECT * FROM assisted_record"), q("SELECT * FROM assist_pair"), q("SELECT * FROM issue"), q("SELECT * FROM assist_recheck")]);
    for (const secret of [ok.body.receipt_code, ok.body.receipt_code.replace(/-/g, ""), a.id, b.id]) expect(dump).not.toContain(secret);
    expect(rec.receipt_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.consent_by_a).toBe(actorPseudonym(a.id)); expect(rec.consent_by_b).toBe(actorPseudonym(b.id));
    expect(q("SELECT reporter_id, channel FROM issue")[0]).toEqual({ reporter_id: "assisted", channel: "assisted" });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_me_too").get()).toMatchObject({ c: 0 });
    expect(getDb().prepare("SELECT COUNT(*) c FROM issue_links").get()).toMatchObject({ c: 0 }); // nobody's "my issues" either
    const acts = (getStore("audit").prepare("SELECT action, object FROM audit_log WHERE action LIKE 'assisted.%'").all() as { action: string; object: string }[]);
    expect(acts.map((x) => x.action)).toContain("assisted.record");
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("holds party and candidate topics (and linter hits) for review: recorded, not shown", async () => {
    on();
    const { a, b } = await setup();
    const held = await record(a, b, entry({ description_en: "Ask the party candidate to fix the pump " + fresh() }));
    expect(held.status).toBe(201); expect(held.body.held).toBe(true);
    const te = await record(a, b, entry({ description_en: undefined, description_te: "పార్టీ అభ్యర్థి బావి మరమ్మతు చేయాలి" }));
    expect(te.body.held).toBe(true);
    expect(q("SELECT moderation, moderation_reason FROM issue WHERE id=?", held.body.id)[0]).toMatchObject({ moderation: "held" });
    expect(q("SELECT moderation_reason r FROM issue WHERE id=?", held.body.id)[0].r).toContain("party_or_candidate_topic");
    const seg = await call(null, "GET", "/assisted/segment");
    expect(seg.body.items).toEqual([]);
  });
});

describe("caps", () => {
  it("the default per-pair daily cap is 15 and a 16th record is refused", async () => {
    on({ ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "100" });
    const { a, b } = await setup();
    for (let i = 0; i < 15; i++) expect((await record(a, b)).status, "record " + i).toBe(201);
    const r = await record(a, b);
    expect(r.status).toBe(429); expect(r.body).toMatchObject({ code: "pair_daily_cap", limit: 15 });
  });

  it("a per-village daily cap holds across pairs; another village is not affected", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "10", ASSISTED_VILLAGE_DAILY_CAP: "3" });
    const p1 = await setup(), p2 = await setup(), p3 = await setup("DEMO-V-HNK");
    for (const [x, y] of [[p1.a, p1.b], [p1.a, p1.b], [p2.a, p2.b]] as [P, P][]) expect((await record(x, y)).status).toBe(201);
    const r = await record(p2.a, p2.b);
    expect(r.status).toBe(429); expect(r.body.code).toBe("village_daily_cap");
    expect((await record(p3.a, p3.b)).status).toBe(201);
  });

  it("the per-assistant rate limit answers 429", async () => {
    on({ ASSISTED_RATE_PER_MIN: "2" });
    const { a, b } = await setup();
    expect((await record(a, b)).status).toBe(201); expect((await record(a, b)).status).toBe(201);
    expect((await record(a, b)).body.code).toBe("rate_limited");
  });
});

describe("exclusion: assisted records never reach counts, rankings, feed ordering or survey tooling", () => {
  it("are absent from the feed, list, export, department metrics and officer metrics; shown only in the labelled segment with channel: assisted", async () => {
    on();
    const { a, b } = await setup();
    const rec = await record(a, b);
    const org = person([]);
    const organic = await call(org.token, "POST", "/issues", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "Hand pump broken near the school ground " + fresh() });
    expect(organic.status, JSON.stringify(organic.body)).toBe(201);
    expect(feedPage({}).events.map((e: any) => e.issue_id)).toEqual([organic.body.id]);
    expect(listIssues({}).items.map((i: any) => i.id)).toEqual([organic.body.id]);
    expect(exportRows({}).rows.map((i: any) => i.id)).toEqual([organic.body.id]);
    expect((await call(null, "GET", "/issues/feed")).body.events.map((e: any) => e.issue_id)).toEqual([organic.body.id]);
    expect(JSON.stringify(departmentMetrics())).not.toContain(rec.body.id);
    expect(q("SELECT COUNT(*) c FROM issue WHERE channel='assisted' AND moderation='ok'")[0].c).toBe(1);
    // detail carries the channel; the segment is separate and labelled
    expect((await call(null, "GET", `/issues/${rec.body.id}`)).body).toMatchObject({ channel: "assisted" });
    expect((await call(null, "GET", `/issues/${organic.body.id}`)).body.channel).toBe("app");
    const seg = await call(null, "GET", "/assisted/segment");
    expect(seg.body).toMatchObject({ segment: "assisted", label_en: "Reported with assistance" });
    expect(seg.body.label_te).toContain("సహాయంతో");
    expect(seg.body.items.map((i: any) => i.id)).toEqual([rec.body.id]);
    expect(seg.body.items.every((i: any) => i.channel === "assisted")).toBe(true);
    expect(seg.body.items[0]).not.toHaveProperty("support");
    // officers still see and work them, marked
    grantOfficer("off-1", "officer", null, null, "officer");
    expect(officerQueue("off-1").items.find((i: any) => i.id === rec.body.id)).toMatchObject({ channel: "assisted" });
  });

  it("an organic report never merges into an assisted one, and nobody can add 'me too' to an assisted report", async () => {
    on();
    const { a, b } = await setup();
    const text = "The only hand pump in the lane has stopped working this week";
    const rec = await record(a, b, entry({ description_en: text }));
    const org = person([]);
    const same = await call(org.token, "POST", "/issues", { category: "water", village_lgd: "DEMO-V-KLR", description_en: text });
    expect(same.status).toBe(201); expect(same.body.merged).toBe(false); expect(same.body.id).not.toBe(rec.body.id);
    const mt = await call(org.token, "POST", `/issues/${rec.body.id}/me-too`);
    expect(mt.status).toBe(409); expect(mt.body.code).toBe("assisted_no_me_too");
    expect(q("SELECT COUNT(*) c FROM issue_me_too WHERE issue_id=?", rec.body.id)[0].c).toBe(0);
  });

  it("survey and consultation code never reads assisted data, and recording writes nothing to the survey store", async () => {
    on();
    const { a, b } = await setup();
    const sv = getStore("survey"), tables = (sv.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const count = () => tables.map((t) => (sv.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c);
    const before = count();
    await record(a, b);
    expect(count()).toEqual(before);
    const hr = getDb().prepare("SELECT COUNT(*) c FROM has_responded").get();
    expect(hr).toMatchObject({ c: 0 });
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    for (const root of ["server/civic/surveys", "server/civic/consultations"]) {
      for (const f of walk(root)) {
        const src = fs.readFileSync(f, "utf8");
        expect(src, f).not.toMatch(/assisted_record|assist_pair|assist_recheck|assisted_switch|from "\.\.\/assisted\//);
        expect(src, f).not.toMatch(/FROM\s+issue\b/i);
      }
    }
  });

  it("no ranking or ordering code reads the assisted tables (only the assisted module and the channel filters do)", () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
    for (const f of walk("server/civic")) {
      if (f.replace(/\\/g, "/").includes("/assisted/") || f.endsWith("stores.ts")) continue;
      if (/assisted_record|assist_pair|assist_recheck/.test(fs.readFileSync(f, "utf8"))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

describe("re-check queue: sampling", () => {
  it("re-checks every one of a new pair's first 10 records, then the configured share at random (default 20%)", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000" });
    const { a, b } = await setup();
    setAssistedRandom(() => 0.99); // never drawn at random
    for (let i = 0; i < 10; i++) expect((await record(a, b)).body.recheck_queued, "first 10: " + i).toBe(true);
    expect((await record(a, b)).body.recheck_queued).toBe(false);
    setAssistedRandom(() => 0.19); expect((await record(a, b)).body.recheck_queued).toBe(true); // under 20%
    setAssistedRandom(() => 0.21); expect((await record(a, b)).body.recheck_queued).toBe(false);
    process.env.ASSISTED_RECHECK_SAMPLE = "0.5"; setAssistedRandom(() => 0.4); expect((await record(a, b)).body.recheck_queued).toBe(true);
    expect(q("SELECT COUNT(*) c FROM assisted_record WHERE recheck_state='queued'")[0].c).toBe(12);
    expect(q("SELECT recheck_due, created_at FROM assisted_record WHERE recheck_state='queued' LIMIT 1")[0].recheck_due).toBeTruthy();
  });

  it("samples a pair in full once a record of it was flagged by the person", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000", ASSISTED_RECHECK_NEW_PAIR_N: "0", ASSISTED_RECHECK_SAMPLE: "0" });
    const { a, b } = await setup();
    const r1 = await record(a, b);
    expect(r1.body.recheck_queued).toBe(false);
    expect((await call(null, "POST", "/assisted/receipts/report", { code: r1.body.receipt_code })).body).toMatchObject({ reported: true });
    expect(q("SELECT recheck_state, flagged FROM assisted_record WHERE issue_id=?", r1.body.id)[0]).toEqual({ recheck_state: "queued", flagged: 1 });
    expect((await record(a, b)).body.recheck_queued).toBe(true);
  });
});

describe("reviewer re-check", () => {
  it("lists the queue within scope, logs outcomes, and a not-confirmed record leaves the public segment", async () => {
    on();
    const { a, b } = await setup();
    const r = await record(a, b);
    const reviewer = person(["assist_reviewer"], "DEMO-M-KLP"), farReviewer = person(["assist_reviewer"], "DEMO-M-HNK");
    expect((await call(a.token, "GET", "/assisted/rechecks")).status).toBe(403);
    expect((await call(farReviewer.token, "GET", "/assisted/rechecks")).body.items).toEqual([]);
    const queue = await call(reviewer.token, "GET", "/assisted/rechecks");
    expect(queue.body.items.map((i: any) => i.record_id)).toEqual([r.body.id]);
    expect(queue.body.items[0]).toMatchObject({ pair_id: expect.any(String), overdue: false });
    expect(JSON.stringify(queue.body)).not.toMatch(/member|phone/);
    expect((await call(farReviewer.token, "POST", `/assisted/rechecks/${r.body.id}`, { outcome: "confirmed" })).body.code).toBe("outside_scope");
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r.body.id}`, { outcome: "maybe" })).body.code).toBe("invalid_outcome");
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r.body.id}`, { outcome: "not_confirmed", note: "the person said these were not their words" })).status).toBe(200);
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r.body.id}`, { outcome: "confirmed" })).body.code).toBe("not_queued"); // one outcome per record
    expect(q("SELECT outcome, reviewer_id FROM assist_recheck")).toEqual([{ outcome: "not_confirmed", reviewer_id: actorPseudonym(reviewer.id) }]);
    expect(q("SELECT moderation, moderation_reason FROM issue WHERE id=?", r.body.id)[0]).toEqual({ moderation: "held", moderation_reason: "assisted_not_confirmed" });
    expect((await call(null, "GET", "/assisted/segment")).body.items).toEqual([]);
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.recheck'").get()).toMatchObject({ c: 1 });
    expect((await call(reviewer.token, "GET", "/assisted/rechecks")).body.items).toEqual([]);
  });

  it("confirmed and unreachable outcomes keep the record visible; a reviewer cannot check their own pair's record", async () => {
    on();
    const { a, b } = await setup();
    const r1 = await record(a, b), r2 = await record(a, b);
    const reviewer = person(["assist_reviewer"]);
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r1.body.id}`, { outcome: "confirmed" })).status).toBe(200);
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r2.body.id}`, { outcome: "unreachable" })).status).toBe(200);
    expect((await call(null, "GET", "/assisted/segment")).body.items.length).toBe(2);
    // a reviewer who is also a member of the pair (a second pair here) is kept away from that pair's records
    const insider = person(["volunteer", "assist_reviewer"]);
    const coord = person(["assist_coordinator"]);
    const mate = person(["volunteer"]);
    expect((await call(coord.token, "POST", "/assisted/pairs", { village_lgd: "DEMO-V-ANM", member_a: insider.id, member_b: mate.id })).status).toBe(201);
    const own = await record(insider, mate);
    expect((await call(insider.token, "GET", "/assisted/rechecks")).body.items.map((i: any) => i.record_id)).not.toContain(own.body.id);
    expect((await call(insider.token, "POST", `/assisted/rechecks/${own.body.id}`, { outcome: "confirmed" })).body.code).toBe("own_record");
  });

  it("suspends a pair automatically when the not-confirmed rate is above the threshold after at least 5 checked records", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000" });
    const { a, b, pairId } = await setup();
    const reviewer = person(["assist_reviewer"]);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await record(a, b)).body.id);
    const check = (id: string, outcome: string) => call(reviewer.token, "POST", `/assisted/rechecks/${id}`, { outcome });
    // 2 of 4 not confirmed is above 25% but fewer than 5 checked: no suspension yet
    expect((await check(ids[0], "not_confirmed")).body.pair_suspended).toBe(false);
    expect((await check(ids[1], "confirmed")).body.pair_suspended).toBe(false);
    expect((await check(ids[2], "not_confirmed")).body.pair_suspended).toBe(false);
    expect((await check(ids[3], "unreachable")).body.pair_suspended).toBe(false); // unreachable does not count as checked
    expect((await check(ids[4], "confirmed")).body.pair_suspended).toBe(false); // 4 checked
    const last = await check(ids[5], "confirmed"); // 5 checked, 2 of 5 = 40% > 25%
    expect(last.body.pair_suspended).toBe(true);
    expect(q("SELECT status, suspended_reason, suspended_by FROM assist_pair WHERE id=?", pairId)[0]).toMatchObject({ status: "suspended", suspended_by: "auto" });
    expect((await record(a, b)).body.code).toBe("pair_suspended");
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.pair.auto_suspend'").get()).toMatchObject({ c: 1 });
  });

  it("does not suspend at or below the threshold (1 of 5 is 20%), and the threshold and minimum are configurable", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000" });
    const { a, b, pairId } = await setup();
    const reviewer = person(["assist_reviewer"]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await record(a, b)).body.id);
    for (let i = 0; i < 5; i++) await call(reviewer.token, "POST", `/assisted/rechecks/${ids[i]}`, { outcome: i === 0 ? "not_confirmed" : "confirmed" });
    expect(q("SELECT status FROM assist_pair WHERE id=?", pairId)[0].status).toBe("active");
    process.env.ASSISTED_SUSPEND_THRESHOLD = "0.1"; process.env.ASSISTED_SUSPEND_MIN_CHECKED = "6";
    const more = (await record(a, b)).body.id;
    await call(reviewer.token, "POST", `/assisted/rechecks/${more}`, { outcome: "confirmed" }); // 6 checked, 1 of 6 = 16.7% > 10%
    expect(q("SELECT status FROM assist_pair WHERE id=?", pairId)[0].status).toBe("suspended");
  });
});

describe("receipts: status, deletion, no phone and no account", () => {
  it("the person checks, then deletes by receipt: words erased, stub kept, gone from the segment, idempotent; wrong codes are 404 and rate limited", async () => {
    on({ ASSISTED_RECEIPT_ATTEMPTS_PER_HOUR: "8" });
    const { a, b } = await setup();
    const r = await record(a, b);
    const code = r.body.receipt_code as string;
    const st = await call(null, "POST", "/assisted/receipts/status", { code: code.toLowerCase().replace(/-/g, " ") });
    expect(st.body).toMatchObject({ channel: "assisted", state: "published", deleted: false, category: "water" });
    expect(JSON.stringify(st.body)).not.toMatch(/pair|member/);
    expect((await call(null, "POST", "/assisted/receipts/status", { code: "ABCD-EFGH-JKLM" })).status).toBe(404);
    const del = await call(null, "POST", "/assisted/receipts/delete", { code });
    expect(del.body).toEqual({ deleted: true, already: false });
    expect((await call(null, "POST", "/assisted/receipts/delete", { code })).body).toEqual({ deleted: true, already: true });
    expect(q("SELECT desc_en, desc_te, moderation, moderation_reason FROM issue WHERE id=?", r.body.id)[0]).toEqual({ desc_en: null, desc_te: null, moderation: "taken_down", moderation_reason: "deleted_by_receipt" });
    expect(q("SELECT recheck_state, deleted_at FROM assisted_record WHERE issue_id=?", r.body.id)[0].recheck_state).toBe("deleted"); // stub kept for counts
    expect((await call(null, "GET", "/assisted/segment")).body.items).toEqual([]);
    expect((await call(null, "POST", "/assisted/receipts/status", { code })).body).toMatchObject({ deleted: true, state: "deleted", category: null });
    const reviewer = person(["assist_reviewer"]);
    expect((await call(reviewer.token, "GET", "/assisted/rechecks")).body.items).toEqual([]); // a deleted record is not re-checked
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${r.body.id}`, { outcome: "confirmed" })).status).toBe(410);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call(null, "POST", "/assisted/receipts/status", { code: "ZZZZ-ZZZZ-ZZZ" + i })).status;
    expect(last).toBe(429);
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.delete'").get()).toMatchObject({ c: 1 });
  });
});

describe("kill switch under dual control", () => {
  it("two different admins with TOTP disable it; a self-approval is refused; the record routes then answer disabled until it is lifted the same way", async () => {
    on();
    const { a, b } = await setup();
    const admin1 = await adminWithMfa(), admin2 = await adminWithMfa();
    expect((await record(a, b)).status).toBe(201);
    expect((await call(admin1.token, "POST", "/assisted/switch/requests", { action: "disable", reason: "pilot paused" })).status).toBe(403); // no TOTP
    expect((await call(a.token, "GET", "/assisted/switch")).status).toBe(403); // not an admin
    const req = await call(admin1.token, "POST", "/assisted/switch/requests", { action: "disable", reason: "pilot paused for review" }, admin1.mfa());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await record(a, b)).status).toBe(201); // nothing changes until approved
    const self = await call(admin1.token, "POST", `/assisted/switch/requests/${req.body.id}/approve`, {}, admin1.mfa());
    expect(self.status).toBe(403); expect(self.body.code).toBe("dual_control");
    expect((await call(admin2.token, "POST", `/assisted/switch/requests/${req.body.id}/approve`, {})).status).toBe(403); // no TOTP
    const ok = await call(admin2.token, "POST", `/assisted/switch/requests/${req.body.id}/approve`, {}, admin2.mfa());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body).toMatchObject({ status: "approved", enabled: false });
    expect((await record(a, b)).body.code).toBe("assisted_disabled");
    expect((await call(null, "GET", "/assisted/segment")).body.code).toBe("assisted_disabled");
    const status = await call(admin1.token, "GET", "/assisted/switch");
    expect(status.body).toMatchObject({ enabled: false, reason: "kill_switch", kill_switch_engaged: true });
    expect((await call(admin1.token, "POST", "/assisted/switch/requests", { action: "disable", reason: "again, to be sure" }, admin1.mfa())).body.code).toBe("already_in_state");
    const lift = await call(admin2.token, "POST", "/assisted/switch/requests", { action: "enable", reason: "review finished, resume" }, admin2.mfa());
    expect(lift.status).toBe(201);
    expect((await call(admin1.token, "POST", `/assisted/switch/requests/${lift.body.id}/approve`, {}, admin1.mfa())).status).toBe(200);
    expect((await record(a, b)).status).toBe(201);
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'assisted.switch.%'").all() as { action: string }[]).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["assisted.switch.request", "assisted.switch.approve", "assisted.switch.self_approval_refused"]));
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("the kill switch cannot re-enable what the environment turned off", async () => {
    const admin1 = await adminWithMfa();
    process.env.ASSISTED_ENABLED = "0";
    expect((await call(admin1.token, "GET", "/assisted/switch")).body.code).toBe("assisted_disabled");
  });
});


describe("lifting suspensions (S-49 a)", () => {
  it("a coordinator lifts a manual suspension; an automatic one needs two admins; the pair then gets a fresh start", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000" });
    const { coord, a, b, pairId } = await setup();
    const other = person(["assist_coordinator"], "DEMO-M-HNK");
    await call(coord.token, "POST", `/assisted/pairs/${pairId}/suspend`, { reason: "paused for training" });
    expect((await record(a, b)).body.code).toBe("pair_suspended");
    expect((await call(other.token, "POST", `/assisted/pairs/${pairId}/reinstate`, { reason: "back to work" })).body.code).toBe("outside_scope");
    expect((await call(coord.token, "POST", `/assisted/pairs/${pairId}/reinstate`, { reason: "x" })).status).toBe(400);
    expect((await call(coord.token, "POST", `/assisted/pairs/${pairId}/reinstate`, { reason: "training finished" })).body).toMatchObject({ status: "active" });
    expect((await record(a, b)).status).toBe(201);
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.pair.reinstate'").get()).toMatchObject({ c: 1 });
    // automatic suspension: 2 of 5 not confirmed
    const reviewer = person(["assist_reviewer"]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await record(a, b)).body.id);
    for (let i = 0; i < 5; i++) await call(reviewer.token, "POST", `/assisted/rechecks/${ids[i]}`, { outcome: i < 2 ? "not_confirmed" : "confirmed" });
    expect(q("SELECT status, suspended_by FROM assist_pair WHERE id=?", pairId)[0]).toEqual({ status: "suspended", suspended_by: "auto" });
    const no = await call(coord.token, "POST", `/assisted/pairs/${pairId}/reinstate`, { reason: "I think it is fine" });
    expect(no.status).toBe(409); expect(no.body.code).toBe("auto_suspended_needs_dual_control");
    const admin1 = await adminWithMfa(), admin2 = await adminWithMfa();
    expect((await call(admin1.token, "POST", `/assisted/pairs/${pairId}/reinstate-request`, { reason: "reviewed the evidence" })).status).toBe(403); // no TOTP
    const req = await call(admin1.token, "POST", `/assisted/pairs/${pairId}/reinstate-request`, { reason: "reviewed the evidence" }, admin1.mfa());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await call(admin1.token, "POST", `/assisted/switch/requests/${req.body.id}/approve`, {}, admin1.mfa())).body.code).toBe("dual_control");
    expect(q("SELECT status FROM assist_pair WHERE id=?", pairId)[0].status).toBe("suspended");
    expect((await call(admin2.token, "POST", `/assisted/switch/requests/${req.body.id}/approve`, {}, admin2.mfa())).status).toBe(200);
    expect(q("SELECT status FROM assist_pair WHERE id=?", pairId)[0].status).toBe("active");
    expect((await record(a, b)).status).toBe(201);
    // earlier outcomes do not count against the fresh start: one more not-confirmed does not re-suspend
    const again = (await record(a, b)).body.id;
    expect((await call(reviewer.token, "POST", `/assisted/rechecks/${again}`, { outcome: "not_confirmed" })).body.pair_suspended).toBe(false);
    expect(getStore("audit").prepare("SELECT COUNT(*) c FROM audit_log WHERE action='assisted.pair.reinstate_request'").get()).toMatchObject({ c: 1 });
  });
});

describe("area hold (S-49 b)", () => {
  it("a coordinator or reviewer in scope stops and resumes recording for a village or mandal; others are not affected", async () => {
    on();
    const p1 = await setup(), p2 = await setup("DEMO-V-HNK");
    const mandalCoord = person(["assist_coordinator"], "DEMO-M-KLP");
    const far = person(["assist_coordinator"], "DEMO-M-HNK");
    const reviewer = person(["assist_reviewer"], "DEMO-V-KLR");
    expect((await call(far.token, "POST", "/assisted/areas/DEMO-M-KLP/suspend", { reason: "not my area" })).body.code).toBe("outside_scope");
    expect((await call(mandalCoord.token, "POST", "/assisted/areas/DEMO-S-AP/suspend", { reason: "too wide an area" })).body.code).toBe("invalid_unit");
    expect((await call(mandalCoord.token, "POST", "/assisted/areas/DEMO-M-KLP/suspend", { reason: "x" })).status).toBe(400);
    expect((await call(mandalCoord.token, "POST", "/assisted/areas/DEMO-M-KLP/suspend", { reason: "dispute in the village" })).body).toEqual({ unit: "DEMO-M-KLP", held: true });
    const held = await record(p1.a, p1.b);
    expect(held.status).toBe(403); expect(held.body.code).toBe("village_suspended");
    expect((await record(p2.a, p2.b)).status).toBe(201); // another mandal
    expect((await call(mandalCoord.token, "GET", "/assisted/areas/holds")).body.holds.map((h: any) => h.unit)).toEqual(["DEMO-M-KLP"]);
    expect((await call(reviewer.token, "POST", "/assisted/areas/DEMO-M-KLP/resume", { reason: "wider than my area" })).body.code).toBe("outside_scope");
    expect((await call(mandalCoord.token, "POST", "/assisted/areas/DEMO-M-KLP/resume", { reason: "dispute settled" })).body).toEqual({ unit: "DEMO-M-KLP", held: false });
    expect((await record(p1.a, p1.b)).status).toBe(201);
    expect((await call(reviewer.token, "POST", "/assisted/areas/DEMO-V-KLR/suspend", { reason: "reviewer concern" })).status).toBe(200); // a reviewer may stop a village
    expect((await record(p1.a, p1.b)).body.code).toBe("village_suspended");
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'assisted.village.%' ORDER BY seq").all() as { action: string }[]).map((x) => x.action);
    expect(acts).toEqual(["assisted.village.suspend", "assisted.village.resume", "assisted.village.suspend"]);
  });
});

describe("warnings (S-49 c)", () => {
  it("shows an unconfirmed-rate warning above the env threshold after enough checks, and an assisted-share warning, scoped to the viewer", async () => {
    on({ ASSISTED_PAIR_DAILY_CAP: "100", ASSISTED_VILLAGE_DAILY_CAP: "100", ASSISTED_RATE_PER_MIN: "1000", ASSISTED_SUSPEND_MIN_CHECKED: "50", ASSISTED_ALERT_MIN_ISSUES: "3" });
    const { a, b, pairId } = await setup();
    const reviewer = person(["assist_reviewer"]), far = person(["assist_reviewer"], "DEMO-M-HNK");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await record(a, b)).body.id);
    expect((await call(reviewer.token, "GET", "/assisted/alerts")).body.alerts.some((x: any) => x.kind === "unconfirmed_rate")).toBe(false); // nothing checked yet
    for (let i = 0; i < 5; i++) await call(reviewer.token, "POST", `/assisted/rechecks/${ids[i]}`, { outcome: i === 0 ? "not_confirmed" : "confirmed" });
    expect((await call(reviewer.token, "GET", "/assisted/alerts")).body.alerts.some((x: any) => x.kind === "unconfirmed_rate")).toBe(false); // 20% is not above 25%
    const more = (await record(a, b)).body.id, more2 = (await record(a, b)).body.id;
    await call(reviewer.token, "POST", `/assisted/rechecks/${more}`, { outcome: "not_confirmed" });
    await call(reviewer.token, "POST", `/assisted/rechecks/${more2}`, { outcome: "not_confirmed" }); // 3 of 7
    const al = await call(reviewer.token, "GET", "/assisted/alerts");
    expect(al.body.alerts.find((x: any) => x.kind === "unconfirmed_rate")).toMatchObject({ pair_id: pairId, sample: 7, detail: { not_confirmed: 3, checked: 7 } });
    expect(al.body.thresholds).toMatchObject({ unconfirmed_rate: 0.25, min_checked: 5, assisted_share: 0.3, days: 7 });
    expect(al.body.alerts.find((x: any) => x.kind === "assisted_share")).toMatchObject({ rate: 1, detail: { assisted: 7, total: 7 } }); // only assisted reports in the area in the last 7 days
    expect((await call(far.token, "GET", "/assisted/alerts")).body.alerts).toEqual([]); // outside the viewer's area
    expect((await call(a.token, "GET", "/assisted/alerts")).status).toBe(403);
    // the threshold is configurable; organic reports dilute the share
    process.env.ASSISTED_ALERT_SHARE = "0.9";
    expect((await call(reviewer.token, "GET", "/assisted/alerts")).body.alerts.some((x: any) => x.kind === "assisted_share")).toBe(true);
    const org = person([]);
    for (let i = 0; i < 20; i++) expect((await call(org.token, "POST", "/issues", { category: "roads", village_lgd: "DEMO-V-KLR", description_en: Array.from({ length: 6 }, () => Math.random().toString(36).replace(/[0-9.]/g, "") + "xyz").join(" ") })).status).toBe(201);
    expect((await call(reviewer.token, "GET", "/assisted/alerts")).body.alerts.some((x: any) => x.kind === "assisted_share")).toBe(false);
    const admin = await adminWithMfa();
    expect(Array.isArray((await call(admin.token, "GET", "/assisted/switch")).body.alerts)).toBe(true);
  });
});

describe("a person who lost the receipt (S-49 d)", () => {
  it("a coordinator files a deletion request; a different person in scope approves; nothing is erased before that", async () => {
    on();
    const { coord, a, b, pairId } = await setup();
    const r = await record(a, b, entry({ description_en: "Culvert near the market is broken " + fresh() }));
    const coord2 = person(["assist_coordinator"]), reviewer = person(["assist_reviewer"]), far = person(["assist_coordinator"], "DEMO-M-HNK");
    const list = await call(coord.token, "GET", `/assisted/pairs/${pairId}/records`);
    expect(list.body.records[0]).toMatchObject({ record_id: r.body.id, deleted: false });
    expect((await call(far.token, "GET", `/assisted/pairs/${pairId}/records`)).status).toBe(403);
    expect((await call(a.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "lost the receipt" })).status).toBe(403); // a pair member
    expect((await call(far.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "lost the receipt" })).body.code).toBe("outside_scope");
    expect((await call(coord.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "x" })).status).toBe(400);
    const req = await call(coord.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "the person lost the receipt, identified in person" });
    expect(req.status).toBe(201);
    expect((await call(coord.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "again please" })).body.code).toBe("duplicate");
    expect(q("SELECT desc_en FROM issue WHERE id=?", r.body.id)[0].desc_en).toBeTruthy(); // not yet
    expect((await call(coord.token, "GET", "/assisted/delete-requests")).body.requests[0]).toMatchObject({ id: req.body.id, mine: true });
    const self = await call(coord.token, "POST", `/assisted/delete-requests/${req.body.id}/approve`, {});
    expect(self.status).toBe(403); expect(self.body.code).toBe("dual_control");
    expect((await call(a.token, "POST", `/assisted/delete-requests/${req.body.id}/approve`, {})).status).toBe(403);
    expect((await call(far.token, "POST", `/assisted/delete-requests/${req.body.id}/approve`, {})).body.code).toBe("outside_scope");
    expect(q("SELECT desc_en FROM issue WHERE id=?", r.body.id)[0].desc_en).toBeTruthy();
    const ok = await call(reviewer.token, "POST", `/assisted/delete-requests/${req.body.id}/approve`, {});
    expect(ok.body).toMatchObject({ status: "approved", deleted: true });
    expect(q("SELECT desc_en, desc_te, moderation FROM issue WHERE id=?", r.body.id)[0]).toEqual({ desc_en: null, desc_te: null, moderation: "taken_down" });
    expect(q("SELECT deleted_at FROM assisted_record WHERE issue_id=?", r.body.id)[0].deleted_at).toBeTruthy();
    expect((await call(null, "GET", "/assisted/segment")).body.items).toEqual([]);
    expect((await call(coord2.token, "POST", `/assisted/delete-requests/${req.body.id}/approve`, {})).body.code).toBe("already_decided");
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'assisted.delete%'").all() as { action: string }[]).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["assisted.delete_request", "assisted.delete_request.self_approval_refused", "assisted.delete_request.approve", "assisted.delete"]));
    expect(verifyAuditChain().ok).toBe(true);
  });

  it("a rejected request deletes nothing", async () => {
    on();
    const { coord, a, b } = await setup();
    const r = await record(a, b);
    const reviewer = person(["assist_reviewer"]);
    const req = await call(coord.token, "POST", "/assisted/delete-requests", { record_id: r.body.id, reason: "somebody asked on the phone" });
    expect((await call(reviewer.token, "POST", `/assisted/delete-requests/${req.body.id}/reject`, {})).body).toMatchObject({ status: "rejected", deleted: false });
    expect(q("SELECT desc_en FROM issue WHERE id=?", r.body.id)[0].desc_en).toBeTruthy();
  });
});
void T0;
