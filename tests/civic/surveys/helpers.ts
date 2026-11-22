import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession, getDb, migrate, resetDbForTests } from "../../../server/civic/core";
import { loadDemoGeo } from "../../../server/civic/geo/service";
import { createPerson } from "../../../server/civic/identity/service";
import { credentialClock, credentialRouter, resetRespondLimiter } from "../../../server/civic/surveys/credential";
import { setBatching, stopResponseTimer } from "../../../server/civic/surveys/responses";
import { setOpenSurveyList, setSurveySource, type SurveyForResponse } from "../../../server/civic/surveys/source";
import * as client from "../../../src/lib/blind";

export const T0 = new Date("2026-06-01T10:00:00Z");
let phoneSeq = 0;

export function freshWorld(): void {
  resetDbForTests(); migrate(); loadDemoGeo();
  credentialClock.now = () => T0;
  setBatching({ flushMs: 3_600_000, flushItems: 1000 }); stopResponseTimer(); resetRespondLimiter();
  setSurveySource(null); setOpenSurveyList(null);
}

export function mkSurvey(over: Partial<SurveyForResponse> = {}): SurveyForResponse {
  return {
    id: crypto.randomUUID(), status: "open", topic_class: "issue_service", scope: { state: "AP", units: {} },
    opens_at: "2026-05-01T00:00:00.000Z", closes_at: "2026-07-01T00:00:00.000Z", wording_hash: "h".repeat(64),
    questions: [
      { id: "q1", kind: "single", max_select: null, options: ["a", "b", "c"], text: { text_en: "Is water supply reliable?", text_te: null, option_labels: [{ id: "a", label_en: "Yes", label_te: null }, { id: "b", label_en: "Sometimes", label_te: null }, { id: "c", label_en: "No", label_te: null }] } },
      { id: "q2", kind: "scale5", max_select: null, options: [] },
      { id: "q3", kind: "multi", max_select: 2, options: ["x", "y", "z"] },
    ],
    ...over,
  };
}
export const useSurveys = (...list: SurveyForResponse[]) => {
  setSurveySource((id) => list.find((s) => s.id === id) ?? null);
  setOpenSurveyList(() => list.filter((s) => s.status === "open"));
};

export interface Who { id: string; token: string }
export function mkPerson(o: { tier?: "T0" | "T1" | "T2"; village?: string | null; ageDays?: number; flags?: string[] } = {}): Who {
  const n = ++phoneSeq;
  const p = createPerson({ phone: `+9198${String(70000000 + n)}`, pin: "482915", consentVersion: "v1", now: new Date(T0.getTime() - (o.ageDays ?? 30) * 86_400_000) });
  getDb().prepare("UPDATE persons SET tier = ?, residence_unit = ?, flags = ? WHERE id = ?").run(o.tier ?? "T1", o.village === undefined ? "DEMO-V-KLR" : o.village, JSON.stringify(o.flags ?? []), p.id);
  return { id: p.id, token: createSession(p.id) };
}

export const GOOD_ANSWERS = { q1: "a", q2: 4, q3: ["y", "x"] };
export const GOOD_STRATA = { age_band: "25-34", gender: "F", mandal: "DEMO-M-KLP" };

export async function serve(): Promise<{ s: Server; base: string }> {
  const app = express();
  app.use("/surveys", credentialRouter);
  const s = app.listen(0);
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/surveys` };
}

export async function call(base: string, method: string, p: string, o: { token?: string; body?: unknown } = {}) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", ...(o.token ? { authorization: "Bearer " + o.token } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
}

/** The whole client flow: eligibility -> key -> blind -> request -> unblind. Returns the redeem payload. */
export async function getCredential(base: string, who: Who, surveyId: string, nonce = crypto.randomBytes(16).toString("base64url")) {
  const el = await call(base, "GET", `/${surveyId}/credential/eligibility`, { token: who.token });
  const keyRes = await call(base, "GET", `/${surveyId}/credential/key?class=${el.body.key_class ?? "T1"}`);
  const key = client.keyFromJwk(keyRes.body.key);
  const st = await client.blind(key);
  const req = await call(base, "POST", `/${surveyId}/credential/request`, { token: who.token, body: { blinded: st.blindedB64, nonce, key_class: el.body.key_class ?? "T1" } });
  if (req.status !== 200) return { req, el };
  const signature = await client.finalize(key, st, req.body.blind_signature);
  return { req, el, redeem: { token: st.tokenB64, prefix: st.prefixB64, signature }, st, key };
}
