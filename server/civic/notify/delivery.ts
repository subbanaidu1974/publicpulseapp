/**
 * Recipient side (S-38): preferences, quiet hours, caps, anti-phishing word, push transport (dev only), SMS fallback, inbox and receipts.
 * There is NO real push provider (FCM/APNs): PushTransport is an interface; the dev transport keeps an in-memory outbox and, in production,
 * reports "no_push_provider" so the SMS fallback applies and the inbox stays the in-app channel.
 */
import crypto from "node:crypto";
import { audit, getKeys, getSms } from "../core";
import { identityDb } from "../core/asyncBridge";
import { NotifyStore } from "../../data/repos/notify";
import { getMail } from "../providers/mail";
import type { SmsProviderV2 } from "../providers/sms";
import { loadTemplateRegistry } from "../providers/sms";
import { notifyPolicy } from "./content";

const st = (): NotifyStore => new NotifyStore(identityDb());
export const IST_MS = 330 * 60_000;
export const nowFn: { now: () => Date } = { now: () => new Date() };
/** Tests only. */
export const setNotifyClock = (f: (() => Date) | null): void => { nowFn.now = f ?? (() => new Date()); };

// ---------------------------------------------------------------------------------------------
// Push transport
// ---------------------------------------------------------------------------------------------

export interface PushPayload { messageId: string; category: string; org: string; title: string; body: string; antiphish: string | null; signature: string; keyId: string; sentAt: string }
export interface PushResult { ok: boolean; error?: string }
export interface PushTransport { readonly name: string; send(tokens: string[], payload: PushPayload): Promise<PushResult> }

export const pushOutbox: { tokens: number; payload: PushPayload }[] = [];
export class DevPushTransport implements PushTransport {
  readonly name = "dev-memory";
  failNext = false;
  async send(tokens: string[], payload: PushPayload): Promise<PushResult> {
    if (process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production") return { ok: false, error: "no_push_provider" };
    if (this.failNext) { this.failNext = false; return { ok: false, error: "dev_forced_failure" }; }
    pushOutbox.push({ tokens: tokens.length, payload }); if (pushOutbox.length > 500) pushOutbox.shift();
    return { ok: true };
  }
}
let transport: PushTransport = new DevPushTransport();
export const setPushTransport = (t: PushTransport | null): void => { transport = t ?? new DevPushTransport(); };
export const getPushTransport = (): PushTransport => transport;

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMin = (s: string): number => { const m = HHMM.exec(s)!; return Number(m[1]) * 60 + Number(m[2]); };

export interface Prefs {
  categories: Record<string, { opted_in: boolean; locked: boolean }>;
  quiet_hours: { start: string; end: string; default: boolean };
  language: "te" | "en"; sms_ok: boolean; email_ok: boolean; has_email: boolean; push_blocked: boolean; antiphish_set: boolean;
}

export async function getPrefs(personId: string): Promise<Prefs> {
  const p = notifyPolicy(), s = st(), row = await s.personPrefs(personId);
  const stored = await s.categoryPrefs(personId);
  const categories: Prefs["categories"] = {};
  for (const c of p.categories) categories[c] = c === "emergency" ? { opted_in: true, locked: true } : { opted_in: stored.get(c) ?? false, locked: false };
  return {
    categories,
    quiet_hours: { start: row?.quiet_start ?? p.quiet_hours.default_start, end: row?.quiet_end ?? p.quiet_hours.default_end, default: !row?.quiet_start },
    language: row?.language === "en" ? "en" : "te", sms_ok: !!row?.sms_ok, email_ok: !!row?.email_ok, has_email: await hasEmail(personId), push_blocked: !!row?.push_blocked, antiphish_set: !!row?.antiphish_enc,
  };
}

export class PrefError extends Error { constructor(public code: string, m: string) { super(m); } }
const ensurePerson = (personId: string): Promise<void> => st().ensurePerson(personId, nowFn.now().toISOString());

export async function updatePrefs(personId: string, body: Record<string, unknown>): Promise<Prefs> {
  const p = notifyPolicy(), d = st(), ts = nowFn.now().toISOString();
  await ensurePerson(personId);
  const cats = body.categories;
  if (cats !== undefined) {
    if (!cats || typeof cats !== "object") throw new PrefError("bad_categories", "categories must be an object of category: boolean");
    for (const [c, v] of Object.entries(cats as Record<string, unknown>)) {
      if (!p.categories.includes(c)) throw new PrefError("unknown_category", "unknown category");
      if (typeof v !== "boolean") throw new PrefError("bad_categories", "category values must be true or false");
      if (c === "emergency") { if (v === false) throw new PrefError("emergency_locked", "emergency notices cannot be switched off"); continue; }
      await d.setCategory(personId, c, v, ts);
    }
  }
  const q = body.quiet_hours as { start?: unknown; end?: unknown } | undefined;
  if (q !== undefined) {
    if (!q || typeof q.start !== "string" || typeof q.end !== "string" || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) throw new PrefError("bad_quiet_hours", "quiet_hours needs start and end as HH:MM (IST), different from each other");
    await d.setQuiet(personId, q.start, q.end);
  }
  if (body.language !== undefined) { if (body.language !== "te" && body.language !== "en") throw new PrefError("bad_language", "language must be te or en"); await d.setLanguage(personId, body.language); }
  if (body.sms_ok !== undefined) { if (typeof body.sms_ok !== "boolean") throw new PrefError("bad_sms_ok", "sms_ok must be true or false"); await d.setFlag(personId, "sms_ok", body.sms_ok); }
  if (body.email_ok !== undefined) {
    if (typeof body.email_ok !== "boolean") throw new PrefError("bad_email_ok", "email_ok must be true or false");
    if (body.email_ok && !(await hasEmail(personId))) throw new PrefError("no_email", "this account has no email address on it");
    await d.setFlag(personId, "email_ok", body.email_ok);
  }
  if (body.push_blocked !== undefined) { if (typeof body.push_blocked !== "boolean") throw new PrefError("bad_push_blocked", "push_blocked must be true or false"); await d.setFlag(personId, "push_blocked", body.push_blocked); }
  await d.touchPerson(personId, ts);
  audit(personId, "notify.prefs.update", "person:" + personId, {});
  return getPrefs(personId);
}

/** Unsubscribe: every non-emergency category off. Emergency notices stay (see docs/NOTIFICATIONS.md). */
export async function unsubscribeAll(personId: string): Promise<Prefs> {
  const cats: Record<string, boolean> = {};
  for (const c of notifyPolicy().categories) if (c !== "emergency") cats[c] = false;
  return updatePrefs(personId, { categories: cats });
}

export async function setAntiPhish(personId: string, word: unknown): Promise<void> {
  const p = notifyPolicy();
  const w = typeof word === "string" ? word.normalize("NFKC").trim() : "";
  if (w.length < p.limits.antiphish_min || w.length > p.limits.antiphish_max) throw new PrefError("bad_word", `the word or phrase must be ${p.limits.antiphish_min} to ${p.limits.antiphish_max} characters`);
  if (/[<>{}\\]|https?:|www\.|@|\d{4,}/i.test(w)) throw new PrefError("bad_word", "the word or phrase cannot contain links, symbols or long numbers");
  await ensurePerson(personId);
  await st().setAntiphish(personId, getKeys().encrypt("notify-antiphish", w), nowFn.now().toISOString());
  audit(personId, "notify.antiphish.set", "person:" + personId, {});
}
export async function getAntiPhish(personId: string): Promise<string | null> {
  const r = await st().personPrefs(personId);
  if (!r?.antiphish_enc) return null;
  try { return getKeys().decrypt("notify-antiphish", r.antiphish_enc); } catch { return null; }
}

export async function registerDevice(personId: string, token: unknown, platform: unknown): Promise<void> {
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) throw new PrefError("bad_token", "token missing or malformed");
  const pf = platform === "ios" || platform === "web" ? platform : "android";
  const k = getKeys();
  await st().saveDevice({ token_hash: k.hmac("notify-device", token), person_id: personId, token_enc: k.encrypt("notify-device", token), platform: pf, at: nowFn.now().toISOString() });
}
/** The caller's own registered devices for the settings screen. The token (and its hash) is never returned: `id` is a short reference only. */
export async function listDevices(personId: string): Promise<{ id: string; platform: string; label_en: string; label_te: string; created_at: string }[]> {
  const names: Record<string, [string, string]> = { android: ["Android phone", "ఆండ్రాయిడ్ ఫోన్"], ios: ["iPhone or iPad", "ఐఫోన్ లేదా ఐప్యాడ్"], web: ["Web browser", "వెబ్ బ్రౌజర్"] };
  const rows = (await st().devices(personId)) as { token_hash: string; platform: string; created_at: string }[];
  return rows.map((r) => { const n = names[r.platform] ?? names.android; return { id: r.token_hash.slice(0, 12), platform: r.platform, label_en: n[0], label_te: n[1], created_at: r.created_at }; });
}
export const removeDevices = (personId: string): Promise<void> => st().removeDevices(personId);
async function deviceTokens(personId: string): Promise<string[]> {
  return (await st().deviceTokensEnc(personId)).flatMap((enc) => { try { return [getKeys().decrypt("notify-device", enc)]; } catch { return []; } });
}

// ---------------------------------------------------------------------------------------------
// Quiet hours and caps (all IST)
// ---------------------------------------------------------------------------------------------

export const istMinutes = (t: Date): number => Math.floor(((t.getTime() + IST_MS) % 86_400_000) / 60_000);
export function inQuiet(start: string, end: string, t: Date): boolean {
  const m = istMinutes(t), a = toMin(start), b = toMin(end);
  return a < b ? m >= a && m < b : m >= a || m < b;
}
/** Next instant at which the quiet window ends (IST minute == end). */
export function quietEndsAt(end: string, t: Date): Date {
  const cur = istMinutes(t), e = toMin(end);
  const delta = (e - cur + 1440) % 1440 || 1440;
  return new Date(Math.floor(t.getTime() / 60_000) * 60_000 + delta * 60_000);
}
const istDayStart = (t: Date): number => Math.floor((t.getTime() + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;

async function capReached(personId: string, category: string, t: Date): Promise<"daily" | "weekly" | null> {
  const cap = notifyPolicy().caps[category];
  if (!cap) return null;
  const q = (since: number) => st().capCount(personId, category, new Date(since).toISOString());
  const day = istDayStart(t);
  if ((await q(day)) >= cap.daily) return "daily";
  if ((await q(day - 6 * 86_400_000)) >= cap.weekly) return "weekly";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

export interface DeliverableMessage {
  id: string; category: string; org_name: string; title_en: string; title_te: string; text_en: string; text_te: string; signature: string; key_id: string; sent_at: string; expires_at: string | null;
}
export type SkipReason = "opted_out" | "daily_cap" | "weekly_cap" | "none";
export interface DeliveryOutcome { result: "delivered" | "deferred" | "skipped"; skip?: SkipReason; push?: string; sms?: string }

/** Decide and (when allowed) deliver one message to one person. Never throws. */
export async function deliverTo(personId: string, m: DeliverableMessage, t: Date = nowFn.now()): Promise<DeliveryOutcome> {
  const p = notifyPolicy();
  const prefs = await getPrefs(personId);
  const emergency = m.category === "emergency";
  if (!emergency && !prefs.categories[m.category]?.opted_in) return { result: "skipped", skip: "opted_out" };
  const cap = await capReached(personId, m.category, t);
  if (cap) return { result: "skipped", skip: cap === "daily" ? "daily_cap" : "weekly_cap" };
  const id = crypto.randomUUID(), ts = t.toISOString();
  const bypass = p.quiet_hours.bypass.includes(m.category);
  if (!bypass && inQuiet(prefs.quiet_hours.start, prefs.quiet_hours.end, t)) {
    const after = quietEndsAt(prefs.quiet_hours.end, t);
    if (!m.expires_at || after.toISOString() < m.expires_at) {
      await st().insertDeferred({ id, person_id: personId, message_id: m.id, category: m.category, deliver_after: after.toISOString(), at: ts });
      return { result: "deferred" };
    }
    return { result: "skipped", skip: "none" };
  }
  await st().insertDelivered({ id, person_id: personId, message_id: m.id, category: m.category, at: ts });
  const ch = await dispatch(id, personId, m, prefs);
  return { result: "delivered", ...ch };
}

async function hasEmail(personId: string): Promise<boolean> { return !!(await st().emailEnc(personId)); }

/**
 * Email channel (S-184). Only for a person who switched it on (`email_ok`); never otherwise, emergency included, because holding and using
 * an email contact needs the person's own consent. The body carries the sender, the anti-phishing word and the signature reference, and no links.
 */
async function sendEmail(personId: string, m: DeliverableMessage, lang: "te" | "en", word: string | null): Promise<string> {
  try {
    const enc = await st().emailEnc(personId);
    if (!enc) return "no_email";
    const to = getKeys().decrypt("phone", enc).replace(/^email:/, ""); // stored as "email:<canonical address>" (identity/email.ts emailKey)
    const te = lang === "te";
    const title = te ? m.title_te : m.title_en, text = te ? m.text_te : m.text_en;
    const safe = (s: string): string => s.replace(/https?:\/\/\S+/gi, "[link removed]");
    const w = word ?? (te ? "పదం లేదు" : "no word set");
    const body = [
      te ? `పంపినవారు: ${m.org_name}` : `From: ${m.org_name}`,
      te ? `మీ భద్రతా పదం: ${w}` : `Your safety word: ${w}`,
      te ? "ఈ పదం లేకపోతే ఈ మెయిల్‌ను నమ్మకండి." : "If this word is missing, do not trust this email.",
      "", safe(title), "", safe(text), "",
      te ? `సంతకం సూచిక: ${m.key_id}` : `Signature reference: ${m.key_id}`,
      te ? "ఈ మెయిల్‌కు సమాధానం ఇవ్వకండి. నోటిఫికేషన్ సెట్టింగ్స్‌లో దీన్ని ఆపవచ్చు." : "Do not reply to this email. You can switch it off in notification settings.",
    ].join("\n");
    await getMail().send({ to, subject: `People Pulse: ${safe(title)}`.slice(0, 150), text: body, idempotencyKey: getKeys().hmac("mail-idem", `notify:${m.id}:${personId}`) });
    return "sent";
  } catch { return "failed"; }
}

async function dispatch(inboxId: string, personId: string, m: DeliverableMessage, prefs: Prefs): Promise<{ push: string; sms?: string; email?: string }> {
  const p = notifyPolicy();
  const lang = prefs.language, word = await getAntiPhish(personId);
  const title = lang === "te" ? m.title_te : m.title_en, body = lang === "te" ? m.text_te : m.text_en;
  let push: string;
  const tokens = prefs.push_blocked ? [] : await deviceTokens(personId);
  if (prefs.push_blocked) push = "blocked";
  else if (tokens.length === 0) push = "no_device";
  else {
    try {
      const r = await getPushTransport().send(tokens, { messageId: m.id, category: m.category, org: m.org_name, title, body, antiphish: word, signature: m.signature, keyId: m.key_id, sentAt: m.sent_at });
      push = r.ok ? "sent" : "failed:" + (r.error ?? "unknown").slice(0, 40);
    } catch { push = "failed:exception"; }
  }
  const pushOk = push === "sent";
  const always = p.sms_fallback.always_for.includes(m.category); // emergency goes on EVERY channel, SMS included
  let sms: string | undefined;
  if (always || (!pushOk && prefs.sms_ok)) sms = await sendSms(personId, m, lang, word);
  // Email: emergency always (if opted in); other categories only when push did not reach the person.
  let email: string | undefined;
  if (prefs.email_ok && (always || !pushOk)) email = await sendEmail(personId, m, lang, word);
  await st().setChannels(inboxId, push, sms ?? null, email ?? null);
  return { push, sms, email };
}

async function sendSms(personId: string, m: DeliverableMessage, lang: "te" | "en", word: string | null): Promise<string> {
  try {
    const row = await st().phoneRow(personId);
    if (!row?.phone_enc || row.phone_purged_at) return "no_phone";
    const to = getKeys().decrypt("phone", row.phone_enc);
    const vars = { word: (word ?? (lang === "te" ? "పదం లేదు" : "no word set")).slice(0, 30), org: m.org_name.slice(0, 60), text: (lang === "te" ? m.text_te : m.text_en).slice(0, 480) };
    const tid = lang === "te" ? "notify_sms_te" : "notify_sms_en";
    const sms = getSms() as Partial<SmsProviderV2> & { send(to: string, text: string): Promise<void> };
    if (typeof sms.sendTemplated === "function") {
      const r = await sms.sendTemplated(to, tid, vars, { idempotencyKey: getKeys().hmac("sms-idem", `notify:${m.id}:${personId}`) });
      return r.state === "dead" ? "failed" : r.state === "retry" ? "retry" : "sent";
    }
    await sms.send(to, loadTemplateRegistry().render(tid, vars));
    return "sent";
  } catch (e) { return (e as Error).name === "SmsTemplateError" ? "failed:template_unapproved" : "failed"; }
}

/** Job: deliver deferred messages whose quiet hours ended; drop the ones whose message expired. */
export async function processDeferred(t: Date = nowFn.now()): Promise<{ delivered: number; expired: number }> {
  const d = st();
  const rows = (await d.deferredDue(t.toISOString())) as unknown as (DeliverableMessage & { id: string; person_id: string; message_id: string })[];
  let delivered = 0, expired = 0;
  for (const r of rows) {
    if (r.expires_at && r.expires_at <= t.toISOString()) { await d.expireInbox(r.id); expired++; continue; }
    await d.deliverDeferred(r.id, t.toISOString());
    await dispatch(r.id, r.person_id, { ...r, id: r.message_id } as DeliverableMessage, await getPrefs(r.person_id));
    delivered++;
  }
  return { delivered, expired };
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export async function inbox(personId: string, limit = 50): Promise<Record<string, unknown>[]> {
  const prefs = await getPrefs(personId), word = await getAntiPhish(personId);
  const rows = (await st().inbox(personId, Math.min(Math.max(limit, 1), 200))) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    id: r.id, message_id: r.message_id, category: r.category, sender: { org_id: r.org_id, name: r.org_name },
    title: prefs.language === "te" ? r.title_te : r.title_en, text: prefs.language === "te" ? r.text_te : r.text_en,
    title_en: r.title_en, title_te: r.title_te, text_en: r.text_en, text_te: r.text_te,
    sent_at: r.sent_at, delivered_at: r.delivered_at, read_at: r.read_at, read: !!r.read_at,
    antiphish_word: word, signature: r.signature, key_id: r.key_id, signed_payload: r.signed_payload,
    channels: { push: r.push_status, sms: r.sms_status, email: r.email_status },
  }));
}
export const markRead = (personId: string, inboxId: string): Promise<boolean> => st().markRead(personId, inboxId, nowFn.now().toISOString());
