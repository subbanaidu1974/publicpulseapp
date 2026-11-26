import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, getStore, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { videocastRouter, checkMediaUrl, MIN_VIEWS_SHOWN } from "../../server/civic/videocast";
import { mkPerson } from "./notify/helpers";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/v", videocastRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); });

async function call(method: string, p: string, token?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : {} };
}
const admin = () => { const p = mkPerson(); grantRole("system", p.id, "admin"); return p; };
process.env.MEDIA_VIDEO_HOSTS = "media.example.org";
const VIDEO = { title_en: "How to read your result", note_en: "A two minute explainer.", media_url: "https://media.example.org/explainer.mp4", credit: "People Pulse, 2026", confirm_neutral: true, confirm_rights: true };
const propose = (a: { token: string }, extra: Record<string, unknown> = {}) => call("POST", "/admin", a.token, { ...VIDEO, ...extra });

describe("video broadcasts (S-230, S-231) @E2E-221", () => {
  it("only an admin can propose, list, approve, reject or recall; anonymous gets 401", async () => {
    const a = admin(), u = mkPerson();
    expect((await call("POST", "/admin", u.token, VIDEO)).status).toBe(403);
    expect((await call("GET", "/admin", u.token)).status).toBe(403);
    expect((await call("POST", "/admin", undefined, VIDEO)).status).toBe(401);
    expect((await call("GET", "/")).status).toBe(401);
    const c = await propose(a);
    expect(c.status).toBe(201);
    for (const act of ["approve", "reject", "recall"]) expect((await call("POST", `/admin/${c.json.id}/${act}`, u.token)).status).toBe(403);
  });

  it("a proposed item is invisible to members until a DIFFERENT admin approves it", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    const id = (await propose(a)).json.id;
    expect((await call("GET", "/", u.token)).json.items).toEqual([]);
    const own = await call("POST", `/admin/${id}/approve`, a.token);
    expect(own.status).toBe(409); expect(own.json.code).toBe("same_person");
    expect((await call("GET", "/", u.token)).json.items).toEqual([]);
    expect((await call("POST", `/admin/${id}/approve`, b.token)).status).toBe(200);
    const live = (await call("GET", "/", u.token)).json.items;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id, title_en: VIDEO.title_en, media_url: VIDEO.media_url, kind: "video", credit: VIDEO.credit });
    expect(Object.keys(live[0]).sort()).toEqual(["credit", "id", "kind", "live_at", "media_url", "note_en", "note_te", "title_en", "title_te"]); // no creator, no counts
    expect((await call("POST", `/admin/${id}/approve`, b.token)).json.code).toBe("not_pending"); // cannot approve twice
  });

  it("every signed-in member sees it, however they registered, and nobody is targeted", async () => {
    const a = admin(), b = admin();
    const id = (await propose(a)).json.id; await call("POST", `/admin/${id}/approve`, b.token);
    for (const p of [mkPerson(), mkPerson(), a, b]) expect((await call("GET", "/", p.token)).json.items.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  it("a start time in the future keeps it hidden until then; it is listed as scheduled to admins", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const id = (await propose(a, { publish_at: at })).json.id;
    await call("POST", `/admin/${id}/approve`, b.token);
    expect((await call("GET", "/", u.token)).json.items).toEqual([]);
    expect((await call("GET", "/admin", b.token)).json.items[0].status).toBe("scheduled");
    expect((await call("POST", `/${id}/view`, u.token)).status).toBe(404); // not live yet, so not countable
    expect((await propose(a, { publish_at: new Date(Date.now() + 90 * 86_400_000).toISOString() })).json.code).toBe("bad_publish_at");
  });

  it("recall takes it down at once, with an optional short note; reject refuses a pending item", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    const id = (await propose(a)).json.id; await call("POST", `/admin/${id}/approve`, b.token);
    expect((await call("POST", `/admin/${id}/recall`, a.token, { note: "Wrong video, a corrected one follows" })).status).toBe(200);
    expect((await call("GET", "/", u.token)).json.items).toEqual([]);
    expect((await call("GET", "/admin", a.token)).json.items[0]).toMatchObject({ status: "recalled", recall_note: "Wrong video, a corrected one follows" });
    expect((await call("POST", `/admin/${id}/recall`, a.token)).json.code).toBe("not_live");
    const id2 = (await propose(a)).json.id;
    expect((await call("POST", `/admin/${id2}/reject`, b.token)).status).toBe(200);
    expect((await call("POST", `/admin/${id2}/approve`, b.token)).json.code).toBe("not_pending");
    expect((await call("POST", `/admin/${id}/recall`, a.token, { note: "see https://x.example" })).status).toBe(409); // already recalled wins over the note check
  });

  it("both safety ticks are required, and party, link or secret wording is refused", async () => {
    const a = admin();
    expect((await propose(a, { confirm_neutral: false })).json.code).toBe("confirm_required");
    expect((await propose(a, { confirm_rights: undefined })).json.code).toBe("confirm_required");
    expect((await propose(a, { title_en: "Vote for the Green party this Sunday" })).json.code).toBe("party_preference_refused");
    expect((await propose(a, { note_en: "Watch more at https://example.org/x" })).json.code).toBe("text_refused");
    expect((await propose(a, { note_en: "Send us your OTP to confirm" })).json.code).toBe("text_refused");
    expect((await propose(a, { credit: "" })).json.code).toBe("bad_credit");
    expect((await propose(a, { title_en: "Hi" })).status).toBe(400);
  });

  it("the media address must be a direct https audio or video file with no login in it", () => {
    expect(checkMediaUrl("https://media.example.org/a/b.MP4")).toMatchObject({ kind: "video" });
    expect(checkMediaUrl("https://media.example.org/a.mp3?x=1")).toMatchObject({ kind: "audio" });
    for (const bad of ["http://media.example.org/a.mp4", "https://user:pw@media.example.org/a.mp4", "https://media.example.org/page.html", "https://www.youtube.com/watch?v=abc", "javascript:alert(1)", "ftp://x.org/a.mp4", "not a url", "https://x.org/" + "a".repeat(600) + ".mp4"])
      expect(() => checkMediaUrl(bad), bad).toThrow();
    expect(checkMediaUrl("http://localhost:3000/a.wav").kind).toBe("audio"); // development only
    expect(() => checkMediaUrl("https://other.example.net/a.mp4")).toThrow(/approved list/); // a host that is not on MEDIA_VIDEO_HOSTS
  });

  it("plays are counted without a person, and the count stays hidden under the minimum", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    const id = (await propose(a)).json.id; await call("POST", `/admin/${id}/approve`, b.token);
    for (let i = 0; i < MIN_VIEWS_SHOWN - 1; i++) expect((await call("POST", `/${id}/view`, u.token)).status).toBe(200);
    expect((await call("GET", "/admin", a.token)).json.items[0].views).toBeNull();
    await call("POST", `/${id}/view`, u.token);
    expect((await call("GET", "/admin", a.token)).json.items[0].views).toBe(MIN_VIEWS_SHOWN);
    // the store has no column that could say who watched
    const cols = (getDb().prepare("PRAGMA table_info(vcast_videos)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => /viewer|person|watch|member/i.test(c))).toEqual([]);
  });

  it("every step is audited and at most 20 items can wait", async () => {
    const a = admin(), b = admin();
    const id = (await propose(a)).json.id; await call("POST", `/admin/${id}/approve`, b.token); await call("POST", `/admin/${id}/recall`, b.token);
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'videocast.%'").all() as { action: string }[]).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["videocast.propose", "videocast.approve", "videocast.recall"]));
    for (let i = 0; i < 20; i++) expect((await propose(a)).status).toBe(201); // the first item is already live, so 20 can wait
    const over = await propose(a); expect(over.status).toBe(409); expect(over.json.code).toBe("too_many_pending");
  });
});
