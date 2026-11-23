/**
 * Sender side (S-37, S-39): verified organisations, bound sender users with FIDO2 credentials, two-person approval, MCC gate,
 * signing, kill-switch, public block log, fan-out. Dual-control admin steps reuse the admin pattern (TOTP + a different admin).
 */
import crypto from "node:crypto";
import { audit, canonicalJson, getDb, getKeys, hasRole, listRolesDetailed } from "../core";
import { E164_IN, personsOnPhone } from "../identity/service";
import { findTemplate, lintContent, mccGate, notifyPolicy, notifyWindow, renderTemplate, type Declaration } from "./content";
import { deliverTo, nowFn, type DeliverableMessage } from "./delivery";
import { signPayload } from "./sign";
import { assertionChallenge, b64u, verifyAssertion, verifyRegistration, webauthnConfig, WebAuthnError, type AssertionInput, type RegistrationInput } from "./webauthn";

export class NotifyError extends Error { constructor(public status: number, public code: string, m?: string, public extra: Record<string, unknown> = {}) { super(m ?? code); } }
const E = (status: number, code: string, m?: string, extra?: Record<string, unknown>): never => { throw new NotifyError(status, code, m, extra); };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q1 = (sql: string, ...a: unknown[]): Row | undefined => getDb().prepare(sql).get(...(a as never[])) as Row | undefined;
const qa = (sql: string, ...a: unknown[]): Row[] => getDb().prepare(sql).all(...(a as never[])) as Row[];
const run = (sql: string, ...a: unknown[]) => getDb().prepare(sql).run(...(a as never[]));
const iso = () => nowFn.now().toISOString();

// ---------------------------------------------------------------------------------------------
// Organisations and sender users (dual control)
// ---------------------------------------------------------------------------------------------

export function requestOrg(admin: string, b: Row): { id: string } {
  const p = notifyPolicy();
  const name = String(b.name ?? "").trim(), kind = String(b.kind ?? ""), letter = String(b.letter_ref ?? "").trim(), domain = String(b.email_domain ?? "").trim().toLowerCase(), contact = String(b.contact ?? "").trim();
  if (name.length < 3 || name.length > 120) E(400, "bad_name", "name must be 3 to 120 characters");
  if (!p.org_kinds[kind]) E(400, "bad_kind", "unknown organisation kind", { kinds: Object.keys(p.org_kinds) });
  if (letter.length < 3 || letter.length > 120) E(400, "letter_ref_required", "official letter reference is required");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) E(400, "bad_email_domain", "official email domain looks malformed");
  if (!p.allowed_link_domains.some((d) => domain === d || domain.endsWith("." + d))) E(400, "email_domain_not_government", "email domain is not on the government domain list (gov.in, nic.in)");
  if (contact.length < 5 || contact.length > 200) E(400, "contact_required", "contact is required");
  const id = crypto.randomUUID();
  run("INSERT INTO notify_orgs (id, name, kind, letter_ref, email_domain, contact, status, requested_by, created_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?)", id, name, kind, letter, domain, contact, admin, iso());
  audit(admin, "notify.org.request", "notify_org:" + id, { kind });
  return { id };
}
export function decideOrg(admin: string, id: string, approve: boolean): Row {
  const o = q1("SELECT * FROM notify_orgs WHERE id = ?", id);
  if (!o) E(404, "org_not_found");
  if (o!.status !== "pending") E(409, "already_decided", `organisation already ${o!.status}`);
  if (o!.requested_by === admin) { audit(admin, "notify.org.self_approval_refused", "notify_org:" + id, {}); E(403, "dual_control", "a different admin must decide this organisation"); }
  run("UPDATE notify_orgs SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", approve ? "verified" : "rejected", admin, iso(), id);
  audit(admin, approve ? "notify.org.verify" : "notify.org.reject", "notify_org:" + id, { requested_by: o!.requested_by });
  return { id, status: approve ? "verified" : "rejected" };
}
export const listOrgs = (status?: string): Row[] => qa(`SELECT id, name, kind, letter_ref, email_domain, contact, status, requested_by, created_at, decided_by, decided_at FROM notify_orgs ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`, ...(status ? [status] : []));

export function requestSender(admin: string, b: Row): { id: string } {
  const p = notifyPolicy();
  const orgId = String(b.org_id ?? ""), personId = String(b.person_id ?? ""), role = String(b.role ?? "");
  const org = q1("SELECT * FROM notify_orgs WHERE id = ?", orgId);
  if (!org) E(404, "org_not_found");
  if (org!.status !== "verified") E(409, "org_not_verified", "the organisation is not verified yet");
  if (!p.sender_roles.includes(role) || !p.org_kinds[org!.kind].sender_roles.includes(role)) E(400, "bad_role", "role not allowed for this kind of organisation", { roles: p.org_kinds[org!.kind].sender_roles });
  if (!q1("SELECT 1 AS x FROM persons WHERE id = ? AND deleted_at IS NULL", personId)) E(404, "person_not_found");
  if (personId === admin) E(403, "self_grant", "an admin cannot make themselves a sender");
  if (q1("SELECT 1 AS x FROM notify_senders WHERE org_id = ? AND person_id = ? AND status IN ('pending','active')", orgId, personId)) E(409, "duplicate", "already a sender or pending");
  const id = crypto.randomUUID();
  run("INSERT INTO notify_senders (id, org_id, person_id, role, status, requested_by, created_at) VALUES (?,?,?,?, 'pending', ?, ?)", id, orgId, personId, role, admin, iso());
  audit(admin, "notify.sender.request", "person:" + personId, { org: orgId, role });
  return { id };
}
export function decideSender(admin: string, id: string, approve: boolean): Row {
  const s = q1("SELECT * FROM notify_senders WHERE id = ?", id);
  if (!s) E(404, "sender_not_found");
  if (s!.status !== "pending") E(409, "already_decided", `sender already ${s!.status}`);
  if (s!.requested_by === admin) { audit(admin, "notify.sender.self_approval_refused", "notify_sender:" + id, {}); E(403, "dual_control", "a different admin must decide this sender"); }
  if (s!.person_id === admin) E(403, "self_grant", "an admin cannot approve themselves as a sender");
  run("UPDATE notify_senders SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", approve ? "active" : "rejected", admin, iso(), id);
  audit(admin, approve ? "notify.sender.approve" : "notify.sender.reject", "person:" + s!.person_id, { org: s!.org_id, requested_by: s!.requested_by });
  return { id, status: approve ? "active" : "rejected" };
}
export function revokeSender(admin: string, id: string): Row {
  const s = q1("SELECT * FROM notify_senders WHERE id = ?", id);
  if (!s) E(404, "sender_not_found");
  run("UPDATE notify_senders SET status = 'revoked', decided_by = ?, decided_at = ? WHERE id = ?", admin, iso(), id);
  audit(admin, "notify.sender.revoke", "person:" + s!.person_id, { org: s!.org_id });
  return { id, status: "revoked" };
}
export function revokeCredential(admin: string, credId: string): Row {
  const r = run("UPDATE notify_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", iso(), credId);
  if (!Number(r.changes)) E(404, "credential_not_found");
  audit(admin, "notify.credential.revoke", "notify_credential:" + credId.slice(0, 16), {});
  return { ok: true };
}
export const listSenders = (status?: string): Row[] => qa(`SELECT s.id, s.org_id, o.name AS org_name, s.person_id, s.role, s.status, s.requested_by, s.created_at, s.decided_by, s.decided_at,
    (SELECT COUNT(*) FROM notify_credentials c WHERE c.person_id = s.person_id AND c.revoked_at IS NULL) AS credentials
    FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id ${status ? "WHERE s.status = ?" : ""} ORDER BY s.created_at DESC LIMIT 200`, ...(status ? [status] : []));

export function senderMe(personId: string): Row {
  const rows = qa(`SELECT s.id, s.role, s.status, o.id AS org_id, o.name AS org_name, o.kind, o.status AS org_status FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ? ORDER BY s.created_at`, personId);
  const creds = qa("SELECT id, created_at, last_used_at, alg FROM notify_credentials WHERE person_id = ? AND revoked_at IS NULL", personId);
  return { person_id: personId, senders: rows.map((r) => ({ sender_id: r.id, role: r.role, status: r.status, org: { id: r.org_id, name: r.org_name, kind: r.kind, status: r.org_status } })), credentials: creds, can_send: rows.some((r) => r.status === "active" && r.org_status === "verified") && creds.length > 0 };
}

// ---------------------------------------------------------------------------------------------
// Kill switch (engage: one admin + TOTP, instant. Release: dual control)
// ---------------------------------------------------------------------------------------------

export function engageKill(admin: string, b: Row): Row {
  const scope = b.scope === "org" ? "org" : b.scope === "all" ? "all" : E(400, "bad_scope", "scope must be all or org") as never;
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5 || reason.length > 300) E(400, "reason_required", "reason (5 to 300 characters) is required");
  let orgId: string | null = null;
  if (scope === "org") { orgId = String(b.org_id ?? ""); if (!q1("SELECT 1 AS x FROM notify_orgs WHERE id = ?", orgId)) E(404, "org_not_found"); }
  if (q1("SELECT 1 AS x FROM notify_kill WHERE released_at IS NULL AND scope = ? AND COALESCE(org_id,'') = ?", scope, orgId ?? "")) E(409, "already_engaged");
  const id = crypto.randomUUID();
  run("INSERT INTO notify_kill (id, scope, org_id, reason, engaged_by, engaged_at) VALUES (?,?,?,?,?,?)", id, scope, orgId, reason, admin, iso());
  audit(admin, "notify.kill.engage", "notify_kill:" + id, { scope, org: orgId });
  return { id, scope, org_id: orgId };
}
export function requestRelease(admin: string, id: string): Row {
  const k = q1("SELECT * FROM notify_kill WHERE id = ?", id);
  if (!k) E(404, "kill_not_found");
  if (k!.released_at) E(409, "already_released");
  run("UPDATE notify_kill SET release_requested_by = ?, release_requested_at = ? WHERE id = ?", admin, iso(), id);
  audit(admin, "notify.kill.release_request", "notify_kill:" + id, {});
  return { id, release_requested_by: admin };
}
export function approveRelease(admin: string, id: string): Row {
  const k = q1("SELECT * FROM notify_kill WHERE id = ?", id);
  if (!k) E(404, "kill_not_found");
  if (k!.released_at) E(409, "already_released");
  if (!k!.release_requested_by) E(409, "release_not_requested", "a release must be requested first");
  if (k!.release_requested_by === admin) { audit(admin, "notify.kill.self_release_refused", "notify_kill:" + id, {}); E(403, "dual_control", "a different admin must approve the release"); }
  run("UPDATE notify_kill SET released_by = ?, released_at = ? WHERE id = ?", admin, iso(), id);
  audit(admin, "notify.kill.release", "notify_kill:" + id, { requested_by: k!.release_requested_by });
  return { id, released: true };
}
export const listKills = (): Row[] => qa("SELECT * FROM notify_kill ORDER BY engaged_at DESC LIMIT 100");
export function killedFor(orgId: string): "all" | "org" | null {
  const r = qa("SELECT scope, org_id FROM notify_kill WHERE released_at IS NULL");
  if (r.some((x) => x.scope === "all")) return "all";
  return r.some((x) => x.scope === "org" && x.org_id === orgId) ? "org" : null;
}

// ---------------------------------------------------------------------------------------------
// WebAuthn state
// ---------------------------------------------------------------------------------------------

function newChallenge(personId: string, kind: "register" | "assert", purpose: string, messageId: string | null, msgHash: string | null): string {
  const ttl = notifyPolicy().webauthn.challenge_ttl_s * 1000;
  const nonce = b64u(crypto.randomBytes(32));
  const challenge = kind === "register" ? nonce : assertionChallenge(purpose, messageId!, msgHash!, nonce);
  run("INSERT INTO notify_challenges (challenge, person_id, kind, purpose, message_id, msg_hash, expires_at) VALUES (?,?,?,?,?,?,?)", challenge, personId, kind, purpose, messageId, msgHash, nowFn.now().getTime() + ttl);
  run("DELETE FROM notify_challenges WHERE expires_at < ?", nowFn.now().getTime() - 3_600_000);
  return challenge;
}
/** Consume a challenge exactly once; returns its row. */
function takeChallenge(challenge: string, personId: string, kind: string, purpose: string, messageId: string | null): Row {
  const row = q1("SELECT * FROM notify_challenges WHERE challenge = ?", challenge);
  if (!row || row.person_id !== personId || row.kind !== kind || row.purpose !== purpose || (row.message_id ?? null) !== messageId) return E(403, "challenge_invalid", "unknown challenge");
  if (row.expires_at < nowFn.now().getTime()) return E(403, "challenge_expired", "challenge expired; request a new one");
  const r = run("UPDATE notify_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL", nowFn.now().getTime(), challenge);
  if (!Number(r.changes)) return E(403, "challenge_reused", "challenge already used");
  return row;
}
const clientChallenge = (cdj: unknown): string => { try { return String(JSON.parse(Buffer.from(String(cdj), "base64url").toString("utf8")).challenge ?? ""); } catch { return ""; } };
const wa = (e: unknown): never => { if (e instanceof WebAuthnError) throw new NotifyError(403, "webauthn_" + e.code, "security key check failed: " + e.code); throw e; };

function activeSender(personId: string, orgId?: string): Row | undefined {
  return q1(`SELECT s.*, o.name AS org_name, o.kind AS org_kind, o.status AS org_status FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id
              WHERE s.person_id = ? AND s.status = 'active' ${orgId ? "AND s.org_id = ?" : ""} ORDER BY s.created_at LIMIT 1`, personId, ...(orgId ? [orgId] : []));
}

export function registrationOptions(personId: string): Row {
  if (!activeSender(personId)) E(403, "not_a_sender", "you are not an approved sender");
  const cfg = webauthnConfig();
  const challenge = newChallenge(personId, "register", "register", null, null);
  const existing = qa("SELECT id FROM notify_credentials WHERE person_id = ? AND revoked_at IS NULL", personId);
  return {
    challenge, rp: { id: cfg.rpId, name: cfg.rpName }, user: { id: b64u(Buffer.from(personId)), name: "sender-" + personId.slice(0, 8), displayName: "Notification sender" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }], attestation: "none", timeout: 120000,
    authenticatorSelection: { authenticatorAttachment: "cross-platform", residentKey: "discouraged", userVerification: "required" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
  };
}
export function finishRegistration(personId: string, body: RegistrationInput): Row {
  if (!activeSender(personId)) E(403, "not_a_sender", "you are not an approved sender");
  takeChallenge(clientChallenge(body?.response?.clientDataJSON), personId, "register", "register", null);
  let v;
  try { v = verifyRegistration(body, clientChallenge(body.response.clientDataJSON), { requireUv: notifyPolicy().webauthn.require_user_verification }); } catch (e) { return wa(e); }
  if (q1("SELECT 1 AS x FROM notify_credentials WHERE id = ?", v.credentialId)) E(409, "credential_exists");
  run("INSERT INTO notify_credentials (id, person_id, spki, alg, sign_count, aaguid, created_at) VALUES (?,?,?,?,?,?,?)", v.credentialId, personId, v.spki, v.alg, v.counter, v.aaguid, iso());
  audit(personId, "notify.credential.register", "person:" + personId, { alg: v.alg });
  return { credential_id: v.credentialId, alg: v.alg };
}
function credentialsOf(personId: string): Row[] { return qa("SELECT id, spki, alg, sign_count FROM notify_credentials WHERE person_id = ? AND revoked_at IS NULL", personId); }

export function assertionOptions(personId: string, messageId: string, purpose: string): Row {
  if (purpose !== "approve" && purpose !== "send") E(400, "bad_purpose", "purpose must be approve or send");
  const m = q1("SELECT id, msg_hash, org_id, status FROM notify_messages WHERE id = ?", messageId);
  if (!m || !activeSender(personId, m.org_id)) return E(404, "message_not_found");
  const creds = credentialsOf(personId);
  if (!creds.length) E(403, "fido2_required", "register a security key first");
  const challenge = newChallenge(personId, "assert", purpose, messageId, m.msg_hash);
  return { challenge, rpId: webauthnConfig().rpId, timeout: 120000, userVerification: "required", allowCredentials: creds.map((c) => ({ type: "public-key", id: c.id })), message_hash: m.msg_hash };
}
/** Verifies a fresh assertion whose challenge is bound to (purpose, message id, CURRENT message hash). Returns the credential id. */
function requireAssertion(personId: string, m: Row, purpose: string, a: AssertionInput): string {
  if (!a || typeof a !== "object") E(403, "assertion_required", "a security key assertion bound to this message is required");
  const ch = clientChallenge(a.response?.clientDataJSON);
  const row = takeChallenge(ch, personId, "assert", purpose, m.id);
  if (row.msg_hash !== m.msg_hash) E(409, "message_changed", "the message changed after the challenge was issued");
  const cred = credentialsOf(personId).find((c) => c.id === a.id);
  if (!cred) E(403, "credential_unknown", "that security key is not registered to you");
  try {
    const r = verifyAssertion(a, { id: cred!.id, spki: cred!.spki, alg: cred!.alg, counter: cred!.sign_count }, ch, { requireUv: notifyPolicy().webauthn.require_user_verification });
    run("UPDATE notify_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?", r.counter, iso(), cred!.id);
  } catch (e) { return wa(e); }
  return cred!.id;
}

// ---------------------------------------------------------------------------------------------
// Block log (public: time bucket, org, category, reason code, no content)
// ---------------------------------------------------------------------------------------------

export function logBlock(orgId: string | null, orgName: string, category: string, reason: string): void {
  const bucket = new Date(Math.floor(nowFn.now().getTime() / 3_600_000) * 3_600_000).toISOString();
  run("INSERT INTO notify_block_log (bucket, org_id, org_name, category, reason) VALUES (?,?,?,?,?)", bucket, orgId, orgName, category, reason);
  audit("system", "notify.blocked", "notify_org:" + (orgId ?? "none"), { category, reason });
}
export const publicBlockLog = (limit = 200, before?: number): Row[] =>
  qa("SELECT id, bucket AS time_bucket, org_name AS sender_org, category, reason AS reason_code FROM notify_block_log WHERE id < ? ORDER BY id DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(limit, 1), 500));

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

const TARGET_KEYS = ["state", "district", "units", "all_in_state"];
function validateTarget(t: unknown): { state: string; district: string | null; units: string[]; all_in_state: boolean } {
  if (!t || typeof t !== "object" || Array.isArray(t)) return E(400, "bad_target", "target must be an object with a state");
  const extra = Object.keys(t as object).filter((k) => !TARGET_KEYS.includes(k));
  if (extra.length) E(400, "target_not_geographic", "targeting is by geography only (state, district, units)", { rejected: extra });
  const o = t as Row;
  const state = String(o.state ?? "").toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(state)) E(400, "bad_target", "state code required (e.g. AP)");
  const units = Array.isArray(o.units) ? o.units.map(String) : [];
  if (units.some((u) => !/^[A-Za-z0-9_.-]{1,40}$/.test(u)) || units.length > 5000) E(400, "bad_target", "units must be unit codes");
  const all = o.all_in_state === true;
  if (!all && !units.length) E(400, "bad_target", "give units or all_in_state");
  return { state, district: o.district ? String(o.district).slice(0, 40) : null, units, all_in_state: all };
}

export function messageHash(m: { org_id: string; category: string; target: unknown; title_en: string; title_te: string; text_en: string; text_te: string; template_id: string | null; slots: unknown; declaration: unknown }): string {
  return crypto.createHash("sha256").update(canonicalJson(m)).digest("hex");
}

function senderGate(personId: string, orgId: string | null, category: string | null): Row {
  const s = activeSender(personId, orgId ?? undefined);
  const pending = q1("SELECT s.status AS s, o.status AS o FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ?", personId);
  if (!s) return E(403, "sender_unverified", pending ? "your sender binding is not active" : "you are not a registered sender");
  if (s.org_status !== "verified") E(403, "sender_unverified", "organisation is not verified");
  const k = killedFor(s.org_id);
  if (k) { logBlock(s.org_id, s.org_name, category ?? "other", "kill_switch"); E(423, "kill_switch", k === "all" ? "all sending is suspended" : "this sender is suspended"); }
  if (!credentialsOf(personId).length) E(403, "fido2_required", "register a FIDO2 security key before sending");
  if (s.role === "eci_liaison" && !hasRole(personId, "eci_liaison")) E(403, "sender_unverified", "election commission liaison role missing");
  return s;
}

export function createMessage(personId: string, b: Row): Row {
  const p = notifyPolicy();
  const s = senderGate(personId, b.org_id ? String(b.org_id) : null, b.category ? String(b.category) : null);
  const category = String(b.category ?? "");
  if (!p.categories.includes(category)) E(400, "bad_category", "unknown category", { categories: p.categories });
  if (!p.org_kinds[s.org_kind].categories.includes(category)) { logBlock(s.org_id, s.org_name, category, "category_not_allowed"); E(403, "category_not_allowed", category === "election_info" ? "election information may only be sent through the Election Commission liaison" : "this organisation cannot send this category"); }
  if (category === "election_info" && s.role !== "eci_liaison") E(403, "category_not_allowed", "election information may only be sent through the Election Commission liaison");
  const target = validateTarget(b.target);
  const templateId = b.template_id ? String(b.template_id) : null;
  let en = String(b.text_en ?? "").trim(), te = String(b.text_te ?? "").trim(), slots: Record<string, string> | null = null;
  if (templateId) {
    const t = findTemplate(templateId);
    if (!t || t.category !== category) E(400, "template_unknown", "unknown template for this category");
    if (en || te) E(400, "template_and_text", "give a template or free text, not both");
    const r = renderTemplate(t!, (b.slots ?? {}) as Row);
    if (!r) E(400, "template_slots", "slots missing, unknown or too long");
    en = r!.en; te = r!.te; slots = b.slots as Record<string, string>;
  }
  if (!en || !te) E(400, "text_required", "text in both English and Telugu is required");
  if (en.length > p.limits.text_chars || te.length > p.limits.text_chars) E(400, "text_too_long", `text is limited to ${p.limits.text_chars} characters`);
  const label = p.category_labels[category];
  const titleEn = String(b.title_en ?? label.en).trim().slice(0, p.limits.title_chars), titleTe = String(b.title_te ?? label.te).trim().slice(0, p.limits.title_chars);
  const decl = b.declaration as Declaration | undefined;
  const declaration = decl && typeof decl === "object" ? { accepted: decl.accepted === true, reason: String(decl.reason ?? "").trim().slice(0, 300), checkbox_text_en: p.mcc.declaration.text_en, checkbox_text_te: p.mcc.declaration.text_te } : null;
  const hits = lintContent([en, te, titleEn, titleTe, ...(slots ? Object.values(slots) : [])]);
  if (hits.length) { logBlock(s.org_id, s.org_name, category, "content_policy"); E(422, "content_policy", "message refused: notifications never ask for OTP, PIN, passwords, login, payment or links outside the allow-list", { rules: [...new Set(hits.map((h) => h.rule))] }); }
  const gate = mccGate({ category, state: target.state, district: target.district, templateId, declaration, now: nowFn.now() });
  if (!gate.allowed) { logBlock(s.org_id, s.org_name, category, gate.reason!); E(422, gate.reason!, "blocked by Model Code of Conduct rules", { window: gate.window }); }
  const required = category === "emergency" ? (templateId ? p.approvals.emergency_template : p.approvals.emergency_free_text) : p.approvals.standard;
  const id = crypto.randomUUID();
  const hash = messageHash({ org_id: s.org_id, category, target, title_en: titleEn, title_te: titleTe, text_en: en, text_te: te, template_id: templateId, slots, declaration });
  run(`INSERT INTO notify_messages (id, org_id, created_by, category, state, district, target, title_en, title_te, text_en, text_te, template_id, slots, declaration, msg_hash, approvals_required, status, mcc_window, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_approval', ?, ?)`, id, s.org_id, personId, category, target.state, target.district, JSON.stringify(target), titleEn, titleTe, en, te, templateId, slots ? JSON.stringify(slots) : null, declaration ? JSON.stringify(declaration) : null, hash, required, gate.window, iso());
  audit(personId, "notify.message.create", "notify_message:" + id, { org: s.org_id, category, window: gate.window });
  return { id, status: "pending_approval", msg_hash: hash, approvals_required: required, mcc_window: gate.window };
}

const publicMsg = (m: Row): Row => ({
  id: m.id, org_id: m.org_id, category: m.category, status: m.status, blocked_reason: m.blocked_reason, target: JSON.parse(m.target), title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te,
  template_id: m.template_id, msg_hash: m.msg_hash, approvals_required: m.approvals_required, approvals: (q1("SELECT COUNT(*) AS c FROM notify_approvals WHERE message_id = ?", m.id) as Row).c,
  declaration: m.declaration ? JSON.parse(m.declaration) : null, mcc_window: m.mcc_window, created_by: m.created_by, created_at: m.created_at, sent_at: m.sent_at, stats: m.stats ? JSON.parse(m.stats) : null, signature: m.signature, key_id: m.key_id,
});
export function getMessage(personId: string, id: string): Row {
  const m = q1("SELECT * FROM notify_messages WHERE id = ?", id);
  if (!m || !activeSender(personId, m.org_id)) return E(404, "message_not_found");
  return publicMsg(m);
}
export function listMessages(personId: string): Row[] {
  const orgs = qa("SELECT org_id FROM notify_senders WHERE person_id = ? AND status = 'active'", personId).map((r) => r.org_id);
  if (!orgs.length) return [];
  return qa(`SELECT * FROM notify_messages WHERE org_id IN (${orgs.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 100`, ...orgs).map(publicMsg);
}

export function approveMessage(personId: string, id: string, assertion: AssertionInput): Row {
  const m = q1("SELECT * FROM notify_messages WHERE id = ?", id);
  if (!m) return E(404, "message_not_found");
  const s = senderGate(personId, m.org_id, m.category);
  if (m.status !== "pending_approval") E(409, "bad_state", `message is ${m.status}`);
  if (m.created_by === personId) { audit(personId, "notify.message.self_approval_refused", "notify_message:" + id, {}); E(403, "dual_control", "a different sender must approve this message"); }
  if (q1("SELECT 1 AS x FROM notify_approvals WHERE message_id = ? AND person_id = ?", id, personId)) E(409, "already_approved");
  const cred = requireAssertion(personId, m, "approve", assertion);
  run("INSERT INTO notify_approvals (message_id, person_id, at, credential_id) VALUES (?,?,?,?)", id, personId, iso(), cred);
  const n = (q1("SELECT COUNT(*) AS c FROM notify_approvals WHERE message_id = ?", id) as Row).c as number;
  const done = n >= m.approvals_required;
  if (done) run("UPDATE notify_messages SET status = 'approved', approved_at = ? WHERE id = ?", iso(), id);
  audit(personId, "notify.message.approve", "notify_message:" + id, { org: s.org_id, approvals: n, of: m.approvals_required });
  return { id, status: done ? "approved" : "pending_approval", approvals: n, approvals_required: m.approvals_required };
}

export function cancelMessage(personId: string, id: string): Row {
  const m = q1("SELECT * FROM notify_messages WHERE id = ?", id);
  if (!m || !activeSender(personId, m.org_id)) return E(404, "message_not_found");
  if (!["pending_approval", "approved"].includes(m.status)) E(409, "bad_state", `message is ${m.status}`);
  run("UPDATE notify_messages SET status = 'cancelled' WHERE id = ?", id);
  audit(personId, "notify.message.cancel", "notify_message:" + id, {});
  return { id, status: "cancelled" };
}

function audienceIds(target: { units: string[]; all_in_state: boolean }): string[] {
  if (target.all_in_state) return qa("SELECT id FROM persons WHERE deleted_at IS NULL AND residence_unit IS NOT NULL AND residence_unit <> ''").map((r) => r.id);
  const out: string[] = [];
  for (let i = 0; i < target.units.length; i += 400) {
    const chunk = target.units.slice(i, i + 400);
    out.push(...qa(`SELECT id FROM persons WHERE deleted_at IS NULL AND residence_unit IN (${chunk.map(() => "?").join(",")})`, ...chunk).map((r) => r.id));
  }
  return out;
}

function blockSend(m: Row, org: Row, reason: string, status = 422, extra: Record<string, unknown> = {}): never {
  run("UPDATE notify_messages SET status = 'blocked', blocked_reason = ? WHERE id = ?", reason, m.id);
  logBlock(org.org_id ?? m.org_id, org.org_name, m.category, reason);
  return E(status, reason, "blocked: " + reason, extra);
}

export async function sendMessage(personId: string, id: string, assertion: AssertionInput): Promise<Row> {
  const p = notifyPolicy();
  const m = q1("SELECT * FROM notify_messages WHERE id = ?", id);
  if (!m) return E(404, "message_not_found");
  const s = senderGate(personId, m.org_id, m.category); // kill switch, verified org, FIDO2 present
  if (m.status !== "approved") E(409, m.status === "pending_approval" ? "approval_required" : "bad_state", m.status === "pending_approval" ? "two-person approval is not complete" : `message is ${m.status}`);
  const approvers = qa("SELECT person_id FROM notify_approvals WHERE message_id = ?", id).map((r) => r.person_id).filter((x) => x !== m.created_by);
  if (new Set(approvers).size < m.approvals_required) E(409, "approval_required", "two-person approval is not complete");
  requireAssertion(personId, m, "send", assertion); // fresh assertion bound to the message hash
  // Authoritative gates at send time (the world may have changed since creation)
  const text = [m.text_en, m.text_te, m.title_en, m.title_te];
  if (lintContent(text).length) blockSend(m, s, "content_policy");
  const target = JSON.parse(m.target);
  const gate = mccGate({ category: m.category, state: m.state, district: m.district, templateId: m.template_id, declaration: m.declaration ? JSON.parse(m.declaration) : null, now: nowFn.now() });
  if (!gate.allowed) blockSend(m, s, gate.reason!, 422, { window: gate.window });
  if (!(m.category === "emergency" && p.sender_caps.emergency_exempt)) {
    const since = (ms: number) => new Date(nowFn.now().getTime() - ms).toISOString();
    const c = (ms: number) => (q1("SELECT COUNT(*) AS c FROM notify_messages WHERE org_id = ? AND status IN ('sending','sent') AND category <> 'emergency' AND sent_at >= ?", m.org_id, since(ms)) as Row).c as number;
    if (c(3_600_000) >= p.sender_caps.per_org_per_hour || c(86_400_000) >= p.sender_caps.per_org_per_day) blockSend(m, s, "sender_rate_cap", 429);
  }
  const audience = audienceIds(target);
  if (audience.length > p.limits.max_audience) blockSend(m, s, "audience_too_large", 422, { audience: audience.length });
  const sentAt = iso(), expires = new Date(nowFn.now().getTime() + p.limits.message_ttl_hours * 3_600_000).toISOString();
  const payload = { v: 1, id: m.id, sender: { org_id: m.org_id, name: s.org_name }, category: m.category, target, title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te, msg_hash: m.msg_hash, sent_at: sentAt, expires_at: expires, ...(m.category === "emergency" || m.declaration ? { declared: !!m.declaration } : {}) };
  const sig = signPayload(payload);
  const claimed = run("UPDATE notify_messages SET status = 'sending', sent_at = ?, expires_at = ?, signature = ?, key_id = ?, key_version = ?, signed_payload = ? WHERE id = ? AND status = 'approved'", sentAt, expires, sig.signature, sig.key_id, sig.key_version, sig.canonical, id);
  if (!Number(claimed.changes)) E(409, "bad_state", "already being sent");
  audit(personId, "notify.message.send", "notify_message:" + id, { org: m.org_id, category: m.category, audience: audience.length, key_id: sig.key_id });
  const dm: DeliverableMessage = { id: m.id, category: m.category, org_name: s.org_name, title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te, signature: sig.signature, key_id: sig.key_id, sent_at: sentAt, expires_at: expires };
  const stats: Record<string, number> = { audience: audience.length, delivered: 0, deferred: 0, opted_out: 0, daily_cap: 0, weekly_cap: 0, none: 0, push_sent: 0, sms_sent: 0 };
  for (const pid of audience) {
    const r = await deliverTo(pid, dm);
    if (r.result === "delivered") { stats.delivered++; if (r.push === "sent") stats.push_sent++; if (r.sms === "sent") stats.sms_sent++; }
    else if (r.result === "deferred") stats.deferred++;
    else stats[r.skip ?? "none"]++;
  }
  run("UPDATE notify_messages SET status = 'sent', stats = ? WHERE id = ?", JSON.stringify(stats), id);
  return { id, status: "sent", signature: sig.signature, key_id: sig.key_id, key_version: sig.key_version, signed_payload: sig.canonical, stats };
}

/** Public per-sender audit view: what each verified org sent (content is public by design) and its signature. */
export function publicSenderLog(orgId: string): Row | null {
  const o = q1("SELECT id, name, kind, status FROM notify_orgs WHERE id = ?", orgId);
  if (!o) return null;
  const msgs = qa("SELECT id, category, title_en, title_te, text_en, text_te, sent_at, signature, key_id, declaration, mcc_window FROM notify_messages WHERE org_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 200", orgId);
  return { org: o, messages: msgs.map((m) => ({ ...m, declaration: m.declaration ? { accepted: JSON.parse(m.declaration).accepted, reason: JSON.parse(m.declaration).reason } : null })) };
}
export const publicOrgs = (): Row[] => qa("SELECT id, name, kind FROM notify_orgs WHERE status = 'verified' ORDER BY name");

// ---------------------------------------------------------------------------------------------
// Pre-flight (S-155): lint without creating anything, the public kill/MCC status, admin lookups
// ---------------------------------------------------------------------------------------------

/** What the compose screen shows while typing: the content linter's findings per field. Creates nothing, writes no block log, needs an active sender binding. */
export function lintMessage(personId: string, b: Row): Row {
  if (!activeSender(personId)) E(403, "not_a_sender", "you are not an approved sender");
  const p = notifyPolicy();
  const fields: Record<string, string> = {};
  for (const k of ["text_en", "text_te", "title_en", "title_te"]) { const v = b[k]; if (typeof v === "string" && v.trim()) fields[k] = v.slice(0, 2000); }
  if (b.slots && typeof b.slots === "object") for (const [k, v] of Object.entries(b.slots as Row)) if (typeof v === "string" && v.trim()) fields["slot:" + String(k).slice(0, 40)] = v.slice(0, 2000);
  const findings: { rule: string; field: string; detail?: string }[] = [];
  for (const [field, text] of Object.entries(fields)) for (const h of lintContent([text])) findings.push({ field, ...h });
  const state = String(b.state ?? "").toUpperCase();
  const mcc = /^[A-Z]{2,3}$/.test(state) ? { state, window: notifyWindow(state, b.district ? String(b.district).slice(0, 40) : null, nowFn.now()) } : null;
  return {
    clean: findings.length === 0, findings, rules: [...new Set(findings.map((f) => f.rule))],
    chars: { text_en: (fields.text_en ?? "").length, text_te: (fields.text_te ?? "").length, max: p.limits.text_chars },
    mcc, note: "A preview only. The server checks again at create and at send; nothing was saved.",
  };
}

const WINDOW_NOTICE: Record<string, { en: string; te: string }> = {
  open: { en: "No election code of conduct restriction is in force for this state.", te: "ఈ రాష్ట్రంలో ఎన్నికల ప్రవర్తనా నియమావళి నిబంధనలు ప్రస్తుతం అమలులో లేవు." },
  blackout: { en: "The election code of conduct is in force. Only pre-cleared templates with a signed declaration, and emergency alerts with a declaration, can be sent.", te: "ఎన్నికల ప్రవర్తనా నియమావళి అమలులో ఉంది. ముందే అనుమతి పొందిన మూసలు (డిక్లరేషన్‌తో), డిక్లరేషన్‌తో అత్యవసర హెచ్చరికలు మాత్రమే పంపవచ్చు." },
  unknown: { en: "The election calendar is not available, so some message categories are blocked until it is known. Emergency alerts need a declaration.", te: "ఎన్నికల క్యాలెండర్ అందుబాటులో లేదు, కాబట్టి కొన్ని సందేశ వర్గాలు నిలిపివేయబడ్డాయి. అత్యవసర హెచ్చరికలకు డిక్లరేషన్ అవసరం." },
};
const KILL_NOTICE = {
  en: "Sending is suspended by the administrators. Messages cannot be created or sent until it is released.",
  te: "నిర్వాహకులు సందేశాల పంపకాన్ని నిలిపివేశారు. అది తిరిగి ప్రారంభమయ్యే వరకు సందేశాలను సృష్టించలేరు, పంపలేరు.",
};

/** Public: is sending suspended (no reason shown), and what the election-window state means for senders. `orgId` narrows an org-level kill to that sender. */
export function publicStatus(state: string, district: string | null, orgId: string | null): Row {
  const kills = qa("SELECT scope, org_id, engaged_at FROM notify_kill WHERE released_at IS NULL ORDER BY engaged_at");
  const all = kills.find((k) => k.scope === "all");
  const org = orgId ? kills.find((k) => k.scope === "org" && k.org_id === orgId) : undefined;
  const hit = all ?? org;
  const now = nowFn.now();
  const w = notifyWindow(state, district, now);
  return {
    kill: { engaged: !!hit, scope: all ? "all" : org ? "org" : null, since: hit?.engaged_at ?? null, orgs_suspended: kills.filter((k) => k.scope === "org").length, notice_en: hit ? KILL_NOTICE.en : null, notice_te: hit ? KILL_NOTICE.te : null },
    window: { state, status: w, notice_en: WINDOW_NOTICE[w].en, notice_te: WINDOW_NOTICE[w].te, declaration_needed: w !== "open", blocked_categories: w === "unknown" ? notifyPolicy().mcc.unknown_blocks : [] },
    as_of: now.toISOString(),
  };
}

const maskTail = (phone: string): string => "••••" + phone.replace(/\D/g, "").slice(-4);
/** Normalise what an admin typed into +91XXXXXXXXXX, or null when it is not a phone number. */
function asPhone(q: string): string | null {
  const d = q.replace(/[\s-]/g, "");
  if (!/^(\+?91)?[6-9]\d{9}$/.test(d)) return null;
  const n = "+91" + d.slice(-10);
  return E164_IN.test(n) ? n : null;
}
/**
 * Admin lookup of a sender candidate. A phone number is accepted only as the QUERY; the answer carries an opaque person id, a masked tail
 * and role context, never a number and never a name. A text hint matches enrolment labels but the label is not returned.
 */
export function lookupPeople(q: string): Row {
  const query = q.trim().slice(0, 40);
  if (query.length < 3) E(400, "query_too_short", "type at least 3 characters of a name hint, or a full phone number");
  const phone = asPhone(query);
  const rows: Row[] = phone
    ? (personsOnPhone(phone) as unknown as Row[])
    : qa("SELECT * FROM persons WHERE deleted_at IS NULL AND label IS NOT NULL AND lower(label) LIKE ? ESCAPE '!' ORDER BY created_at LIMIT 10", "%" + query.toLowerCase().replace(/[!%_]/g, "!$&") + "%");
  const people = rows.slice(0, 10).map((r) => {
    let tail: string | null = phone ? maskTail(phone) : null;
    if (!tail && r.phone_enc) { try { tail = maskTail(getKeys().decrypt("phone", r.phone_enc)); } catch { tail = null; } }
    const roles = listRolesDetailed(r.id).map((x) => ({ role: x.role, department: x.department, jurisdiction: x.jurisdiction }));
    const senders = qa("SELECT s.id, s.role, s.status, o.name AS org_name FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.person_id = ? ORDER BY s.created_at", r.id)
      .map((s) => ({ sender_id: s.id, org_name: s.org_name, role: s.role, status: s.status }));
    return { person_id: r.id, phone_tail: tail, tier: r.tier, roles, senders, matched_by: phone ? "phone" : "name_hint" };
  });
  return { people, note: "Pseudonymous references only. Phone numbers and names are not returned." };
}

/** Admin: the security keys of one sender (by sender binding id or person id), for revocation without pasting credential ids. Public key material is not returned. */
export function senderCredentials(sender: string): Row {
  const s = q1("SELECT s.id, s.person_id, s.role, s.status, o.name AS org_name FROM notify_senders s JOIN notify_orgs o ON o.id = s.org_id WHERE s.id = ? OR s.person_id = ? ORDER BY s.created_at DESC LIMIT 1", sender, sender);
  if (!s) return E(404, "sender_not_found");
  const creds = qa("SELECT id, alg, created_at, last_used_at, revoked_at FROM notify_credentials WHERE person_id = ? ORDER BY created_at", s.person_id);
  return { sender: { id: s.id, org_name: s.org_name, role: s.role, status: s.status }, credentials: creds.map((c) => ({ id: c.id, alg: c.alg, created_at: c.created_at, last_used_at: c.last_used_at, revoked: !!c.revoked_at, revoked_at: c.revoked_at })) };
}
