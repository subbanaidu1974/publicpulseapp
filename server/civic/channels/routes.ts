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
 * and no OTP is ever read aloud or collected by this module (S-56: the PIN is required for every caller, single-adult SIMs included, unless
 * CIVIC_IVR_PIN_ALWAYS=0). The webhook endpoints are authenticated by ./webhook (HMAC signature or IP allow-list).
 */
import { Router, json } from "express";
import type { Request, Response } from "express";
import { audit, createSession, getSms } from "../core";
import { MediaError, storeMedia, voiceMaxBytes } from "../issues/media";
import { IVR_CATEGORY_DIGITS, ivrCategoryPrompt } from "../issues/categories";
import { sqliteCallStore, type Call, type CallStore, type IvrState } from "./callstore";
import { createWebhookAuth, webhookAuthConfigured } from "./webhook";
import { ivrSurveyStep, isSurveyIntent, type IvrSurveyStep } from "../surveys/assisted";
import { checkPin, getPerson, personsOnPhone, rateAllow, type PinResult } from "../identity/service";

export type { IvrState };
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

export class ChannelError extends Error { constructor(public code: "not_registered" | "pin_required" | "no_village" | "recording_rejected") { super(code); } }
export interface IssueSinkInput {
  channel: "ivr"; category: string; phone: string; audioKey?: string; text?: string; villageLgd?: string; /** the adult who passed the PIN step */ personId?: string;
  /** Aggregator recording URL (host allow-listed by the router); the default sink fetches it and stores it through the media route. */
  recordingUrl?: string;
}
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
  category: ivrCategoryPrompt(), // all nine web categories, generated from the single source (issues/categories.ts)
  record: { textTe: "బీప్ తర్వాత మీ సమస్యను తెలుగులో చెప్పండి. ముగించడానికి # నొక్కండి.", textEn: "After the beep, describe your issue in Telugu. Press # to finish." },
  who: { textTe: "ఈ నంబర్ పై నమోదైన వారిలో మీరు ఎవరు? మీ వరుస సంఖ్యను నొక్కండి: మొదటి వ్యక్తికి 1, రెండవ వ్యక్తికి 2, మూడవ వ్యక్తికి 3, నాల్గవ వ్యక్తికి 4, ఐదవ వ్యక్తికి 5.", textEn: "Which adult on this number are you? Press your position number: 1 for the first person, 2 for the second, 3 for the third, 4 for the fourth, 5 for the fifth." },
  pin: { textTe: "మీ వ్యక్తిగత పిన్ నమోదు చేసి # నొక్కండి. మీ పిన్ ను ఎవరికీ చెప్పకండి.", textEn: "Enter your personal PIN, then press hash. Never tell your PIN to anyone." },
  pinWrong: { textTe: "పిన్ సరైనది కాదు. మళ్ళీ ప్రయత్నించండి.", textEn: "That PIN is not correct. Please try again." },
  locked: { textTe: "చాలా తప్పు ప్రయత్నాలు జరిగాయి. ఈ సైన్-ఇన్ 30 నిమిషాల పాటు ఆగిపోయింది.", textEn: "Too many wrong attempts. This sign-in is locked for 30 minutes." },
  confirm: { textTe: "మీ సమస్య నమోదైంది. రిఫరెన్స్ నంబర్ SMS ద్వారా పంపాము.", textEn: "Your issue is recorded. The reference was sent by SMS." },
  status: { textTe: "మీ చివరి రిఫరెన్స్ SMS ద్వారా పంపబడింది.", textEn: "Your reference was re-sent by SMS." },
  survey: { textTe: "మీ ఊరిలో తాగునీటి సరఫరా సంతృప్తికరంగా ఉందా? అవును 1, కాదు 2.", textEn: "Is drinking water supply in your village satisfactory? Yes 1, No 2." },
  survey_notice: { textTe: "ఇది ఫోన్ ద్వారా అభిప్రాయ సేకరణ. మీ సమాధానం ప్లాట్‌ఫాం మీ ఖాతాతో ముడిపెట్టి చూడగలదు, మరియు యాప్ సమాధానాల నుండి వేరుగా లెక్కిస్తారు. మీరు ఒక్కసారే సమాధానం ఇవ్వగలరు; అది తుది సమాధానం.", textEn: "This is a phone opinion survey. The platform can link your answer to your account, so it is counted apart from app answers. You can answer once, and your answer is final." },
  survey_q: { textTe: "ప్రశ్న.", textEn: "Question." },
  survey_none: { textTe: "ప్రస్తుతం మీకు ఫోన్ ద్వారా సమాధానం ఇవ్వదగిన సర్వే లేదు.", textEn: "There is no survey you can answer by phone right now." },
  survey_already: { textTe: "ఈ సర్వేకు మీరు ఇప్పటికే సమాధానం ఇచ్చారు.", textEn: "You have already answered this survey." },
  thanks: { textTe: "ధన్యవాదాలు.", textEn: "Thank you." },
  invalid: { textTe: "క్షమించండి, ఆ ఎంపిక సరైనది కాదు. మళ్ళీ ప్రయత్నించండి.", textEn: "Sorry, that choice is not valid. Please try again." },
  goodbye: { textTe: "కాల్ చేసినందుకు ధన్యవాదాలు.", textEn: "Thank you for calling." },
};

/** Key pressed -> category id; the same nine categories as the web app (S-148). */
export const CATEGORIES: Record<string, string> = IVR_CATEGORY_DIGITS;

const prompt = (id: string): IvrPrompt => ({ id, audioKey: `audio/te/${id}.wav`, ...PROMPTS[id] });

const PIN_RE = /^\d{4,6}$/;
/** S-56: PIN is required for every caller unless explicitly disabled with CIVIC_IVR_PIN_ALWAYS=0 (default on). */
const pinAlways = () => process.env.CIVIC_IVR_PIN_ALWAYS !== "0";
const AGG_ID_RE = /^[\w.-]{6,64}$/;

/** Opaque storage keys only: no leading slash, no traversal segments. */
const validKey = (k: string): boolean => /^[\w./-]{1,200}$/.test(k) && !k.startsWith("/") && !k.split("/").includes("..");
// ---- aggregator recording URLs (S-146) ----
/** Hosts the aggregator serves recordings from: CIVIC_IVR_RECORDING_HOSTS, comma separated, exact or "*.example.com". Empty = URLs refused. */
const recordingHosts = () => (process.env.CIVIC_IVR_RECORDING_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
export const isUrlRef = (v: string): boolean => /^https?:\/\//i.test(v);
/** https only, no credentials, default port, host on the allow-list. Returns the normalised URL or null. */
export function allowedRecordingUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || raw.length > 600) return null;
  const host = u.hostname.toLowerCase();
  const ok = recordingHosts().some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));
  return ok ? u.toString() : null;
}
export type RecordingFetcher = (url: string, maxBytes: number) => Promise<Buffer>;
/** Default fetcher: no redirects (a redirect could leave the allow-list), 10 s timeout, streamed with a hard byte cap. */
const defaultRecordingFetcher: RecordingFetcher = async (url, maxBytes) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "audio/*" } });
  if (!res.ok || !res.body) throw new MediaError(502, "recording not available");
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) throw new MediaError(413, "recording too large");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > maxBytes) throw new MediaError(413, "recording too large");
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
};
let recordingFetcher: RecordingFetcher = defaultRecordingFetcher;
/** Install a fetcher (tests, or an aggregator SDK that needs a signed request). */
export function setRecordingFetcher(f: RecordingFetcher | null): void { recordingFetcher = f ?? defaultRecordingFetcher; }

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
const MAX_TURNS = 20;

export function defaultDeps(): ChannelDeps {
  return {
    now: () => Date.now(),
    sendSms: (to, text) => getSms().send(to.startsWith("+") ? to : "+91" + to, text),
    listAdults: async (phone) => personsOnPhone("+91" + phone).sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id)).map((p) => ({ id: p.id, label: p.label })),
    checkPin: async (personId, pin, source) => {
      const p = getPerson(personId);
      if (!p) return "wrong";
      return checkPin(p, pin, new Date(), source);
    },
    createIssue: async (input) => {
      // Identify the caller by number (callback went to that number). On a shared SIM the IVR has already verified one adult's
      // personal PIN and passes personId; without it a shared SIM is still refused.
      const phone = "+91" + input.phone;
      const people = personsOnPhone(phone);
      const who = input.personId ? people.find((p) => p.id === input.personId) : people.length === 1 ? people[0] : undefined;
      if (!who) throw new ChannelError(people.length === 0 || input.personId ? "not_registered" : "pin_required");
      const village = input.villageLgd ?? who.residence_unit;
      if (!village) throw new ChannelError("no_village");
      let audioKey = input.audioKey;
      if (input.recordingUrl) {
        // fetch the aggregator recording, then run it through the same intake as web uploads (size cap, content sniff, scan, encryption)
        const url = allowedRecordingUrl(input.recordingUrl);
        if (!url) throw new ChannelError("recording_rejected");
        try {
          const buf = await recordingFetcher(url, voiceMaxBytes());
          audioKey = (await storeMedia(who.id, buf, undefined, new Date(), { expectKind: "voice" })).ref;
        } catch (e) {
          if (e instanceof MediaError && e.status < 500) throw new ChannelError("recording_rejected");
          throw e;
        }
      }
      const token = createSession(who.id);
      const base = process.env.CIVIC_INTERNAL_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
      const res = await fetch(`${base}/api/v1/civic/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          category: input.category, village_lgd: village,
          description_en: input.text || `Voice note reported by phone (${input.category}). Audio: ${audioKey ?? "none"}`,
          ...(audioKey?.startsWith("media:") ? { voice_ref: audioKey } : { photo_ref: audioKey }), // media refs are voice notes; legacy opaque keys keep the old field
        }),
      });
      if (!res.ok) throw new Error(`issues module responded ${res.status}`);
      const body = (await res.json()) as { id?: string };
      if (!body.id) throw new Error("issues module returned no id");
      return { id: String(body.id) };
    },
  };
}

export function createChannelsRouter(deps: ChannelDeps = defaultDeps(), opts: { store?: CallStore } = {}): Router {
  const r = Router();
  r.use(json({ limit: "16kb", verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
  const webhookAuth = createWebhookAuth(() => deps.now());
  const store = opts.store ?? sqliteCallStore; // persisted (sqlite, TTL): calls survive a restart
  const dead = new Set<string>(); // calls ended during this request: not saved again
  const drop = (id: string) => { dead.add(id); store.delete(id); };
  const perPhone = new Map<string, number[]>();
  const budget: number[] = [];
  let seq = 0;

  const prune = () => { try { store.prune(deps.now()); } catch { /* best effort; get() also enforces the TTL */ } };
  const within = (arr: number[], ms: number) => { const t = deps.now(); while (arr.length && t - arr[0] > ms) arr.shift(); return arr; };
  const safeAudit = (action: string, object: string, meta?: Record<string, unknown>) => { try { audit("channels", action, object, meta); } catch { /* audit must not break a call */ } };

  const reply = (c: Call, state: IvrState, expect: IvrExpect, ids: string[], extra: Partial<IvrReply> = {}): IvrReply => {
    c.state = state;
    const base = { callId: c.callId, state, expect, prompts: ids.map(prompt), ...extra };
    return { ...base, xml: renderXml(base) };
  };

  /** Turn one assisted-survey step into an IVR reply (the question text is dynamic, so its prompt is built here). */
  const surveyReply = (c: Call, step: IvrSurveyStep): IvrReply => {
    if (step.kind === "ask") {
      c.category = step.state;
      const q = step.question;
      const scale = q.digits.every((d) => d.label_en === d.digit); // a 1-5 scale question
      const opts = (l: "te" | "en") => scale ? (l === "te" ? "1 నుండి 5 వరకు నొక్కండి: 1 తక్కువ, 5 ఎక్కువ" : "Press 1 to 5, where 1 is lowest and 5 is highest")
        : q.digits.map((d) => (l === "te" ? (d.label_te ?? d.label_en) : d.label_en) + " " + d.digit).join(", ");
      const dyn: IvrPrompt = { id: "survey_q", audioKey: "audio/te/survey_q.wav", textEn: `${q.text_en} ${opts("en")}.`, textTe: `${q.text_te ?? q.text_en} ${opts("te")}.` };
      const lead = step.notice ? [prompt("survey_notice")] : [];
      return reply(c, "survey", "digit", [], { prompts: [...lead, dyn] });
    }
    safeAudit("ivr_survey_assisted", c.callId, { result: step.kind });
    if (step.kind === "done") return reply(c, "done", "none", ["thanks", "goodbye"]);
    if (step.kind === "refused" && step.code === "already_responded") return reply(c, "done", "none", ["survey_already", "goodbye"]);
    return reply(c, "done", "none", ["survey_none", "goodbye"]);
  };

  r.post("/missed-call", webhookAuth, async (req: Request, res: Response) => {
    const phone = normPhone(req.body?.from);
    if (!phone) return void res.status(400).json({ error: "invalid_number" });
    if (within(budget, 3_600_000).length >= MISSED_CALL_BUDGET_PER_HOUR) return void res.status(429).json({ error: "callback_budget_exhausted", degraded: true });
    const mine = within(perPhone.get(phone) ?? [], 3_600_000);
    perPhone.set(phone, mine);
    if (mine.length >= MISSED_CALL_PER_PHONE_PER_HOUR) return void res.status(429).json({ error: "too_many_requests" });
    mine.push(deps.now()); budget.push(deps.now());
    prune();
    // Bind the call to the authenticated aggregator's own call id: an authenticated aggregator must supply one, and it cannot be reused.
    const agg = req.body?.aggregatorCallId;
    if (webhookAuthConfigured() && !(typeof agg === "string" && AGG_ID_RE.test(agg))) return void res.status(400).json({ error: "aggregator_call_id_required" });
    if (agg !== undefined && !(typeof agg === "string" && AGG_ID_RE.test(agg))) return void res.status(400).json({ error: "invalid_aggregator_call_id" });
    if (typeof agg === "string" && store.has(agg, deps.now())) return void res.status(409).json({ error: "duplicate_call" });
    const callId = typeof agg === "string" ? agg : `c${deps.now().toString(36)}${(++seq).toString(36)}`;
    store.put({ callId, phone, state: "welcome", createdAt: deps.now(), turns: 0 });
    safeAudit("missed_call", callId);
    // The adapter dials back; the callback is free to the citizen. No OTP, no SMS is sent at this stage.
    res.status(202).json({ status: "callback_queued", callId, callbackTo: `${phone.slice(0, 2)}******${phone.slice(-2)}` });
  });

  r.post("/ivr", webhookAuth, async (req: Request, res: Response) => {
    prune();
    const callId = typeof req.body?.callId === "string" ? req.body.callId : "";
    const c = store.get(callId, deps.now());
    if (!c) return void res.status(404).json({ error: "unknown_call" });
    const sendJson = res.json.bind(res);
    res.json = ((b: unknown) => { if (!dead.has(c.callId)) store.put(c); dead.delete(c.callId); return sendJson(b); }) as typeof res.json; // persist the new state before the reply leaves
    if (++c.turns > MAX_TURNS) { drop(callId); return void res.json(reply(c, "goodbye", "none", ["goodbye"])); }
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
          if (digits === "3") {
            // Identified callers get the real (assisted, platform-linkable) survey after their personal PIN; others get the legacy stub.
            const adults = deps.listAdults ? await deps.listAdults(c.phone) : [];
            if (!adults.length) return void res.json(reply(c, "survey", "digit", ["survey"]));
            c.adults = adults.map((a) => a.id);
            c.category = "svy"; // survey intent; the PIN is ALWAYS required for a survey, whatever CIVIC_IVR_PIN_ALWAYS says
            c.needsPin = true;
            if (adults.length > 1) return void res.json(reply(c, "who", "digit", ["who"], { adults: adults.length }));
            c.personId = adults[0].id;
            return void res.json(reply(c, "pin", "digit", ["pin"], { sensitive: true }));
          }
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
          if (!rateAllow("ivr:pin:" + c.phone, 20, 15 * 60_000, deps.now())) { drop(c.callId); return void res.json(reply(c, "goodbye", "none", ["locked"], { error: "too_many_attempts" })); }
          const r = await deps.checkPin(c.personId, digits, "ivr:" + c.phone);
          if (r === "ok") {
            c.verified = true;
            safeAudit("ivr_pin_ok", c.callId);
            if (isSurveyIntent(c.category)) return void res.json(surveyReply(c, ivrSurveyStep(c.personId!, "svy", undefined, new Date(deps.now()))));
            return void res.json(reply(c, "category", "digit", ["category"]));
          }
          safeAudit(r === "wrong" ? "ivr_pin_wrong" : "ivr_pin_locked", c.callId);
          if (r === "wrong") return void res.json(reply(c, "pin", "digit", ["pinWrong", "pin"], { sensitive: true }));
          drop(c.callId); // locked (the number's holder was told by checkPin when it tripped)
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
          const byUrl = isUrlRef(recording);
          if (byUrl ? !allowedRecordingUrl(recording) : !validKey(recording)) return void res.status(400).json({ error: byUrl ? "invalid_recording_host" : "invalid_recording_key" });
          if (c.needsPin && !c.verified) return void res.json(reply(c, "goodbye", "none", ["goodbye"]));
          const issue = await deps.createIssue({ channel: "ivr", category: c.category ?? "other", phone: c.phone, ...(byUrl ? { recordingUrl: recording } : { audioKey: recording }), ...(c.verified ? { personId: c.personId } : {}) });
          c.lastRef = issue.id;
          await deps.sendSms(c.phone, `People Pulse: your issue reference is ${issue.id}. We never ask for OTP or bank details.`);
          safeAudit("ivr_issue", issue.id, { category: c.category });
          return void res.json(reply(c, "done", "none", ["confirm", "goodbye"], { referenceId: issue.id }));
        }
        case "survey": {
          if (c.verified && c.personId && isSurveyIntent(c.category)) return void res.json(surveyReply(c, ivrSurveyStep(c.personId, c.category!, digits, new Date(deps.now()))));
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
  r.post("/voice-note", webhookAuth, async (req: Request, res: Response) => {
    const phone = normPhone(req.body?.from);
    const audioKey = typeof req.body?.audioKey === "string" && validKey(req.body.audioKey) ? req.body.audioKey : null;
    const recordingUrl = typeof req.body?.recordingUrl === "string" ? allowedRecordingUrl(req.body.recordingUrl) : null;
    const category = typeof req.body?.category === "string" && Object.values(CATEGORIES).includes(req.body.category) ? req.body.category : "other";
    if (!phone || (!audioKey && !recordingUrl)) return void res.status(400).json({ error: "invalid_request" });
    try {
      let personId: string | undefined;
      if (pinAlways() && deps.listAdults && deps.checkPin) {
        const adults = await deps.listAdults(phone);
        if (adults.length === 1) { // a single adult must also prove the PIN; a shared SIM is refused below as before
          const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
          if (!PIN_RE.test(pin)) return void res.status(409).json({ error: "pin_required" });
          const pr = await deps.checkPin(adults[0].id, pin, "ivr:" + phone);
          if (pr !== "ok") return void res.status(pr === "wrong" ? 403 : 429).json({ error: pr === "wrong" ? "pin_wrong" : "pin_locked" });
          personId = adults[0].id;
        }
      }
      const issue = await deps.createIssue({ channel: "ivr", category, phone, ...(recordingUrl ? { recordingUrl } : { audioKey: audioKey! }), ...(personId ? { personId } : {}) });
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
