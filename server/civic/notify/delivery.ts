/**
 * Recipient side (S-38): preferences, quiet hours, caps, anti-phishing word, push transport (dev only), SMS fallback, inbox and receipts.
 * There is NO real push provider (FCM/APNs): PushTransport is an interface; the dev transport keeps an in-memory outbox and, in production,
 * reports "no_push_provider" so the SMS fallback applies and the inbox stays the in-app channel.
 */
import crypto from "node:crypto";
import { audit, getDb, getKeys, getSms } from "../core";
import { getMail } from "../providers/mail";
import type { SmsProviderV2 } from "../providers/sms";
import { loadTemplateRegistry } from "../providers/sms";
import { notifyPolicy } from "./content";

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
interface PersonRow { quiet_start: string | null; quiet_end: string | null; antiphish_enc: string | null; language: string; sms_ok: number; email_ok: number; push_blocked: number }
const personRow = (id: string): PersonRow | undefined => getDb().prepare("SELECT quiet_start, quiet_end, antiphish_enc, language, sms_ok, email_ok, push_blocked FROM notify_person WHERE person_id = ?").get(id) as unknown as PersonRow | undefined;

export function getPrefs(personId: string): Prefs {
  const p = notifyPolicy(), row = personRow(personId);
  const stored = new Map((getDb().prepare("SELECT category, opted_in FROM notify_prefs WHERE person_id = ?").all(personId) as { category: string; opted_in: number }[]).map((r) => [r.category, !!r.opted_in]));
  const categories: Prefs["categories"] = {};
  for (const c of p.categories) categories[c] = c === "emergency" ? { opted_in: true, locked: true } : { opted_in: stored.get(c) ?? false, locked: false };
  return {
    categories,
    quiet_hours: { start: row?.quiet_start ?? p.quiet_hours.default_start, end: row?.quiet_end ?? p.quiet_hours.default_end, default: !row?.quiet_start },
    language: row?.language === "en" ? "en" : "te", sms_ok: !!row?.sms_ok, email_ok: !!row?.email_ok, has_email: hasEmail(personId), push_blocked: !!row?.push_blocked, antiphish_set: !!row?.antiphish_enc,
  };
}

export class PrefError extends Error { constructor(public code: string, m: string) { super(m); } }
function ensurePerson(personId: string): void {
  getDb().prepare("INSERT OR IGNORE INTO notify_person (person_id, language, updated_at) VALUES (?, 'te', ?)").run(personId, nowFn.now().toISOString());
}

export function updatePrefs(personId: string, body: Record<string, unknown>): Prefs {
  const p = notifyPolicy(), d = getDb(), ts = nowFn.now().toISOString();
  ensurePerson(personId);
  const cats = body.categories;
  if (cats !== undefined) {
    if (!cats || typeof cats !== "object") throw new PrefError("bad_categories", "categories must be an object of category: boolean");
    for (const [c, v] of Object.entries(cats as Record<string, unknown>)) {
      if (!p.categories.includes(c)) throw new PrefError("unknown_category", "unknown category");
      if (typeof v !== "boolean") throw new PrefError("bad_categories", "category values must be true or false");
      if (c === "emergency") { if (v === false) throw new PrefError("emergency_locked", "emergency notices cannot be switched off"); continue; }
      d.prepare("INSERT INTO notify_prefs (person_id, category, opted_in, updated_at) VALUES (?,?,?,?) ON CONFLICT(person_id, category) DO UPDATE SET opted_in = excluded.opted_in, updated_at = excluded.updated_at").run(personId, c, v ? 1 : 0, ts);
    }
  }
  const q = body.quiet_hours as { start?: unknown; end?: unknown } | undefined;
  if (q !== undefined) {
    if (!q || typeof q.start !== "string" || typeof q.end !== "string" || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) throw new PrefError("bad_quiet_hours", "quiet_hours needs start and end as HH:MM (IST), different from each other");
    d.prepare("UPDATE notify_person SET quiet_start = ?, quiet_end = ? WHERE person_id = ?").run(q.start, q.end, personId);
  }
  if (body.language !== undefined) { if (body.language !== "te" && body.language !== "en") throw new PrefError("bad_language", "language must be te or en"); d.prepare("UPDATE notify_person SET language = ? WHERE person_id = ?").run(body.language, personId); }
  if (body.sms_ok !== undefined) { if (typeof body.sms_ok !== "boolean") throw new PrefError("bad_sms_ok", "sms_ok must be true or false"); d.prepare("UPDATE notify_person SET sms_ok = ? WHERE person_id = ?").run(body.sms_ok ? 1 : 0, personId); }
  if (body.email_ok !== undefined) {
    if (typeof body.email_ok !== "boolean") throw new PrefError("bad_email_ok", "email_ok must be true or false");
    if (body.email_ok && !hasEmail(personId)) throw new PrefError("no_email", "this account has no email address on it");
    d.prepare("UPDATE notify_person SET email_ok = ? WHERE person_id = ?").run(body.email_ok ? 1 : 0, personId);
  }
  if (body.push_blocked !== undefined) { if (typeof body.push_blocked !== "boolean") throw new PrefError("bad_push_blocked", "push_blocked must be true or false"); d.prepare("UPDATE notify_person SET push_blocked = ? WHERE person_id = ?").run(body.push_blocked ? 1 : 0, personId); }
  d.prepare("UPDATE notify_person SET updated_at = ? WHERE person_id = ?").run(ts, personId);
  audit(personId, "notify.prefs.update", "person:" + personId, {});
  return getPrefs(personId);
}

/** Unsubscribe: every non-emergency category off. Emergency notices stay (see docs/NOTIFICATIONS.md). */
export function unsubscribeAll(personId: string): Prefs {
  const cats: Record<string, boolean> = {};
  for (const c of notifyPolicy().categories) if (c !== "emergency") cats[c] = false;
  return updatePrefs(personId, { categories: cats });
}

export function setAntiPhish(personId: string, word: unknown): void {
  const p = notifyPolicy();
  const w = typeof word === "string" ? word.normalize("NFKC").trim() : "";
  if (w.length < p.limits.antiphish_min || w.length > p.limits.antiphish_max) throw new PrefError("bad_word", `the word or phrase must be ${p.limits.antiphish_min} to ${p.limits.antiphish_max} characters`);
  if (/[<>{}\\]|https?:|www\.|@|\d{4,}/i.test(w)) throw new PrefError("bad_word", "the word or phrase cannot contain links, symbols or long numbers");
  ensurePerson(personId);
  getDb().prepare("UPDATE notify_person SET antiphish_enc = ?, updated_at = ? WHERE person_id = ?").run(getKeys().encrypt("notify-antiphish", w), nowFn.now().toISOString(), personId);
  audit(personId, "notify.antiphish.set", "person:" + personId, {});
}
export function getAntiPhish(personId: string): string | null {
  const r = personRow(personId);
  if (!r?.antiphish_enc) return null;
  try { return getKeys().decrypt("notify-antiphish", r.antiphish_enc); } catch { return null; }
}

export function registerDevice(personId: string, token: unknown, platform: unknown): void {
  if (typeof token !== "string" || token.length < 8 || token.length > 4096) throw new PrefError("bad_token", "token missing or malformed");
  const pf = platform === "ios" || platform === "web" ? platform : "android";
  const k = getKeys();
  getDb().prepare("INSERT OR REPLACE INTO notify_devices (token_hash, person_id, token_enc, platform, created_at) VALUES (?,?,?,?,?)")
    .run(k.hmac("notify-device", token), personId, k.encrypt("notify-device", token), pf, nowFn.now().toISOString());
}
/** The caller's own registered devices for the settings screen. The token (and its hash) is never returned: `id` is a short reference only. */
export function listDevices(personId: string): { id: string; platform: string; label_en: string; label_te: string; created_at: string }[] {
  const names: Record<string, [string, string]> = { android: ["Android phone", "ఆండ్రాయిడ్ ఫోన్"], ios: ["iPhone or iPad", "ఐఫోన్ లేదా ఐప్యాడ్"], web: ["Web browser", "వెబ్ బ్రౌజర్"] };
  const rows = getDb().prepare("SELECT token_hash, platform, created_at FROM notify_devices WHERE person_id = ? ORDER BY created_at").all(personId) as { token_hash: string; platform: string; created_at: string }[];
  return rows.map((r) => { const n = names[r.platform] ?? names.android; return { id: r.token_hash.slice(0, 12), platform: r.platform, label_en: n[0], label_te: n[1], created_at: r.created_at }; });
}
export function removeDevices(personId: string): void { getDb().prepare("DELETE FROM notify_devices WHERE person_id = ?").run(personId); }
function deviceTokens(personId: string): string[] {
  return (getDb().prepare("SELECT token_enc FROM notify_devices WHERE person_id = ?").all(personId) as { token_enc: string }[]).flatMap((r) => { try { return [getKeys().decrypt("notify-device", r.token_enc)]; } catch { return []; } });
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

function capReached(personId: string, category: string, t: Date): "daily" | "weekly" | null {
  const cap = notifyPolicy().caps[category];
  if (!cap) return null;
  const q = (since: number) => (getDb().prepare("SELECT COUNT(*) AS c FROM notify_inbox WHERE person_id = ? AND category = ? AND created_at >= ?").get(personId, category, new Date(since).toISOString()) as { c: number }).c;
  const day = istDayStart(t);
  if (q(day) >= cap.daily) return "daily";
  if (q(day - 6 * 86_400_000) >= cap.weekly) return "weekly";
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
  const prefs = getPrefs(personId);
  const emergency = m.category === "emergency";
  if (!emergency && !prefs.categories[m.category]?.opted_in) return { result: "skipped", skip: "opted_out" };
  const cap = capReached(personId, m.category, t);
  if (cap) return { result: "skipped", skip: cap === "daily" ? "daily_cap" : "weekly_cap" };
  const id = crypto.randomUUID(), ts = t.toISOString();
  const bypass = p.quiet_hours.bypass.includes(m.category);
  if (!bypass && inQuiet(prefs.quiet_hours.start, prefs.quiet_hours.end, t)) {
    const after = quietEndsAt(prefs.quiet_hours.end, t);
    if (!m.expires_at || after.toISOString() < m.expires_at) {
      getDb().prepare("INSERT INTO notify_inbox (id, person_id, message_id, category, status, deliver_after, created_at) VALUES (?,?,?,?, 'deferred', ?, ?)").run(id, personId, m.id, m.category, after.toISOString(), ts);
      return { result: "deferred" };
    }
    return { result: "skipped", skip: "none" };
  }
  getDb().prepare("INSERT INTO notify_inbox (id, person_id, message_id, category, status, created_at, delivered_at) VALUES (?,?,?,?, 'delivered', ?, ?)").run(id, personId, m.id, m.category, ts, ts);
  const ch = await dispatch(id, personId, m, prefs);
  return { result: "delivered", ...ch };
}

function hasEmail(personId: string): boolean {
  const r = getDb().prepare("SELECT email_enc FROM persons WHERE id = ? AND deleted_at IS NULL").get(personId) as { email_enc: string | null } | undefined;
  return !!r?.email_enc;
}

/**
 * Email channel (S-184). Only for a person who switched it on (`email_ok`); never otherwise, emergency included, because holding and using
 * an email contact needs the person's own consent. The body carries the sender, the anti-phishing word and the signature reference, and no links.
 */
async function sendEmail(personId: string, m: DeliverableMessage, lang: "te" | "en", word: string | null): Promise<string> {
  try {
    const row = getDb().prepare("SELECT email_enc FROM persons WHERE id = ? AND deleted_at IS NULL").get(personId) as { email_enc: string | null } | undefined;
    if (!row?.email_enc) return "no_email";
    const to = getKeys().decrypt("phone", row.email_enc).replace(/^email:/, ""); // stored as "email:<canonical address>" (identity/email.ts emailKey)
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
  const lang = prefs.language, word = getAntiPhish(personId);
  const title = lang === "te" ? m.title_te : m.title_en, body = lang === "te" ? m.text_te : m.text_en;
  let push: string;
  const tokens = prefs.push_blocked ? [] : deviceTokens(personId);
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
  getDb().prepare("UPDATE notify_inbox SET push_status = ?, sms_status = ?, email_status = ? WHERE id = ?").run(push, sms ?? null, email ?? null, inboxId);
  return { push, sms, email };
}

async function sendSms(personId: string, m: DeliverableMessage, lang: "te" | "en", word: string | null): Promise<string> {
  try {
    const row = getDb().prepare("SELECT phone_enc, phone_purged_at FROM persons WHERE id = ? AND deleted_at IS NULL").get(personId) as { phone_enc: string | null; phone_purged_at: string | null } | undefined;
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
  const d = getDb();
  const rows = d.prepare(`SELECT i.id, i.person_id, i.message_id, m.org_id, m.category, m.title_en, m.title_te, m.text_en, m.text_te, m.signature, m.key_id, m.sent_at, m.expires_at, o.name AS org_name
      FROM notify_inbox i JOIN notify_messages m ON m.id = i.message_id JOIN notify_orgs o ON o.id = m.org_id WHERE i.status = 'deferred' AND i.deliver_after <= ? LIMIT 500`).all(t.toISOString()) as unknown as (DeliverableMessage & { id: string; person_id: string; message_id: string })[];
  let delivered = 0, expired = 0;
  for (const r of rows) {
    if (r.expires_at && r.expires_at <= t.toISOString()) { d.prepare("UPDATE notify_inbox SET status = 'expired' WHERE id = ?").run(r.id); expired++; continue; }
    d.prepare("UPDATE notify_inbox SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'deferred'").run(t.toISOString(), r.id);
    await dispatch(r.id, r.person_id, { ...r, id: r.message_id } as DeliverableMessage, getPrefs(r.person_id));
    delivered++;
  }
  return { delivered, expired };
}

// ---------------------------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------------------------

export function inbox(personId: string, limit = 50): Record<string, unknown>[] {
  const prefs = getPrefs(personId), word = getAntiPhish(personId);
  const rows = getDb().prepare(`SELECT i.id, i.message_id, i.category, i.delivered_at, i.read_at, i.push_status, i.sms_status, i.email_status, m.title_en, m.title_te, m.text_en, m.text_te, m.signature, m.key_id, m.sent_at, m.signed_payload, o.id AS org_id, o.name AS org_name
      FROM notify_inbox i JOIN notify_messages m ON m.id = i.message_id JOIN notify_orgs o ON o.id = m.org_id
      WHERE i.person_id = ? AND i.status = 'delivered' ORDER BY i.delivered_at DESC LIMIT ?`).all(personId, Math.min(Math.max(limit, 1), 200)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    id: r.id, message_id: r.message_id, category: r.category, sender: { org_id: r.org_id, name: r.org_name },
    title: prefs.language === "te" ? r.title_te : r.title_en, text: prefs.language === "te" ? r.text_te : r.text_en,
    title_en: r.title_en, title_te: r.title_te, text_en: r.text_en, text_te: r.text_te,
    sent_at: r.sent_at, delivered_at: r.delivered_at, read_at: r.read_at, read: !!r.read_at,
    antiphish_word: word, signature: r.signature, key_id: r.key_id, signed_payload: r.signed_payload,
    channels: { push: r.push_status, sms: r.sms_status, email: r.email_status },
  }));
}
export function markRead(personId: string, inboxId: string): boolean {
  const r = getDb().prepare("UPDATE notify_inbox SET read_at = COALESCE(read_at, ?) WHERE id = ? AND person_id = ? AND status = 'delivered'").run(nowFn.now().toISOString(), inboxId, personId);
  return Number(r.changes) > 0;
}
