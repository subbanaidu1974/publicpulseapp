/**
 * S-31 (@E2E-40) assisted channels (voice/IVR): server-side blinding is NOT possible, so these responses are labelled
 * channel=assisted, platform_linkable=1, kept in a separate table (stratum) and limited to issue/service and bill topics.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb, getStore, migrate, resetDbForTests } from "../../../server/civic/core";
import { loadDemoGeo } from "../../../server/civic/geo/service";
import { createPerson } from "../../../server/civic/identity/service";
import { createChannelsRouter, PROMPTS } from "../../../server/civic/channels/routes";
import { ASSISTED_TOPICS, AssistedRefused, ivrReadable, ivrSurveyStep, listAssistedSurveys, submitAssisted, topicAllowedAssisted } from "../../../server/civic/surveys/assisted";
import { flushResponses, responseCounts, setBatching, stopResponseTimer } from "../../../server/civic/surveys/responses";
import { setOpenSurveyList, setSurveySource } from "../../../server/civic/surveys/source";
import { call, freshWorld, getCredential, mkPerson, mkSurvey, serve, useSurveys } from "./helpers";

const PHONE = "+919876500777", LOCAL = "9876500777", PIN = "4821";
const OPEN = { opens_at: "2020-01-01T00:00:00.000Z", closes_at: "2099-01-01T00:00:00.000Z" };
const phoneSurvey = (over = {}) => mkSurvey({
  ...OPEN,
  questions: [
    { id: "q1", kind: "single", max_select: null, options: ["a", "b", "c"], text: { text_en: "Is water supply reliable?", text_te: "నీటి సరఫరా నమ్మదగినదా?", option_labels: [{ id: "a", label_en: "Yes", label_te: "అవును" }, { id: "b", label_en: "Sometimes", label_te: null }, { id: "c", label_en: "No", label_te: "కాదు" }] } },
    { id: "q2", kind: "scale5", max_select: null, options: [], text: { text_en: "How satisfied are you with the roads?", text_te: null, option_labels: [] } },
  ],
  ...over,
});

let chanServer: Server, chan = "", person: { id: string };
const post = async (p: string, body: unknown) => {
  const r = await fetch(chan + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function startCall(from = LOCAL) { const { body } = await post("/missed-call", { from }); await post("/ivr", { callId: body.callId }); return body.callId as string; }

beforeEach(async () => {
  freshWorld();
  const c = express(); c.use("/channels", createChannelsRouter());
  chanServer = c.listen(0, "127.0.0.1");
  await new Promise((r) => chanServer.once("listening", r));
  chan = `http://127.0.0.1:${(chanServer.address() as AddressInfo).port}/channels`;
  person = createPerson({ phone: PHONE, pin: PIN, label: "Amma", consentVersion: "v1" });
  getDb().prepare("UPDATE persons SET tier='T1', residence_unit='DEMO-V-KLR', created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(person.id);
});
afterEach(() => { chanServer.close(); stopResponseTimer(); setBatching(null); setSurveySource(null); setOpenSurveyList(null); });

describe("channel rule: issue/service and bill topics only", () => {
  it("@E2E-40 political and election_choice surveys are refused with 403 channel_not_allowed, before anything else is checked", () => {
    expect([...ASSISTED_TOPICS]).toEqual(["issue_service", "bill"]);
    for (const topic of ["political", "election_choice"] as const) {
      const s = phoneSurvey({ topic_class: topic }); useSurveys(s);
      expect(topicAllowedAssisted(s)).toBe(false);
      try { submitAssisted("nobody", s.id, { q1: "a", q2: 3 }); expect.unreachable(); }
      catch (e) { expect(e).toBeInstanceOf(AssistedRefused); expect(e).toMatchObject({ code: "channel_not_allowed", status: 403 }); }
      expect(responseCounts(s.id)).toEqual({ app: 0, assisted: 0 });
      expect(listAssistedSurveys(person.id)).toEqual([]);
    }
    for (const topic of ["issue_service", "bill"] as const) expect(topicAllowedAssisted(phoneSurvey({ topic_class: topic }))).toBe(true);
  });

  it("@E2E-40 a survey with multi-select or too many questions cannot be read over the phone", () => {
    expect(ivrReadable(mkSurvey())).toBe(false); // default has a multi question
    expect(ivrReadable(phoneSurvey())).toBe(true);
    expect(ivrReadable(phoneSurvey({ questions: [] }))).toBe(false);
  });
});

describe("assisted storage: labelled, linkable by design, a separate stratum (S-31)", () => {
  it("@E2E-40 an assisted response is stored in its own table with channel=assisted and platform_linkable=1, never in the anonymous table", () => {
    const s = phoneSurvey(); useSurveys(s);
    submitAssisted(person.id, s.id, { q1: "b", q2: 2 });
    flushResponses();
    expect(responseCounts(s.id)).toEqual({ app: 0, assisted: 1 });
    const row = getStore("survey").prepare("SELECT * FROM survey_response_assisted").get() as any;
    expect(row).toMatchObject({ survey_id: s.id, channel: "assisted", platform_linkable: 1, tier: "T1", quality: "normal", mandal: "DEMO-M-KLP", age_band: "NA", gender: "NS" });
    expect(JSON.parse(row.answers)).toEqual({ q1: "b", q2: 2 });
    expect(JSON.stringify(row)).not.toContain(person.id); // the row names no person (the platform-linkability is via the call and has_responded, which the notice states)
    expect((getStore("survey").prepare("SELECT COUNT(*) c FROM survey_response").get() as any).c).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) c FROM has_responded WHERE person_id=? AND survey_id=?").get(person.id, s.id)).toMatchObject({ c: 1 });
  });

  it("@E2E-40 final: a second assisted answer is 409 already_responded, and an app credential is not issued afterwards", async () => {
    const s = phoneSurvey(); useSurveys(s);
    submitAssisted(person.id, s.id, { q1: "a", q2: 5 });
    expect(() => submitAssisted(person.id, s.id, { q1: "c", q2: 1 })).toThrow(expect.objectContaining({ code: "already_responded", status: 409 }));
    flushResponses();
    expect(responseCounts(s.id).assisted).toBe(1);
    const { s: srv, base } = await serve();
    try {
      const login = await getCredential(base, { id: person.id, token: (await import("../../../server/civic/core")).createSession(person.id) }, s.id);
      expect(login.req.status).toBe(409);
    } finally { srv.close(); }
  }, 60_000);

  it("@E2E-40 ineligible callers are refused with the same rules as the app (new account, outside scope, recycled number)", () => {
    const s = phoneSurvey(); useSurveys(s);
    getDb().prepare("UPDATE persons SET created_at=? WHERE id=?").run(new Date().toISOString(), person.id);
    expect(() => submitAssisted(person.id, s.id, { q1: "a", q2: 5 })).toThrow(expect.objectContaining({ code: "account_too_new" }));
    getDb().prepare("UPDATE persons SET created_at='2026-01-01T00:00:00.000Z', residence_unit='DEMO-V-HNK' WHERE id=?").run(person.id);
    expect(() => submitAssisted(person.id, s.id, { q1: "a", q2: 5 })).toThrow(expect.objectContaining({ code: "outside_scope" }));
    getDb().prepare("UPDATE persons SET residence_unit='DEMO-V-KLR', flags='[\"recently_reissued\"]' WHERE id=?").run(person.id);
    expect(() => submitAssisted(person.id, s.id, { q1: "a", q2: 5 })).toThrow(expect.objectContaining({ code: "number_recycled" }));
    expect(() => submitAssisted(person.id, "00000000-0000-4000-8000-000000000000", {})).toThrow(expect.objectContaining({ code: "survey_not_found" }));
  });

  it("@E2E-40 anonymous and assisted stay separate strata when both channels answer the same survey", async () => {
    const s = phoneSurvey(); useSurveys(s);
    const { s: srv, base } = await serve();
    try {
      const other = mkPerson();
      const c = await getCredential(base, other, s.id);
      const r = await call(base, "POST", `/${s.id}/respond`, { body: { ...c.redeem, answers: { q1: "a", q2: 3 }, strata: { age_band: "35-44", gender: "M", mandal: "DEMO-M-KLP" } } });
      expect(r.status).toBe(201);
      submitAssisted(person.id, s.id, { q1: "c", q2: 2 });
      flushResponses();
      expect(responseCounts(s.id)).toEqual({ app: 1, assisted: 1 });
    } finally { srv.close(); }
  }, 60_000);
});

describe("IVR: the survey branch of the voice menu (S-31)", () => {
  it("@E2E-40 option 3 asks for the personal PIN, states the platform-linkable guarantee, reads the questions and stores the answers as assisted", async () => {
    const s = phoneSurvey(); useSurveys(s);
    const callId = await startCall();
    const pin = await post("/ivr", { callId, digits: "3" });
    expect(pin.body).toMatchObject({ state: "pin", sensitive: true });
    const q1 = await post("/ivr", { callId, digits: PIN });
    expect(q1.body.state).toBe("survey");
    expect(q1.body.prompts.map((p: any) => p.id)).toEqual(["survey_notice", "survey_q"]);
    expect(q1.body.prompts[0].textEn).toMatch(/link your answer to your account/i);
    expect(q1.body.prompts[0].textEn).toMatch(/once.*final/i);
    expect(q1.body.prompts[1].textEn).toBe("Is water supply reliable? Yes 1, Sometimes 2, No 3.");
    expect(q1.body.prompts[1].textTe).toContain("అవును 1");
    expect(q1.body.expect).toBe("digit");
    const bad = await post("/ivr", { callId, digits: "9" });
    expect(bad.body.prompts.map((p: any) => p.id)).toEqual(["survey_q"]); // re-asks, no notice again
    expect(bad.body.prompts[0].textEn).toMatch(/^Is water supply/);
    const q2 = await post("/ivr", { callId, digits: "3" });
    expect(q2.body.prompts[0].textEn).toBe("How satisfied are you with the roads? Press 1 to 5, where 1 is lowest and 5 is highest.");
    const done = await post("/ivr", { callId, digits: "4" });
    expect(done.body).toMatchObject({ state: "done" });
    expect(done.body.prompts.map((p: any) => p.id)).toEqual(["thanks", "goodbye"]);
    flushResponses();
    const row = getStore("survey").prepare("SELECT answers, channel, platform_linkable FROM survey_response_assisted").get() as any;
    expect(row).toMatchObject({ channel: "assisted", platform_linkable: 1 });
    expect(JSON.parse(row.answers)).toEqual({ q1: "c", q2: 4 });
    // the PIN and the keys never appear in the persisted call row once the call is over
    const rows = getStore("issues").prepare("SELECT * FROM ivr_call").all();
    expect(JSON.stringify(rows)).not.toContain(PIN);
  }, 60_000);

  it("@E2E-40 a wrong PIN never reaches a survey question", async () => {
    useSurveys(phoneSurvey());
    const callId = await startCall();
    await post("/ivr", { callId, digits: "3" });
    const r = await post("/ivr", { callId, digits: "9999" });
    expect(r.body.state).toBe("pin");
    expect(responseCounts("x")).toEqual({ app: 0, assisted: 0 });
  });

  it("@E2E-40 with no phone-answerable survey (political only) the caller is told so; nothing is asked or stored", async () => {
    useSurveys(phoneSurvey({ topic_class: "political" }), phoneSurvey({ topic_class: "election_choice" }));
    const callId = await startCall();
    await post("/ivr", { callId, digits: "3" });
    const r = await post("/ivr", { callId, digits: PIN });
    expect(r.body.state).toBe("done");
    expect(r.body.prompts.map((p: any) => p.id)).toEqual(["survey_none", "goodbye"]);
    flushResponses();
    expect((getStore("survey").prepare("SELECT COUNT(*) c FROM survey_response_assisted").get() as any).c).toBe(0);
  });

  it("@E2E-40 a caller who already answered hears that, and is not asked again; PIN is required even when CIVIC_IVR_PIN_ALWAYS=0", async () => {
    const s = phoneSurvey(); useSurveys(s);
    submitAssisted(person.id, s.id, { q1: "a", q2: 1 });
    process.env.CIVIC_IVR_PIN_ALWAYS = "0";
    try {
      const callId = await startCall();
      const r = await post("/ivr", { callId, digits: "3" });
      expect(r.body.state).toBe("pin");
      const none = await post("/ivr", { callId, digits: PIN });
      expect(none.body.prompts.map((p: any) => p.id)).toEqual(["survey_none", "goodbye"]);
    } finally { delete process.env.CIVIC_IVR_PIN_ALWAYS; }
  });

  it("@E2E-40 an unregistered number keeps the legacy stub and stores nothing", async () => {
    useSurveys(phoneSurvey());
    const callId = await startCall("9123400099");
    const r = await post("/ivr", { callId, digits: "3" });
    expect(r.body.state).toBe("survey");
    expect(r.body.prompts[0].id).toBe("survey");
    expect((await post("/ivr", { callId, digits: "1" })).body.state).toBe("done");
    flushResponses();
    expect((getStore("survey").prepare("SELECT COUNT(*) c FROM survey_response_assisted").get() as any).c).toBe(0);
  });

  it("@E2E-40 ivrSurveyStep is safe on a malformed or foreign state and refuses a topic switched to political mid-call", () => {
    const s = phoneSurvey(); useSurveys(s);
    expect(ivrSurveyStep(person.id, "garbage", undefined).kind).toBe("ask"); // restarts at the first survey
    setSurveySource(() => ({ ...s, topic_class: "political" }));
    expect(ivrSurveyStep(person.id, `svy:${s.id}:`, "1")).toEqual({ kind: "refused", code: "channel_not_allowed" });
    setSurveySource(() => null);
    expect(ivrSurveyStep(person.id, `svy:${s.id}:`, "1")).toEqual({ kind: "none" });
  });

  it("@E2E-40 every new IVR prompt is in the audio manifest and scripts as a placeholder, and no prompt uses election words", () => {
    const manifest = JSON.parse(fs.readFileSync("data/civic/audio-manifest.json", "utf8"));
    const scripts = JSON.parse(fs.readFileSync("data/civic/audio-scripts/prompts.json", "utf8"));
    for (const id of ["survey_notice", "survey_q", "survey_none", "survey_already"]) {
      expect(PROMPTS[id], id).toBeTruthy();
      expect(manifest.prompts.find((p: any) => p.id === id)?.status, id).toBe("placeholder");
      expect(scripts.prompts.some((p: any) => p.id === id), id).toBe(true);
      expect(PROMPTS[id].textEn).not.toMatch(/vote|party|election|candidate/i);
    }
  });
});
