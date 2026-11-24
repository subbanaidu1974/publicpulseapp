/** S-157 (@E2E-181): owner view of own reports (including held and taken-down ones) and the appeal path. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { migrate, resetDbForTests } from "../../../server/civic/core";
import { loadDemoGeo } from "../../../server/civic/geo/service";
import { createIssuesRouter } from "../../../server/civic/issues/routes";
import { clock, grantRole } from "../../../server/civic/issues/service";
import { moderationClasses } from "../../../server/civic/issues/public";

let server: Server, base: string;
async function call(method: string, p: string, who?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(who ? { "x-person": who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const report = (who: string, b: object) => call("POST", "/", who, { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply", ...b });
/** Text the lexicon holds for review: an honorific followed by a name, plus an accusation. */
const HELD_TEXT = "Mr Ramesh the MRO took a bribe for my pension";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/issues", createIssuesRouter((req, res, next) => {
    const p = req.header("x-person");
    if (!p) return void res.status(401).json({ error: "auth" });
    req.person = { id: p, tier: "T1" }; next();
  }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/issues`;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = () => new Date("2026-03-01T10:00:00Z");
  grantRole("mod-1", "moderator", null, null, "Moderator");
});

describe("owner view and appeal (S-157)", () => {
  it("@E2E-181 GET /issues/mine needs a session and lists only the caller's own reports, held ones included, never another person's", async () => {
    expect((await call("GET", "/mine")).status).toBe(401);
    const ok = await report("alice", { description_en: "Pump broken near the temple" });
    const held = await report("alice", { description_en: HELD_TEXT, category: "roads" });
    const other = await report("bob", { description_en: "Streetlight out on the main road", category: "electricity" });
    await call("POST", `/${other.body.id}/me-too`, "alice"); // supporting someone else's report does not make it hers
    const mine = await call("GET", "/mine", "alice");
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i: any) => i.id).sort()).toEqual([ok.body.id, held.body.id].sort());
    const h = mine.body.items.find((i: any) => i.id === held.body.id);
    expect(h).toMatchObject({ moderation: "held", can_appeal: true, appeal: null, status: "Reported" });
    expect(h.moderation_classes).toEqual(expect.arrayContaining(["names_a_person"]));
    expect(mine.body.items.find((i: any) => i.id === ok.body.id)).toMatchObject({ moderation: "ok", can_appeal: false, moderation_classes: [] });
    // coarse classes only: never rule ids, never anybody else's data
    expect(mine.text).not.toMatch(/honorific_name|accusation_with_person|reporter_id|bob|mod-1/);
    expect(mine.text).not.toContain(other.body.id);
    const bobs = await call("GET", "/mine", "bob");
    expect(bobs.body.items.map((i: any) => i.id)).toEqual([other.body.id]);
    expect((await call("GET", "/mine", "carol")).body.items).toEqual([]);
  });

  it("@E2E-181 GET /issues/mine/:id is the owner detail: own text, moderation state, can_appeal; 404 for other people's reports and for unknown ids", async () => {
    const held = await report("alice", { description_en: HELD_TEXT });
    const d = await call("GET", `/mine/${held.body.id}`, "alice");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id: held.body.id, moderation: "held", can_appeal: true, escalated: false, description_en: HELD_TEXT, village: { lgd: "DEMO-V-KLR" } });
    expect(d.text).not.toMatch(/reporter_id|honorific_name|gps_enc/);
    // the public route does not show it, the owner route does
    expect((await call("GET", `/${held.body.id}`)).status).toBe(404);
    expect((await call("GET", `/mine/${held.body.id}`, "bob")).status).toBe(404);
    expect((await call("GET", `/mine/${held.body.id}`)).status).toBe(401);
    expect((await call("GET", "/mine/not-an-issue", "alice")).status).toBe(404);
    // a supporter ("me too") of a visible report is not its owner
    const vis = await report("alice", { description_en: "Pump broken near the temple" });
    await call("POST", `/${vis.body.id}/me-too`, "bob");
    expect((await call("GET", `/mine/${vis.body.id}`, "bob")).status).toBe(404);
    expect((await call("GET", `/mine/${vis.body.id}`, "alice")).body).toMatchObject({ moderation: "ok", can_appeal: false });
  });

  it("@E2E-181 appeal: can_appeal turns false while pending, a moderator decides, an upheld hold can be appealed again, a release makes the report public", async () => {
    const held = await report("alice", { description_en: HELD_TEXT });
    const id = held.body.id as string;
    expect((await call("POST", `/${id}/appeal`, "bob", { reason: "not mine" })).status).toBe(404); // only the owner
    const ap = await call("POST", `/${id}/appeal`, "alice", { reason: "The name is a place, not a person" });
    expect(ap.status).toBe(201);
    expect((await call("POST", `/${id}/appeal`, "alice", { reason: "again" })).status).toBe(409);
    let d = (await call("GET", `/mine/${id}`, "alice")).body;
    expect(d).toMatchObject({ can_appeal: false, appeal: { status: "pending", count: 1 } });
    expect((await call("GET", "/mine", "alice")).body.items[0]).toMatchObject({ can_appeal: false, appeal: { status: "pending" } });

    expect((await call("POST", `/${id}/moderate`, "alice", { decision: "approve" })).status).toBe(403);
    expect((await call("POST", `/${id}/moderate`, "mod-1", { decision: "uphold" })).status).toBe(200);
    d = (await call("GET", `/mine/${id}`, "alice")).body;
    expect(d).toMatchObject({ moderation: "held", can_appeal: true });
    const second = await call("POST", `/${id}/appeal`, "alice", { reason: "Please look again" });
    expect(second.status).toBe(201);
    expect((await call("POST", `/${id}/moderate`, "mod-1", { decision: "approve" })).status).toBe(200);
    d = (await call("GET", `/mine/${id}`, "alice")).body;
    expect(d).toMatchObject({ moderation: "ok", can_appeal: false, appeal: { status: "approved", count: 2 } });
    expect((await call("GET", `/${id}`)).status).toBe(200); // public now
  });

  it("@E2E-181 a taken-down report stays in the owner's list with can_appeal true; the appeal rejected by takedown shows as rejected", async () => {
    const r = await report("alice", { description_en: "Pump broken near the temple" });
    const id = r.body.id as string;
    expect((await call("POST", `/${id}/appeal`, "alice", { reason: "x" })).status).toBe(404); // a visible report has nothing to appeal
    expect((await call("POST", `/${id}/moderate`, "mod-1", { decision: "reject" })).status).toBe(200);
    const mine = (await call("GET", `/mine/${id}`, "alice")).body;
    expect(mine).toMatchObject({ moderation: "taken_down", can_appeal: true });
    await call("POST", `/${id}/appeal`, "alice", { reason: "It was a real problem" });
    await call("POST", `/${id}/moderate`, "mod-1", { decision: "reject" });
    expect((await call("GET", `/mine/${id}`, "alice")).body).toMatchObject({ moderation: "taken_down", can_appeal: true, appeal: { status: "rejected" } });
  });

  it("@E2E-181 reason rule ids collapse into coarse classes", () => {
    expect(moderationClasses("honorific_name,accusation_with_person")).toEqual(["names_a_person"]);
    expect(moderationClasses("personal_identifier,abusive_language")).toEqual(["personal_information", "abusive_or_targeting"]);
    expect(moderationClasses("lexicon_unavailable")).toEqual(["needs_manual_check"]);
    expect(moderationClasses("something_new")).toEqual(["other"]);
    expect(moderationClasses(null)).toEqual([]);
  });
});
