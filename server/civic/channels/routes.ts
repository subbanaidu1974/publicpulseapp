/**
 * Voice-first channels (S-45, DESIGN_2028 3.9): a SIMULATED telecom adapter for missed-call callback and a Telugu IVR
 * menu state machine. No real telecom integration exists; a production aggregator adapter would call the same
 * endpoints. USSD is deliberately not built (needs per-telco agreements). IVR topics are limited to issue/service
 * matters (never election or party surveys; see the channel rule in 3.3).
 *
 * Issue intake goes over HTTP to the issues module (POST /api/v1/civic/issues) as the caller, using a session minted
 * for the person on the calling number and their declared village. Unregistered numbers are refused and told by SMS to
 * use the app. SHARED SIMs are supported: the IVR asks which adult is calling (their position on the number), then that
 * adult's personal PIN by keypad; wrong PINs go through identity checkPin (persisted counter, 5-attempt lockout per source,
 * here source = "ivr:<number>", plus the per-person ceiling), which texts the number's holder when it trips. The PIN is never stored in call state, audited, echoed or sent by SMS,
 * and no OTP is ever read aloud or collected by this module (single-adult SIMs keep the no-PIN flow unless
 * CIVIC_IVR_PIN_ALWAYS=1).
 */
import { Router, json } from "express";
import type { Request, Response } from "express";
import { audit, createSession, getSms } from "../core";
import { checkPin, getPerson, personsOnSim, phoneHash, rateAllow, type PinResult } from "../identity/service";

export type IvrState = "welcome" | "who" | "pin" | "category" | "record" | "confirm" | "status" | "survey" | "done" | "goodbye";
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
  /** True when the caller is keying a secret (PIN): the adapter must not log or record the digits. */
  sensitive?: boolean;
  /** For the "who" step: how many adults share the number (positions 1..n, in the order they were added). */
  adults?: number;
}

export class ChannelError extends Error { constructor(public code: "not_registered" | "pin_required" | "no_village") { super(code); } }
export interface IssueSinkInput { channel: "ivr"; category: string; phone: string; audioKey?: string; text?: string; villageLgd?: string; /** the adult who passed the PIN step */ personId?: string }
export interface ChannelDeps {
  createIssue: (input: IssueSinkInput) => Promise<{ id: string }>;
  sendSms: (to: string, text: string) => Promise<void>;
  now: () => number;
  /** Adults registered on the calling number, in registration order. Omit to skip identification (legacy single-person flow). */
  listAdults?: (phone: string) => Promise<{ id: string; label: string | null }[]>;
  /** Verify one adult's personal PIN with the identity module's persisted attempt counter and 5-attempt lockout; `source` scopes the counter (here "ivr:<phone>"). */
  checkPin?: (personId: string, pin: string, source: string) => Promise<PinResult>;
}

/** Prompt catalogue. Audio files are PLACEHOLDERS; human-recorded Telugu audio replaces them (data/civic/audio-manifest.json). */
export const PROMPTS: Record<string, { textTe: string; textEn: string }> = {
  welcome: { textTe: "పీపుల్ పల్స్ కు స్వాగతం. సమస్య నమోదు చేయడానికి 1, మీ రిఫరెన్స్ స్థితికి 2, సేవల అభిప్రాయానికి 3 నొక్కండి. మేము ఎప్పుడూ OTP అడగము.", textEn: "Welcome to People Pulse. Press 1 to report an issue, 2 for reference status, 3 for a service feedback question. We never ask for your OTP." },
  category: { textTe: "సమస్య రకం: నీరు 1, రోడ్లు 2, విద్యుత్ 3, ఆరోగ్యం 4, పాఠశాల 5, ఇతరం 6.", textEn: "Issue type: water 1, roads 2, electricity 3, health 4, school 5, other 6." },
  record: { textTe: "బీప్ తర్వాత మీ సమస్యను తెలుగులో చెప్పండి. ముగించడానికి # నొక్కండి.", textEn: "After the beep, describe your issue in Telugu. Press # to finish." },
  who: { textTe: "ఈ నంబర్ పై నమోదైన వారిలో మీరు ఎవరు? మీ వరుస సంఖ్యను నొక్కండి: మొదటి వ్యక్తికి 1, రెండవ వ్యక్తికి 2, మూడవ వ్యక్తికి 3, నాల్గవ వ్యక్తికి 4, ఐదవ వ్యక్తికి 5.", textEn: "Which adult on this number are you? Press your position number: 1 for the first person, 2 for the second, 3 for the third, 4 for the fourth, 5 for the fifth." },
  pin: { textTe: "మీ వ్యక్తిగత పిన్ నమోదు చేసి # నొక్కండి. మీ పిన్ ను ఎవరికీ చెప్పకండి.", textEn: "Enter your personal PIN, then press hash. Never tell your PIN to anyone." },
  pinWrong: { textTe: "పిన్ సరైనది కాదు. మళ్ళీ ప్రయత్నించండి.", textEn: "That PIN is not correct. Please try again." },
  locked: { textTe: "చాలా తప్పు ప్రయత్నాలు జరిగాయి. ఈ సైన్-ఇన్ 30 నిమిషాల పాటు ఆగిపోయింది.", textEn: "Too many wrong attempts. This sign-in is locked for 30 minutes." },
  confirm: { textTe: "మీ సమస్య నమోదైంది. రిఫరెన్స్ నంబర్ SMS ద్వారా పంపాము.", textEn: "Your issue is recorded. The reference was sent by SMS." },
  status: { textTe: "మీ చివరి రిఫరెన్స్ SMS ద్వారా పంపబడింది.", textEn: "Your reference was re-sent by SMS." },
  survey: { textTe: "మీ ఊరిలో తాగునీటి సరఫరా సంతృప్తికరంగా ఉందా? అవును 1, కాదు 2.", textEn: "Is drinking water supply in your village satisfactory? Yes 1, No 2." },
  thanks: { textTe: "ధన్యవాదాలు.", textEn: "Thank you." },
  invalid: { textTe: "క్షమించండి, ఆ ఎంపిక సరైనది కాదు. మళ్ళీ ప్రయత్నించండి.", textEn: "Sorry, that choice is not valid. Please try again." },
  goodbye: { textTe: "కాల్ చేసినందుకు ధన్యవాదాలు.", textEn: "Thank you for calling." },
};

export const CATEGORIES: Record<string, string> = { "1": "water", "2": "roads", "3": "electricity", "4": "health", "5": "education", "6": "other" };

const prompt = (id: string): IvrPrompt => ({ id, audioKey: `audio/te/${id}.wav`, ...PROMPTS[id] });

interface Call { callId: string; phone: string; state: IvrState; category?: string; referenceId?: string; lastRef?: string; createdAt: number; turns: number; adults?: string[]; personId?: string; needsPin?: boolean; verified?: boolean }
const PIN_RE = /^\d{4,6}$/;
const pinAlways = () => process.env.CIVIC_IVR_PIN_ALWAYS === "1";

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
  const input = reply.sensitive ? `<Gather numDigits="6" finishOnKey="#" timeout="12" secret="true">${body}</Gather>`
    : reply.expect === "digit" ? `<Gather numDigits="1" timeout="6">${body}</Gather>`
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
    listAdults: async (phone) => personsOnSim(phoneHash("+91" + phone)).sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id)).map((p) => ({ id: p.id, label: p.label })),
    checkPin: async (personId, pin, source) => {
      const p = getPerson(personId);
      if (!p) return "wrong";
      return checkPin(p, pin, new Date(), source);
    },
    createIssue: async (input) => {
      // Identify the caller by number (callback went to that number). On a shared SIM the IVR has already verified one adult's
      // personal PIN and passes personId; without it a shared SIM is still refused.
      const phone = "+91" + input.phone;
      const people = personsOnSim(phoneHash(phone));
      const who = input.personId ? people.find((p) => p.id === input.personId) : people.length === 1 ? people[0] : undefined;
      if (!who) throw new ChannelError(people.length === 0 || input.personId ? "not_registered" : "pin_required");
      const village = input.villageLgd ?? who.residence_unit;
      if (!village) throw new ChannelError("no_village");
      const token = createSession(who.id);
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
    const digits = typeof req.body?.digits === "string" ? req.body.digits.slice(0, 8) : undefined;
    const recording = typeof req.body?.recording === "string" ? req.body.recording : undefined;

    try {
      switch (c.state) {
        case "welcome": {
          if (digits === undefined) return void res.json(reply(c, "welcome", "digit", ["welcome"]));
          if (digits === "1") {
            const adults = deps.listAdults ? await deps.listAdults(c.phone) : [];
            c.adults = adults.map((a) => a.id);
            c.needsPin = adults.length > 1 || (pinAlways() && adults.length === 1);
            if (adults.length > 1) return void res.json(reply(c, "who", "digit", ["who"], { adults: adults.length }));
            if (c.needsPin) { c.personId = adults[0].id; return void res.json(reply(c, "pin", "digit", ["pin"], { sensitive: true })); }
            return void res.json(reply(c, "category", "digit", ["category"]));
          }
          if (digits === "2") {
            if (c.lastRef) await deps.sendSms(c.phone, `People Pulse: your issue reference is ${c.lastRef}. We never ask for OTP or bank details.`);
            return void res.json(reply(c, "status", "none", ["status", "goodbye"]));
          }
          if (digits === "3") return void res.json(reply(c, "survey", "digit", ["survey"]));
          return void res.json(reply(c, "welcome", "digit", ["invalid", "welcome"]));
        }
        case "who": {
          const n = digits && /^[1-9]$/.test(digits) ? Number(digits) : 0;
          const id = c.adults?.[n - 1];
          if (!id) return void res.json(reply(c, "who", "digit", ["invalid", "who"], { adults: c.adults?.length }));
          c.personId = id;
          return void res.json(reply(c, "pin", "digit", ["pin"], { sensitive: true }));
        }
        case "pin": {
          if (!c.personId || !deps.checkPin) return void res.json(reply(c, "goodbye", "none", ["goodbye"]));
          if (digits === undefined) return void res.json(reply(c, "pin", "digit", ["pin"], { sensitive: true }));
          if (!PIN_RE.test(digits)) return void res.json(reply(c, "pin", "digit", ["invalid", "pin"], { sensitive: true }));
          if (!rateAllow("ivr:pin:" + c.phone, 20, 15 * 60_000, deps.now())) { calls.delete(c.callId); return void res.json(reply(c, "goodbye", "none", ["locked"], { error: "too_many_attempts" })); }
          const r = await deps.checkPin(c.personId, digits, "ivr:" + c.phone);
          if (r === "ok") {
            c.verified = true;
            safeAudit("ivr_pin_ok", c.callId);
            return void res.json(reply(c, "category", "digit", ["category"]));
          }
          safeAudit(r === "wrong" ? "ivr_pin_wrong" : "ivr_pin_locked", c.callId);
          if (r === "wrong") return void res.json(reply(c, "pin", "digit", ["pinWrong", "pin"], { sensitive: true }));
          calls.delete(c.callId); // locked (the number's holder was told by checkPin when it tripped)
          return void res.json(reply(c, "goodbye", "none", ["locked", "goodbye"], { error: r === "limited" ? "pin_limited" : "pin_locked" }));
        }
        case "category": {
          if (c.needsPin && !c.verified) return void res.json(reply(c, "goodbye", "none", ["goodbye"]));
          const cat = digits ? CATEGORIES[digits] : undefined;
          if (!cat) return void res.json(reply(c, "category", "digit", ["invalid", "category"]));
          c.category = cat;
          return void res.json(reply(c, "record", "recording", ["record"]));
        }
        case "record": {
          if (!recording) return void res.json(reply(c, "record", "recording", ["record"]));
          if (!validKey(recording)) return void res.status(400).json({ error: "invalid_recording_key" });
          if (c.needsPin && !c.verified) return void res.json(reply(c, "goodbye", "none", ["goodbye"]));
          const issue = await deps.createIssue({ channel: "ivr", category: c.category ?? "other", phone: c.phone, audioKey: recording, ...(c.verified ? { personId: c.personId } : {}) });
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
