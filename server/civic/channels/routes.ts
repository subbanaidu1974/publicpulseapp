/**
 * Voice-first channels (S-45, DESIGN_2028 3.9): a SIMULATED telecom adapter for missed-call callback and a Telugu IVR
 * menu state machine. No real telecom integration exists; a production aggregator adapter would call the same
 * endpoints. USSD is deliberately not built (needs per-telco agreements). IVR topics are limited to issue/service
 * matters (never election or party surveys; see the channel rule in 3.3).
 *
 * Issue intake goes over HTTP to the issues module (POST /api/v1/civic/issues) as the caller, using a session minted
 * for the single registered person on the calling number and their declared village. Unregistered numbers and shared
 * SIMs (personal-PIN step not built) are refused and told by SMS to use the app.
 */
import { Router, json } from "express";
import type { Request, Response } from "express";
import { audit, createSession, getSms } from "../core";
import { personsOnSim, phoneHash } from "../identity/service";

export type IvrState = "welcome" | "category" | "record" | "confirm" | "status" | "survey" | "done" | "goodbye";
export type IvrExpect = "digit" | "recording" | "none";

export interface IvrPrompt { id: string; audioKey: string; textTe: string; textEn: string }
export interface IvrReply {
  callId: string;
  state: IvrState;
  expect: IvrExpect;
  prompts: IvrPrompt[];
  /** XML-like text a telecom adapter can render (Play/Gather/Record). */
  xml: string;
  referenceId?: string;
  error?: string;
}

export class ChannelError extends Error { constructor(public code: "not_registered" | "pin_required" | "no_village") { super(code); } }
export interface IssueSinkInput { channel: "ivr"; category: string; phone: string; audioKey?: string; text?: string; villageLgd?: string }
export interface ChannelDeps {
  createIssue: (input: IssueSinkInput) => Promise<{ id: string }>;
  sendSms: (to: string, text: string) => Promise<void>;
  now: () => number;
}

/** Prompt catalogue. Audio files are PLACEHOLDERS; human-recorded Telugu audio replaces them (data/civic/audio-manifest.json). */
export const PROMPTS: Record<string, { textTe: string; textEn: string }> = {
  welcome: { textTe: "పీపుల్ పల్స్ కు స్వాగతం. సమస్య నమోదు చేయడానికి 1, మీ రిఫరెన్స్ స్థితికి 2, సేవల అభిప్రాయానికి 3 నొక్కండి. మేము ఎప్పుడూ OTP అడగము.", textEn: "Welcome to People Pulse. Press 1 to report an issue, 2 for reference status, 3 for a service feedback question. We never ask for your OTP." },
  category: { textTe: "సమస్య రకం: నీరు 1, రోడ్లు 2, విద్యుత్ 3, ఆరోగ్యం 4, పాఠశాల 5, ఇతరం 6.", textEn: "Issue type: water 1, roads 2, electricity 3, health 4, school 5, other 6." },
  record: { textTe: "బీప్ తర్వాత మీ సమస్యను తెలుగులో చెప్పండి. ముగించడానికి # నొక్కండి.", textEn: "After the beep, describe your issue in Telugu. Press # to finish." },
  confirm: { textTe: "మీ సమస్య నమోదైంది. రిఫరెన్స్ నంబర్ SMS ద్వారా పంపాము.", textEn: "Your issue is recorded. The reference was sent by SMS." },
  status: { textTe: "మీ చివరి రిఫరెన్స్ SMS ద్వారా పంపబడింది.", textEn: "Your reference was re-sent by SMS." },
  survey: { textTe: "మీ ఊరిలో తాగునీటి సరఫరా సంతృప్తికరంగా ఉందా? అవును 1, కాదు 2.", textEn: "Is drinking water supply in your village satisfactory? Yes 1, No 2." },
  thanks: { textTe: "ధన్యవాదాలు.", textEn: "Thank you." },
  invalid: { textTe: "క్షమించండి, ఆ ఎంపిక సరైనది కాదు. మళ్ళీ ప్రయత్నించండి.", textEn: "Sorry, that choice is not valid. Please try again." },
  goodbye: { textTe: "కాల్ చేసినందుకు ధన్యవాదాలు.", textEn: "Thank you for calling." },
};

export const CATEGORIES: Record<string, string> = { "1": "water", "2": "roads", "3": "electricity", "4": "health", "5": "education", "6": "other" };

const prompt = (id: string): IvrPrompt => ({ id, audioKey: `audio/te/${id}.wav`, ...PROMPTS[id] });

interface Call { callId: string; phone: string; state: IvrState; category?: string; referenceId?: string; lastRef?: string; createdAt: number; turns: number }

/** Opaque storage keys only: no leading slash, no traversal segments. */
const validKey = (k: string): boolean => /^[\w./-]{1,200}$/.test(k) && !k.startsWith("/") && !k.split("/").includes("..");
const PHONE_RE = /^[6-9]\d{9}$/;
const normPhone = (p: unknown): string | null => {
  if (typeof p !== "string") return null;
  const s = p.replace(/[\s-]/g, "");
  const d = /^\+?91\d{10}$/.test(s) ? s.replace(/^\+?91/, "") : s;
  return PHONE_RE.test(d) ? d : null;
};

function renderXml(reply: Omit<IvrReply, "xml">): string {
  const body = reply.prompts.map((p) => `<Play src="${p.audioKey}" id="${p.id}"/>`).join("");
  const input = reply.expect === "digit" ? `<Gather numDigits="1" timeout="6">${body}</Gather>`
    : reply.expect === "recording" ? `${body}<Record maxLength="60" finishOnKey="#"/>` : `${body}<Hangup/>`;
  return `<Response>${input}</Response>`;
}

const MISSED_CALL_PER_PHONE_PER_HOUR = 3;
const MISSED_CALL_BUDGET_PER_HOUR = Number(process.env.CIVIC_CALLBACK_BUDGET_PER_HOUR || 500);
const CALL_TTL_MS = 15 * 60_000;
const MAX_TURNS = 20;

export function defaultDeps(): ChannelDeps {
  return {
    now: () => Date.now(),
    sendSms: (to, text) => getSms().send(to.startsWith("+") ? to : "+91" + to, text),
    createIssue: async (input) => {
      // Identify the caller by number (callback went to that number). Shared SIMs need the personal-PIN step, which is NOT built yet: refused.
      const phone = "+91" + input.phone;
      const people = personsOnSim(phoneHash(phone));
      if (people.length !== 1) throw new ChannelError(people.length === 0 ? "not_registered" : "pin_required");
      const village = input.villageLgd ?? people[0].residence_unit;
      if (!village) throw new ChannelError("no_village");
      const token = createSession(people[0].id);
      const base = process.env.CIVIC_INTERNAL_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
      const res = await fetch(`${base}/api/v1/civic/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          category: input.category, village_lgd: village,
          description_en: input.text || `Voice note reported by phone (${input.category}). Audio: ${input.audioKey ?? "none"}`,
          photo_ref: input.audioKey,
        }),
      });
      if (!res.ok) throw new Error(`issues module responded ${res.status}`);
      const body = (await res.json()) as { id?: string };
      if (!body.id) throw new Error("issues module returned no id");
      return { id: String(body.id) };
    },
  };
}

export function createChannelsRouter(deps: ChannelDeps = defaultDeps()): Router {
  const r = Router();
  r.use(json({ limit: "16kb" }));
  const calls = new Map<string, Call>();
  const perPhone = new Map<string, number[]>();
  const budget: number[] = [];
  let seq = 0;

  const prune = () => {
    const t = deps.now();
    for (const [k, c] of calls) if (t - c.createdAt > CALL_TTL_MS) calls.delete(k);
  };
  const within = (arr: number[], ms: number) => { const t = deps.now(); while (arr.length && t - arr[0] > ms) arr.shift(); return arr; };
  const safeAudit = (action: string, object: string, meta?: Record<string, unknown>) => { try { audit("channels", action, object, meta); } catch { /* audit must not break a call */ } };

  const reply = (c: Call, state: IvrState, expect: IvrExpect, ids: string[], extra: Partial<IvrReply> = {}): IvrReply => {
    c.state = state;
    const base = { callId: c.callId, state, expect, prompts: ids.map(prompt), ...extra };
    return { ...base, xml: renderXml(base) };
  };

  r.post("/missed-call", async (req: Request, res: Response) => {
    const phone = normPhone(req.body?.from);
    if (!phone) return void res.status(400).json({ error: "invalid_number" });
    if (within(budget, 3_600_000).length >= MISSED_CALL_BUDGET_PER_HOUR) return void res.status(429).json({ error: "callback_budget_exhausted", degraded: true });
    const mine = within(perPhone.get(phone) ?? [], 3_600_000);
    perPhone.set(phone, mine);
    if (mine.length >= MISSED_CALL_PER_PHONE_PER_HOUR) return void res.status(429).json({ error: "too_many_requests" });
    mine.push(deps.now()); budget.push(deps.now());
    prune();
    const callId = `c${deps.now().toString(36)}${(++seq).toString(36)}`;
    calls.set(callId, { callId, phone, state: "welcome", createdAt: deps.now(), turns: 0 });
    safeAudit("missed_call", callId);
    // The adapter dials back; the callback is free to the citizen. No OTP, no SMS is sent at this stage.
    res.status(202).json({ status: "callback_queued", callId, callbackTo: `${phone.slice(0, 2)}******${phone.slice(-2)}` });
  });

  r.post("/ivr", async (req: Request, res: Response) => {
    prune();
    const callId = typeof req.body?.callId === "string" ? req.body.callId : "";
    const c = calls.get(callId);
    if (!c) return void res.status(404).json({ error: "unknown_call" });
    if (++c.turns > MAX_TURNS) { calls.delete(callId); return void res.json(reply(c, "goodbye", "none", ["goodbye"])); }
    const digits = typeof req.body?.digits === "string" ? req.body.digits.slice(0, 4) : undefined;
    const recording = typeof req.body?.recording === "string" ? req.body.recording : undefined;

    try {
      switch (c.state) {
        case "welcome": {
          if (digits === undefined) return void res.json(reply(c, "welcome", "digit", ["welcome"]));
          if (digits === "1") return void res.json(reply(c, "category", "digit", ["category"]));
          if (digits === "2") {
            if (c.lastRef) await deps.sendSms(c.phone, `People Pulse: your issue reference is ${c.lastRef}. We never ask for OTP or bank details.`);
            return void res.json(reply(c, "status", "none", ["status", "goodbye"]));
          }
          if (digits === "3") return void res.json(reply(c, "survey", "digit", ["survey"]));
          return void res.json(reply(c, "welcome", "digit", ["invalid", "welcome"]));
        }
        case "category": {
          const cat = digits ? CATEGORIES[digits] : undefined;
          if (!cat) return void res.json(reply(c, "category", "digit", ["invalid", "category"]));
          c.category = cat;
          return void res.json(reply(c, "record", "recording", ["record"]));
        }
        case "record": {
          if (!recording) return void res.json(reply(c, "record", "recording", ["record"]));
          if (!validKey(recording)) return void res.status(400).json({ error: "invalid_recording_key" });
          const issue = await deps.createIssue({ channel: "ivr", category: c.category ?? "other", phone: c.phone, audioKey: recording });
          c.lastRef = issue.id;
          await deps.sendSms(c.phone, `People Pulse: your issue reference is ${issue.id}. We never ask for OTP or bank details.`);
          safeAudit("ivr_issue", issue.id, { category: c.category });
          return void res.json(reply(c, "done", "none", ["confirm", "goodbye"], { referenceId: issue.id }));
        }
        case "survey": {
          if (digits !== "1" && digits !== "2") return void res.json(reply(c, "survey", "digit", ["invalid", "survey"]));
          safeAudit("ivr_survey_answer", c.callId);
          return void res.json(reply(c, "done", "none", ["thanks", "goodbye"]));
        }
        default:
          return void res.json(reply(c, "goodbye", "none", ["goodbye"]));
      }
    } catch (e) {
      if (e instanceof ChannelError) {
        try { await deps.sendSms(c.phone, "People Pulse: we could not file this by phone. Please sign up or sign in on the app, then try again. We never ask for OTP or bank details."); } catch { /* best effort */ }
        return void res.json(reply(c, "goodbye", "none", ["goodbye"], { error: e.code } as Partial<IvrReply>));
      }
      // Delivery failures must not leak internals; the telecom adapter retries the turn.
      return void res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  /** Voice-note intake outside an IVR call (e.g. a PWA-lite or aggregator upload reference). */
  r.post("/voice-note", async (req: Request, res: Response) => {
    const phone = normPhone(req.body?.from);
    const audioKey = typeof req.body?.audioKey === "string" && validKey(req.body.audioKey) ? req.body.audioKey : null;
    const category = typeof req.body?.category === "string" && Object.values(CATEGORIES).includes(req.body.category) ? req.body.category : "other";
    if (!phone || !audioKey) return void res.status(400).json({ error: "invalid_request" });
    try {
      const issue = await deps.createIssue({ channel: "ivr", category, phone, audioKey });
      await deps.sendSms(phone, `People Pulse: your issue reference is ${issue.id}. We never ask for OTP or bank details.`);
      res.status(201).json({ referenceId: issue.id });
    } catch (e) {
      if (e instanceof ChannelError) return void res.status(409).json({ error: e.code });
      res.status(502).json({ error: "upstream_unavailable" });
    }
  });

  return r;
}

export const channelsRouter = createChannelsRouter();
