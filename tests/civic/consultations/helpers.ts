import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession, getDb, grantRole, migrate, resetDbForTests } from "../../../server/civic/core";
import type { RoleName } from "../../../server/civic/core";
import { loadDemoGeo } from "../../../server/civic/geo/service";
import { consultationsRouter } from "../../../server/civic/consultations";
import { setCommentReviewer } from "../../../server/civic/consultations/reviewer";
import { setRegistryClock } from "../../../server/civic/surveys/types";

export const DAY = 86_400_000;
export const T0 = new Date("2026-12-01T10:00:00Z");
export const clock = { now: T0 };
export const tick = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
export const ENVS = ["SURVEY_MIN_CELL", "SURVEY_ROUND_TO", "SURVEY_PUBLISH_DELAY_HOURS", "SURVEY_MIN_OPTION_COUNT", "SURVEY_MIN_OPTION_SHARE", "CONSULT_FEEDBACK_PER_MIN_PERSON",
  "CONSULT_FEEDBACK_PER_MIN_NET", "CONSULT_BURST_PER_MIN", "CONSULT_CLUSTER_FLAG_MIN", "CONSULT_REPORT_DUE_DAYS", "CIVIC_SURVEY_MIN_ACCOUNT_DAYS"] as const;

export function freshWorld(): void {
  resetDbForTests(); migrate(); loadDemoGeo();
  clock.now = T0;
  setRegistryClock(() => clock.now);
  setCommentReviewer(null);
  for (const k of ENVS) delete process.env[k];
}
export function endWorld(): void { setRegistryClock(null); setCommentReviewer(null); for (const k of ENVS) delete process.env[k]; }

export interface P { id: string; token: string }
export function person(o: { role?: RoleName; dept?: string; tier?: "T0" | "T1" | "T2"; village?: string | null } = {}): P {
  const id = randomUUID(), old = new Date(T0.getTime() - 60 * DAY).toISOString();
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from, tier, residence_unit, flags) VALUES (?,?,?,?,?,?)").run(id, old, old, o.tier ?? "T1", o.village === undefined ? "DEMO-V-KLR" : o.village, "[]");
  if (o.role) grantRole("system", id, o.role, null, o.dept ?? null);
  return { id, token: createSession(id) };
}
export const officer = (dept = "Agriculture") => person({ role: "officer", dept });
export const admin = () => person({ role: "admin" });
export const citizen = () => person();

let server: Server;
let base = "";
export async function startServer(): Promise<void> {
  const app = express();
  app.use("/api/v1/civic/consultations", consultationsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/civic/consultations`;
}
export const stopServer = () => { server.close(); };

export async function call(p: P | null, method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, {
    method, headers: { "content-type": "application/json", ...(p ? { authorization: "Bearer " + p.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> };
}

/** A raw (non-JSON) request, for audio upload and streaming; returns status, headers and the body bytes. */
export async function callRaw(p: P | null, method: string, url: string, body?: Buffer | Uint8Array, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, { method, headers: { ...(p ? { authorization: "Bearer " + p.token } : {}), ...headers }, body: body as BodyInit | undefined });
  const bytes = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, bytes, json: () => (bytes.length ? JSON.parse(bytes.toString("utf8")) : {}) as Record<string, any> };
}

export function draft(over: Record<string, unknown> = {}) {
  return {
    title_en: "Draft Agricultural Marketing Amendment Bill", title_te: "వ్యవసాయ మార్కెటింగ్ సవరణ బిల్లు ముసాయిదా",
    bill_ref: "Draft Bill 2026/14", source_url: "https://www.ap.gov.in/bills/agri-marketing-2026.pdf",
    scope: { state: "AP", units: {} }, opens_at: new Date(T0.getTime() - 3_600_000).toISOString(), closes_at: new Date(T0.getTime() + 20 * DAY).toISOString(),
    affected_groups: ["farmers", "women", "students"],
    clauses: [
      { original_text: "Section 4: Every sale of notified produce shall be recorded at the market yard.", summary_en: "Sales of notified produce must be recorded at the market yard.", summary_te: "నోటిఫై చేసిన ఉత్పత్తుల అమ్మకాలను మార్కెట్ యార్డులో నమోదు చేయాలి.",
        audio: [{ group: "farmers", file_id: null, duration_s: 40, status: "placeholder" }] },
      { original_ref: "Section 9(2)", summary_en: "Traders must pay farmers within seven days of a sale.", summary_te: "అమ్మకం జరిగిన ఏడు రోజుల్లోగా వ్యాపారులు రైతులకు చెల్లించాలి." },
    ],
    ...over,
  };
}

/** create -> submit -> two approvals -> publish. Returns the open consultation's id and its creator. */
export async function openConsultation(over: Record<string, unknown> = {}, dept = "Agriculture") {
  const creator = officer(dept);
  const c = await call(creator, "POST", "", draft(over));
  if (c.status !== 201) throw new Error("create failed " + JSON.stringify(c.body));
  const id = c.body.id as string;
  const s = await call(creator, "POST", `/${id}/submit`);
  if (s.status !== 200) throw new Error("submit failed " + JSON.stringify(s.body));
  for (let i = 0; i < 2; i++) { const r = await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", notes: "plain language ok" }); if (r.status !== 200) throw new Error("review failed " + JSON.stringify(r.body)); }
  const p = await call(creator, "POST", `/${id}/publish`);
  if (p.status !== 200) throw new Error("publish failed " + JSON.stringify(p.body));
  return { id, creator };
}
