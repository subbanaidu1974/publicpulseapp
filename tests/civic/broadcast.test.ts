import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getStore, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { broadcastRouter, MIN_RESULTS } from "../../server/civic/broadcast";
import { mkPerson } from "./notify/helpers";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/b", broadcastRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); });

async function call(method: string, p: string, token?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : {} };
}
const admin = () => { const p = mkPerson(); grantRole("system", p.id, "admin"); return p; };
const POLL = {
  title_en: "Water supply in your village",
  intro_en: "Two quick questions.",
  questions: [
    { kind: "single", text_en: "How reliable is your drinking water?", text_te: "మీ తాగునీరు ఎంత నమ్మదగినది?", options: [{ label_en: "Reliable", label_te: "నమ్మదగినది" }, { label_en: "Not reliable" }] },
    { kind: "scale5", text_en: "The village needs a new borewell." },
  ],
};
const open = async (a: { token: string }, extra: Record<string, unknown> = {}) => (await call("POST", "/admin", a.token, { ...POLL, ...extra }));

describe("broadcast polls (S-185) @E2E-198", () => {
  it("only an admin can create, list, read results and close; everyone else gets 403 and nobody anonymous gets in", async () => {
    const a = admin(), u = mkPerson();
    expect((await call("POST", "/admin", u.token, POLL)).status).toBe(403);
    expect((await call("GET", "/admin", u.token)).status).toBe(403);
    expect((await call("POST", "/admin", undefined, POLL)).status).toBe(401);
    expect((await call("GET", "/pending")).status).toBe(401);
    const c = await open(a);
    expect(c.status).toBe(201);
    expect((await call("GET", `/admin/${c.json.id}/results`, u.token)).status).toBe(403);
    expect((await call("POST", `/admin/${c.json.id}/close`, u.token)).status).toBe(403);
    expect((await call("GET", "/admin", a.token)).json.polls).toHaveLength(1);
  });

  it("every registered user, however they registered, gets the poll as pending; admins are never blocked", async () => {
    const a = admin(), u1 = mkPerson(), u2 = mkPerson({ phone: false });
    expect((await call("GET", "/pending", u1.token)).json.poll).toBeNull();
    const c = await open(a);
    for (const u of [u1, u2]) {
      const p = (await call("GET", "/pending", u.token)).json.poll;
      expect(p.id).toBe(c.json.id);
      expect(p.questions[0].options.at(-1)).toMatchObject({ prefer_not: true });
      expect(p.note_en).toMatch(/not a representative/);
    }
    expect((await call("GET", "/pending", a.token)).json.poll).toBeNull();
  });

  it("a person is blocked until every question is answered, then the poll is gone for them only", async () => {
    const a = admin(), u = mkPerson(), v = mkPerson();
    const id = (await open(a)).json.id;
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0]] })).json.code).toBe("incomplete");
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0], []] })).json.code).toBe("incomplete");
    expect((await call("GET", "/pending", u.token)).json.poll.id).toBe(id);
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0], [3]] })).status).toBe(200);
    expect((await call("GET", "/pending", u.token)).json.poll).toBeNull();
    expect((await call("GET", "/pending", v.token)).json.poll.id).toBe(id);
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[1], [1]] })).status).toBe(409); // once per person
  });

  it("answers are validated: unknown options, too many choices, 'prefer not to say' mixed with a choice", async () => {
    const a = admin(), u = mkPerson();
    const id = (await open(a)).json.id;
    const bad = async (answers: unknown) => (await call("POST", `/${id}/answer`, u.token, { answers })).json.code;
    expect(await bad([[9], [0]])).toBe("bad_option");
    expect(await bad([[0, 1], [0]])).toBe("bad_option"); // single choice
    expect(await bad([[0, 2], [0]])).toBe("bad_option"); // option 2 is "prefer not to say"
    expect(await bad("x")).toBe("incomplete");
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[2], [5]] })).status).toBe(200); // prefer-not on both
  });

  it("results are hidden until enough people answered, then show counts; stored data has no link to the account", async () => {
    const a = admin(); const id = (await open(a)).json.id;
    const people = Array.from({ length: MIN_RESULTS }, () => mkPerson());
    for (const [i, p] of people.entries()) {
      await call("POST", `/${id}/answer`, p.token, { answers: [[i % 2], [4]] });
      if (i === MIN_RESULTS - 2) { const r = (await call("GET", `/admin/${id}/results`, a.token)).json; expect(r).toMatchObject({ responses: MIN_RESULTS - 1, suppressed: true }); expect(r.results[0].options.every((o: { n: number | null }) => o.n === null)).toBe(true); }
    }
    const r = (await call("GET", `/admin/${id}/results`, a.token)).json;
    expect(r).toMatchObject({ responses: MIN_RESULTS, suppressed: false });
    expect(r.results[0].options.map((o: { n: number }) => o.n)).toEqual([5, 5, 0]);
    expect(r.results[1].options[4].n).toBe(MIN_RESULTS);
    const s = getStore("survey");
    const dump = JSON.stringify([s.prepare("SELECT * FROM bpoll_done").all(), s.prepare("SELECT * FROM bpoll_counts").all(), s.prepare("SELECT * FROM bpoll_polls").all()]);
    for (const p of people) expect(dump).not.toContain(p.id);
    expect(s.prepare("SELECT COUNT(*) AS c FROM bpoll_counts").get()).toMatchObject({ c: 3 + 6 });
  });

  it("closing releases everybody; a closed poll refuses answers; polls with an end time close by themselves", async () => {
    const a = admin(), u = mkPerson();
    const id = (await open(a)).json.id;
    expect((await call("POST", `/admin/${id}/close`, a.token)).status).toBe(200);
    expect((await call("GET", "/pending", u.token)).json.poll).toBeNull();
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0], [0]] })).status).toBe(409);
    expect((await call("POST", `/admin/${id}/close`, a.token)).status).toBe(404);
    expect((await open(a, { closes_at: "2020-01-01T00:00:00Z" })).json.code).toBe("bad_closes_at");
    const soon = new Date(Date.now() + 2000).toISOString();
    const id2 = (await open(a, { closes_at: soon })).json.id;
    expect((await call("GET", "/pending", u.token)).json.poll.id).toBe(id2);
    await new Promise((r) => setTimeout(r, 2300));
    expect((await call("GET", "/pending", u.token)).json.poll).toBeNull();
  });

  it("the oldest unanswered poll comes first and at most three can be open", async () => {
    const a = admin(), u = mkPerson();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { ids.push((await open(a, { title_en: `Poll number ${i + 1}` })).json.id); await new Promise((r) => setTimeout(r, 5)); }
    expect((await open(a)).json.code).toBe("too_many_open");
    expect((await call("GET", "/pending", u.token)).json.poll.id).toBe(ids[0]);
    await call("POST", `/${ids[0]}/answer`, u.token, { answers: [[0], [0]] });
    expect((await call("GET", "/pending", u.token)).json.poll.id).toBe(ids[1]);
  });

  it("refuses wording that asks for a party choice, a secret or carries a link, and bad shapes", async () => {
    const a = admin();
    const q = (text_en: string) => ({ questions: [{ kind: "single", text_en, options: [{ label_en: "Yes" }, { label_en: "No" }] }] });
    expect((await open(a, q("Which party will you vote for in the next election?"))).json.code).toBe("party_preference_refused");
    expect((await open(a, q("Please share your OTP to continue"))).json.code).toBe("question_refused");
    expect((await open(a, q("Read more at https://evil.example/x today"))).json.code).toBe("question_refused");
    expect((await open(a, { title_en: "Vote for the best party today" })).json.code).toBe("question_refused");
    expect((await open(a, { questions: [] })).json.code).toBe("bad_questions");
    expect((await open(a, { questions: Array.from({ length: 6 }, () => POLL.questions[1]) })).json.code).toBe("bad_questions");
    expect((await open(a, q("Is the road safe at night?")).then(() => open(a, { questions: [{ kind: "single", text_en: "Is the road safe?", options: [{ label_en: "Yes" }] }] }))).json.code).toBe("bad_options");
    expect((await open(a, { title_en: "ab" })).json.code).toBe("bad_title");
  });

  it("multi-choice respects max_select and counts every pick", async () => {
    const a = admin(), u = mkPerson();
    const id = (await open(a, { questions: [{ kind: "multi", max_select: 2, text_en: "Which services need work?", options: [{ label_en: "Roads" }, { label_en: "Water" }, { label_en: "Power" }] }] })).json.id;
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0, 1, 2]] })).json.code).toBe("bad_option");
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0, 2]] })).status).toBe(200);
  });

  it("a scheduled poll stays quiet until its start time, then blocks by itself; cancelling before then frees the slot (S-186)", async () => {
    const a = admin(), u = mkPerson();
    const start = new Date(Date.now() + 1500).toISOString();
    const c = await open(a, { opens_at: start });
    expect(c.status).toBe(201);
    const id = c.json.id as string;
    expect((await call("GET", `/admin/${id}/results`, a.token)).json.status).toBe("scheduled");
    expect((await call("GET", "/pending", u.token)).json.poll).toBeNull();
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0], [0]] })).json.code).toBe("not_started");
    await new Promise((r) => setTimeout(r, 1700));
    expect((await call("GET", "/pending", u.token)).json.poll.id).toBe(id);
    expect((await call("GET", `/admin/${id}/results`, a.token)).json.status).toBe("open");
    expect((await call("POST", `/${id}/answer`, u.token, { answers: [[0], [0]] })).status).toBe(200);
    // a later one can be cancelled before it starts and never blocks anyone
    const later = (await open(a, { opens_at: new Date(Date.now() + 3_600_000).toISOString() })).json.id as string;
    expect((await call("POST", `/admin/${later}/close`, a.token)).status).toBe(200);
    expect((await call("GET", "/pending", mkPerson().token)).json.poll.id).toBe(id);
  });

  it("start time rules: past or now means now, far future and nonsense are refused, the end must follow the start", async () => {
    const a = admin(), u = mkPerson();
    expect((await open(a, { opens_at: "2020-01-01T00:00:00Z" })).status).toBe(201); // already past: opens now
    expect((await call("GET", "/pending", u.token)).json.poll).not.toBeNull();
    const day = 86_400_000;
    expect((await open(a, { opens_at: new Date(Date.now() + 40 * day).toISOString() })).json.code).toBe("bad_opens_at");
    expect((await open(a, { opens_at: "soon" })).json.code).toBe("bad_opens_at");
    const s = new Date(Date.now() + 5 * day);
    expect((await open(a, { opens_at: s.toISOString(), closes_at: new Date(s.getTime() - 1000).toISOString() })).json.code).toBe("bad_closes_at");
    expect((await open(a, { opens_at: s.toISOString(), closes_at: new Date(s.getTime() + 40 * day).toISOString() })).json.code).toBe("bad_closes_at");
    expect((await open(a, { opens_at: s.toISOString(), closes_at: new Date(s.getTime() + 2 * day).toISOString() })).status).toBe(201);
  });

  it("max choices (S-188): a whole number from 1 to the option count is kept; anything else is refused; empty means no limit", async () => {
    const a = admin(), u = mkPerson();
    const multi = (max_select: unknown) => ({ questions: [{ kind: "multi", max_select, text_en: "Which services need work?", options: [{ label_en: "Roads" }, { label_en: "Water" }, { label_en: "Power" }] }] });
    for (const bad of [0, 4, 1.5, "two", -1]) expect((await open(a, multi(bad))).json.code).toBe("bad_max_select");
    const none = (await open(a, multi(""))).json; // empty: no limit
    expect(none.questions[0].max_select).toBe(3);
    await call("POST", `/admin/${none.id}/close`, a.token);
    const one = await open(a, multi(1));
    expect(one.json.questions[0].max_select).toBe(1);
    expect((await call("POST", `/${one.json.id}/answer`, u.token, { answers: [[0, 1]] })).json.code).toBe("bad_option");
    expect((await call("POST", `/${one.json.id}/answer`, u.token, { answers: [[1]] })).status).toBe(200);
  });

  it("min choices (S-189): validated against the maximum; enforced on answer; prefer-not always satisfies it; empty means 1", async () => {
    const a = admin(), u = mkPerson();
    const multi = (min_select: unknown, max_select: unknown = 3) => ({ questions: [{ kind: "multi", min_select, max_select, text_en: "Which services need work?", options: [{ label_en: "Roads" }, { label_en: "Water" }, { label_en: "Power" }, { label_en: "Health" }] }] });
    for (const bad of [0, 4, 1.5, "two", -1]) expect((await open(a, multi(bad))).json.code).toBe("bad_min_select");
    expect((await open(a, multi(3, 2))).json.code).toBe("bad_min_select"); // min above max
    const none = (await open(a, multi(""))).json;
    expect(none.questions[0].min_select).toBe(1);
    await call("POST", `/admin/${none.id}/close`, a.token);
    const p = (await open(a, multi(2, 3))).json;
    expect(p.questions[0]).toMatchObject({ min_select: 2, max_select: 3 });
    const ans = async (pick: number[]) => call("POST", `/${p.id}/answer`, u.token, { answers: [pick] });
    expect((await ans([1])).json.code).toBe("bad_option"); // too few
    expect((await ans([0, 1, 2, 3])).json.code).toBe("bad_option"); // too many
    expect((await call("GET", "/pending", u.token)).json.poll.questions[0].min_select).toBe(2);
    expect((await ans([4])).status).toBe(200); // prefer not to say counts as an answer
  });
});
