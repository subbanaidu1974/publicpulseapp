/**
 * S-30 (@E2E-39) the response store: no timestamps, no person link, separate store from has_responded, shuffled batches, crash-safe journal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { STORE_TABLES, getDb, getStore, storeFile, tablesOf } from "../../../server/civic/core";
import { ownerOfTable } from "../../../server/civic/core/stores";
import {
  afterEnqueue, enqueueResponse, flushResponses, pendingResponses, recoverResponseJournal, responseCounts, setBatching, stopResponseTimer, validateAnswers, ResponseInvalid, type ResponseRecord,
} from "../../../server/civic/surveys/responses";
import { GOOD_ANSWERS, GOOD_STRATA, call, freshWorld, getCredential, mkPerson, mkSurvey, serve, useSurveys } from "./helpers";

let srv: Server, base: string;
beforeEach(async () => { freshWorld(); const s = await serve(); srv = s.s; base = s.base; });
afterEach(() => { srv.close(); stopResponseTimer(); setBatching(null); delete process.env.CIVIC_DB; });

const rec = (n: number, kind: "app" | "assisted" = "app"): ResponseRecord => ({ survey_id: "s1", answers: { n }, strata: { age_band: "25-34", gender: "F", tier: "T1", quality: "normal", mandal: "DEMO-M-KLP" }, kind });
const cols = (store: "survey" | "identity", table: string) => (getStore(store).prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; pk: number }[]);

describe("schema: nothing in a response row can join it to a person or a time", () => {
  const TABLES = ["survey_response", "survey_response_assisted", "response_journal", "spent_token"];

  it("@E2E-39 no timestamp-like or person-like column in any response-side table; the primary key is a text uuid, WITHOUT ROWID, no autoincrement", () => {
    for (const t of TABLES) {
      const names = cols("survey", t).map((c) => c.name);
      for (const n of names) expect(n, `${t}.${n}`).not.toMatch(/(^|_)(at|ts|time|date|day|epoch|created|updated|seq|person|user|phone|ip|session|account)(_|$)/i);
      const sql = (getStore("survey").prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string }).sql;
      expect(sql, t).toMatch(/WITHOUT ROWID/i);
      expect(sql, t).not.toMatch(/AUTOINCREMENT|INTEGER PRIMARY KEY/i);
      expect(sql, t).not.toMatch(/DEFAULT\s*\(?\s*(CURRENT_|datetime|strftime)/i);
    }
    for (const t of ["survey_response", "survey_response_assisted", "response_journal"]) {
      const pk = cols("survey", t).filter((c) => c.pk);
      expect(pk.map((c) => `${c.name}:${c.type}`)).toEqual(["id:TEXT"]);
    }
  });

  it("@E2E-39 has_responded and the responses live in DIFFERENT stores (different files) with disjoint tables", () => {
    expect(ownerOfTable("has_responded")).toBe("identity");
    for (const t of [...TABLES, "survey_signing_key"]) expect(ownerOfTable(t), t).toBe("survey");
    expect(ownerOfTable("cred_idem")).toBe("identity");
    expect(tablesOf(getStore("identity"))).toContain("has_responded");
    expect(tablesOf(getStore("identity"))).not.toContain("survey_response");
    expect(tablesOf(getStore("survey"))).not.toContain("has_responded");
    expect(tablesOf(getStore("survey"))).not.toContain("persons");
    for (const t of TABLES) expect(STORE_TABLES.identity).not.toContain(t);
    process.env.CIVIC_DB = "C:/tmp/civic-x/"; // a directory base: every store is its own file
    expect(storeFile("identity")).not.toBe(storeFile("survey"));
    expect(storeFile("survey")).toMatch(/survey\.db$/);
  });

  it("@E2E-39 after a real flow no value in the survey store contains the person id, the token, the prefix or the signature", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const c = await getCredential(base, who, s.id);
    await call(base, "POST", `/${s.id}/respond`, { body: { ...c.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } });
    flushResponses();
    const d = getStore("survey");
    const needles = [who.id, who.token, c.redeem!.token, c.redeem!.prefix, c.redeem!.signature, Buffer.from(c.redeem!.token, "base64url").toString("hex")];
    for (const t of tablesOf(d)) for (const col of cols("survey", t)) for (const n of needles) {
      const hit = d.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE CAST("${col.name}" AS TEXT) LIKE ?`).get(`%${n}%`) as { c: number };
      expect(hit.c, `${t}.${col.name} holds ${n.slice(0, 8)}`).toBe(0);
    }
    // and the identity side holds no answer: only the has_responded row (day-granular) and the encrypted retry-window row
    expect(getDb().prepare("SELECT ts FROM has_responded WHERE person_id = ?").get(who.id)).toEqual({ ts: "2026-06-01" });
    expect(JSON.stringify(getDb().prepare("SELECT * FROM cred_idem").all())).not.toContain(c.redeem!.token);
  }, 60_000);

  it("@E2E-39 the spent-token table holds only a hash of prefix||token, never the token", async () => {
    const s = mkSurvey(); useSurveys(s);
    const c = await getCredential(base, mkPerson(), s.id);
    await call(base, "POST", `/${s.id}/respond`, { body: { ...c.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } });
    const row = getStore("survey").prepare("SELECT * FROM spent_token").get() as { survey_id: string; token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(Buffer.from(c.redeem!.token, "base64url").toString("hex"));
  }, 60_000);

  it("@E2E-39 the assisted table can only hold channel=assisted, platform_linkable=1", () => {
    const ins = (channel: string, link: number) => getStore("survey").prepare("INSERT INTO survey_response_assisted (id, survey_id, answers, age_band, gender, tier, quality, mandal, channel, platform_linkable) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), "s", "{}", "NA", "NS", "T1", "normal", "NA", channel, link);
    expect(() => ins("app", 1)).toThrow();
    expect(() => ins("assisted", 0)).toThrow();
    expect(() => ins("assisted", 1)).not.toThrow();
  });
});

describe("shuffled batch writer", () => {
  it("@E2E-39 a flushed batch is a random permutation of arrival order, with fresh random ids that carry no order", () => {
    const order: string[] = [];
    setBatching({ flushMs: 3_600_000, flushItems: 1000, onFlush: (b) => order.push(...b.map((x) => x.id)) });
    for (let i = 0; i < 40; i++) enqueueResponse(rec(i));
    expect(pendingResponses()).toBe(40);
    expect(flushResponses()).toBe(40);
    expect(pendingResponses()).toBe(0);
    const byId = new Map((getStore("survey").prepare("SELECT id, answers FROM survey_response").all() as { id: string; answers: string }[]).map((r) => [r.id, (JSON.parse(r.answers) as { n: number }).n]));
    const arrival = order.map((id) => byId.get(id)!);
    expect([...arrival].sort((a, b) => a - b)).toEqual([...Array(40).keys()]); // nothing lost, nothing duplicated
    expect(arrival).not.toEqual([...Array(40).keys()]); // not in arrival order (probability of a false failure 1/40!)
    expect(new Set(order).size).toBe(40);
    for (const id of order) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // the stored order is by uuid, which says nothing about arrival
    const stored = (getStore("survey").prepare("SELECT id FROM survey_response").all() as { id: string }[]).map((r) => byId.get(r.id)!);
    expect(stored).not.toEqual([...Array(40).keys()]);
  });

  it("@E2E-39 the writer writes in the order its shuffle returns (a reversing shuffle reverses the write order)", () => {
    const order: string[] = [];
    setBatching({ flushMs: 3_600_000, flushItems: 1000, shuffle: (arr) => [...arr].sort((x: any, y: any) => y.rec.answers.n - x.rec.answers.n), onFlush: (bt) => order.push(...bt.map((x) => x.id)) });
    for (let i = 0; i < 5; i++) enqueueResponse(rec(i));
    expect(flushResponses()).toBe(5);
    const byId = new Map((getStore("survey").prepare("SELECT id, answers FROM survey_response").all() as { id: string; answers: string }[]).map((r) => [r.id, (JSON.parse(r.answers) as { n: number }).n]));
    expect(order.map((id) => byId.get(id))).toEqual([4, 3, 2, 1, 0]);
  });

  it("@E2E-39 flushes when flushItems are waiting, and on the jittered timer otherwise", async () => {
    setBatching({ flushMs: 3_600_000, flushItems: 3 });
    enqueueResponse(rec(1)); enqueueResponse(rec(2));
    expect(pendingResponses()).toBe(2);
    enqueueResponse(rec(3));
    expect(pendingResponses()).toBe(0);
    expect(responseCounts("s1")).toEqual({ app: 3, assisted: 0 });
    setBatching({ flushMs: 20, flushItems: 1000, random: () => 0 });
    enqueueResponse(rec(4));
    expect(pendingResponses()).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(pendingResponses()).toBe(0);
    expect(responseCounts("s1").app).toBe(4);
  });

  it("@E2E-39 a crash between enqueue and flush loses nothing: the encrypted journal is recovered", () => {
    enqueueResponse(rec(1)); enqueueResponse({ ...rec(2), kind: "assisted" });
    const raw = getStore("survey").prepare("SELECT payload_enc FROM response_journal").all() as { payload_enc: string }[];
    expect(raw).toHaveLength(2);
    for (const r of raw) { expect(r.payload_enc).toMatch(/^v1\./); expect(r.payload_enc).not.toContain("answers"); }
    stopResponseTimer(); // "crash": the in-memory timer and counters are gone, the journal is on disk
    expect(responseCounts("s1")).toEqual({ app: 0, assisted: 0 });
    expect(recoverResponseJournal()).toBe(2);
    expect(responseCounts("s1")).toEqual({ app: 1, assisted: 1 });
    expect(recoverResponseJournal()).toBe(0);
    expect(() => afterEnqueue()).not.toThrow();
  });

  it("@E2E-39 a failed flush leaves the journal intact for the next attempt", () => {
    enqueueResponse(rec(1));
    getStore("survey").exec("ALTER TABLE survey_response RENAME TO survey_response_x");
    expect(() => flushResponses()).toThrow();
    expect(pendingResponses()).toBe(1);
    getStore("survey").exec("ALTER TABLE survey_response_x RENAME TO survey_response");
    expect(flushResponses()).toBe(1);
  });
});

describe("answer validation", () => {
  it("@E2E-39 accepts a prefer-not option on a scale question and normalises multi-select order", () => {
    const s = mkSurvey({ questions: [{ id: "q", kind: "scale5", max_select: null, options: ["pn"] }, { id: "m", kind: "multi", max_select: null, options: ["a", "b", "c"] }] });
    expect(validateAnswers(s, { q: "pn", m: ["c", "a"] })).toEqual({ q: "pn", m: ["a", "c"] });
    expect(() => validateAnswers(s, { q: "nope", m: ["a"] })).toThrow(ResponseInvalid);
    expect(() => validateAnswers(s, { q: 3, m: ["zz"] })).toThrow(ResponseInvalid);
  });
});
