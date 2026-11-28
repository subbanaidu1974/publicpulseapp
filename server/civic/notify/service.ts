/**
 * Sender side (S-37, S-39): verified organisations, bound sender users with FIDO2 credentials, two-person approval, MCC gate,
 * signing, kill-switch, public block log, fan-out. Dual-control admin steps reuse the admin pattern (TOTP + a different admin).
 * All SQL is in server/data/repos/notify.ts (S-250); everything here that touches the database is async.
 */
import crypto from "node:crypto";
import { audit, canonicalJson, getKeys, hasRole, listRolesDetailed } from "../core";
import { identityDb } from "../core/asyncBridge";
import { NotifyStore, type Row } from "../../data/repos/notify";
import { E164_IN, personsOnPhone } from "../identity/service";
import { findTemplate, lintContent, mccGate, notifyPolicy, notifyWindow, renderTemplate, type Declaration } from "./content";
import { deliverTo, nowFn, type DeliverableMessage } from "./delivery";
import { signPayload } from "./sign";
import { assertionChallenge, b64u, verifyAssertion, verifyRegistration, webauthnConfig, WebAuthnError, type AssertionInput, type RegistrationInput } from "./webauthn";

export class NotifyError extends Error { constructor(public status: number, public code: string, m?: string, public extra: Record<string, unknown> = {}) { super(m ?? code); } }
const E = (status: number, code: string, m?: string, extra?: Record<string, unknown>): never => { throw new NotifyError(status, code, m, extra); };
const st = (): NotifyStore => new NotifyStore(identityDb());
const iso = () => nowFn.now().toISOString();

// ---------------------------------------------------------------------------------------------
// Organisations and sender users (dual control)
// ---------------------------------------------------------------------------------------------

export async function requestOrg(admin: string, b: Row): Promise<{ id: string }> {
  const p = notifyPolicy();
  const name = String(b.name ?? "").trim(), kind = String(b.kind ?? ""), letter = String(b.letter_ref ?? "").trim(), domain = String(b.email_domain ?? "").trim().toLowerCase(), contact = String(b.contact ?? "").trim();
  if (name.length < 3 || name.length > 120) E(400, "bad_name", "name must be 3 to 120 characters");
  if (!p.org_kinds[kind]) E(400, "bad_kind", "unknown organisation kind", { kinds: Object.keys(p.org_kinds) });
  if (letter.length < 3 || letter.length > 120) E(400, "letter_ref_required", "official letter reference is required");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) E(400, "bad_email_domain", "official email domain looks malformed");
  if (!p.allowed_link_domains.some((d) => domain === d || domain.endsWith("." + d))) E(400, "email_domain_not_government", "email domain is not on the government domain list (gov.in, nic.in)");
  if (contact.length < 5 || contact.length > 200) E(400, "contact_required", "contact is required");
  const id = crypto.randomUUID();
  await st().insertOrg({ id, name, kind, letter_ref: letter, email_domain: domain, contact, requested_by: admin, at: iso() });
  audit(admin, "notify.org.request", "notify_org:" + id, { kind });
  return { id };
}
export async function decideOrg(admin: string, id: string, approve: boolean): Promise<Row> {
  const s = st();
  const o = await s.org(id);
  if (!o) E(404, "org_not_found");
  if (o!.status !== "pending") E(409, "already_decided", `organisation already ${o!.status}`);
  if (o!.requested_by === admin) { audit(admin, "notify.org.self_approval_refused", "notify_org:" + id, {}); E(403, "dual_control", "a different admin must decide this organisation"); }
  await s.decideOrg(id, approve ? "verified" : "rejected", admin, iso());
  audit(admin, approve ? "notify.org.verify" : "notify.org.reject", "notify_org:" + id, { requested_by: o!.requested_by });
  return { id, status: approve ? "verified" : "rejected" };
}
export const listOrgs = (status?: string): Promise<Row[]> => st().listOrgs(status);

export async function requestSender(admin: string, b: Row): Promise<{ id: string }> {
  const p = notifyPolicy(), s = st();
  const orgId = String(b.org_id ?? ""), personId = String(b.person_id ?? ""), role = String(b.role ?? "");
  const org = await s.org(orgId);
  if (!org) E(404, "org_not_found");
  if (org!.status !== "verified") E(409, "org_not_verified", "the organisation is not verified yet");
  if (!p.sender_roles.includes(role) || !p.org_kinds[org!.kind].sender_roles.includes(role)) E(400, "bad_role", "role not allowed for this kind of organisation", { roles: p.org_kinds[org!.kind].sender_roles });
  if (!(await s.personExists(personId))) E(404, "person_not_found");
  if (personId === admin) E(403, "self_grant", "an admin cannot make themselves a sender");
  if (await s.senderOpen(orgId, personId)) E(409, "duplicate", "already a sender or pending");
  const id = crypto.randomUUID();
  await s.insertSender({ id, org_id: orgId, person_id: personId, role, requested_by: admin, at: iso() });
  audit(admin, "notify.sender.request", "person:" + personId, { org: orgId, role });
  return { id };
}
export async function decideSender(admin: string, id: string, approve: boolean): Promise<Row> {
  const s = st();
  const x = await s.sender(id);
  if (!x) E(404, "sender_not_found");
  if (x!.status !== "pending") E(409, "already_decided", `sender already ${x!.status}`);
  if (x!.requested_by === admin) { audit(admin, "notify.sender.self_approval_refused", "notify_sender:" + id, {}); E(403, "dual_control", "a different admin must decide this sender"); }
  if (x!.person_id === admin) E(403, "self_grant", "an admin cannot approve themselves as a sender");
  await s.decideSender(id, approve ? "active" : "rejected", admin, iso());
  audit(admin, approve ? "notify.sender.approve" : "notify.sender.reject", "person:" + x!.person_id, { org: x!.org_id, requested_by: x!.requested_by });
  return { id, status: approve ? "active" : "rejected" };
}
export async function revokeSender(admin: string, id: string): Promise<Row> {
  const s = st();
  const x = await s.sender(id);
  if (!x) E(404, "sender_not_found");
  await s.decideSender(id, "revoked", admin, iso());
  audit(admin, "notify.sender.revoke", "person:" + x!.person_id, { org: x!.org_id });
  return { id, status: "revoked" };
}
export async function revokeCredential(admin: string, credId: string): Promise<Row> {
  if (!(await st().revokeCredential(credId, iso()))) E(404, "credential_not_found");
  audit(admin, "notify.credential.revoke", "notify_credential:" + credId.slice(0, 16), {});
  return { ok: true };
}
export const listSenders = (status?: string): Promise<Row[]> => st().listSenders(status);

export async function senderMe(personId: string): Promise<Row> {
  const s = st();
  const rows = await s.sendersOf(personId);
  const creds = await s.credentialsListing(personId);
  return { person_id: personId, senders: rows.map((r) => ({ sender_id: r.id, role: r.role, status: r.status, org: { id: r.org_id, name: r.org_name, kind: r.kind, status: r.org_status } })), credentials: creds, can_send: rows.some((r) => r.status === "active" && r.org_status === "verified") && creds.length > 0 };
}

// ---------------------------------------------------------------------------------------------
// Kill switch (engage: one admin + TOTP, instant. Release: dual control)
// ---------------------------------------------------------------------------------------------

export async function engageKill(admin: string, b: Row): Promise<Row> {
  const s = st();
  const scope = b.scope === "org" ? "org" : b.scope === "all" ? "all" : E(400, "bad_scope", "scope must be all or org") as never;
  const reason = String(b.reason ?? "").trim();
  if (reason.length < 5 || reason.length > 300) E(400, "reason_required", "reason (5 to 300 characters) is required");
  let orgId: string | null = null;
  if (scope === "org") { orgId = String(b.org_id ?? ""); if (!(await s.orgExists(orgId))) E(404, "org_not_found"); }
  if (await s.killOpen(scope, orgId)) E(409, "already_engaged");
  const id = crypto.randomUUID();
  await s.insertKill({ id, scope, org_id: orgId, reason, by: admin, at: iso() });
  audit(admin, "notify.kill.engage", "notify_kill:" + id, { scope, org: orgId });
  return { id, scope, org_id: orgId };
}
export async function requestRelease(admin: string, id: string): Promise<Row> {
  const s = st();
  const k = await s.kill(id);
  if (!k) E(404, "kill_not_found");
  if (k!.released_at) E(409, "already_released");
  await s.requestRelease(id, admin, iso());
  audit(admin, "notify.kill.release_request", "notify_kill:" + id, {});
  return { id, release_requested_by: admin };
}
export async function approveRelease(admin: string, id: string): Promise<Row> {
  const s = st();
  const k = await s.kill(id);
  if (!k) E(404, "kill_not_found");
  if (k!.released_at) E(409, "already_released");
  if (!k!.release_requested_by) E(409, "release_not_requested", "a release must be requested first");
  if (k!.release_requested_by === admin) { audit(admin, "notify.kill.self_release_refused", "notify_kill:" + id, {}); E(403, "dual_control", "a different admin must approve the release"); }
  await s.approveRelease(id, admin, iso());
  audit(admin, "notify.kill.release", "notify_kill:" + id, { requested_by: k!.release_requested_by });
  return { id, released: true };
}
export const listKills = (): Promise<Row[]> => st().listKills();
export async function killedFor(orgId: string): Promise<"all" | "org" | null> {
  const r = await st().openKills();
  if (r.some((x) => x.scope === "all")) return "all";
  return r.some((x) => x.scope === "org" && x.org_id === orgId) ? "org" : null;
}

// ---------------------------------------------------------------------------------------------
// WebAuthn state
// ---------------------------------------------------------------------------------------------

async function newChallenge(personId: string, kind: "register" | "assert", purpose: string, messageId: string | null, msgHash: string | null): Promise<string> {
  const ttl = notifyPolicy().webauthn.challenge_ttl_s * 1000;
  const nonce = b64u(crypto.randomBytes(32));
  const challenge = kind === "register" ? nonce : assertionChallenge(purpose, messageId!, msgHash!, nonce);
  const s = st();
  await s.insertChallenge({ challenge, person_id: personId, kind, purpose, message_id: messageId, msg_hash: msgHash, expires_at: nowFn.now().getTime() + ttl });
  await s.purgeChallenges(nowFn.now().getTime() - 3_600_000);
  return challenge;
}
/** Consume a challenge exactly once; returns its row. */
async function takeChallenge(challenge: string, personId: string, kind: string, purpose: string, messageId: string | null): Promise<Row> {
  const s = st();
  const row = await s.challenge(challenge);
  if (!row || row.person_id !== personId || row.kind !== kind || row.purpose !== purpose || (row.message_id ?? null) !== messageId) return E(403, "challenge_invalid", "unknown challenge");
  if (row.expires_at < nowFn.now().getTime()) return E(403, "challenge_expired", "challenge expired; request a new one");
  if (!(await s.useChallenge(challenge, nowFn.now().getTime()))) return E(403, "challenge_reused", "challenge already used");
  return row;
}
const clientChallenge = (cdj: unknown): string => { try { return String(JSON.parse(Buffer.from(String(cdj), "base64url").toString("utf8")).challenge ?? ""); } catch { return ""; } };
const wa = (e: unknown): never => { if (e instanceof WebAuthnError) throw new NotifyError(403, "webauthn_" + e.code, "security key check failed: " + e.code); throw e; };

const activeSender = (personId: string, orgId?: string): Promise<Row | undefined> => st().activeSender(personId, orgId);

export async function registrationOptions(personId: string): Promise<Row> {
  if (!(await activeSender(personId))) E(403, "not_a_sender", "you are not an approved sender");
  const cfg = webauthnConfig();
  const challenge = await newChallenge(personId, "register", "register", null, null);
  const existing = await st().credentialsListing(personId);
  return {
    challenge, rp: { id: cfg.rpId, name: cfg.rpName }, user: { id: b64u(Buffer.from(personId)), name: "sender-" + personId.slice(0, 8), displayName: "Notification sender" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }], attestation: "none", timeout: 120000,
    authenticatorSelection: { authenticatorAttachment: "cross-platform", residentKey: "discouraged", userVerification: "required" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
  };
}
export async function finishRegistration(personId: string, body: RegistrationInput): Promise<Row> {
  if (!(await activeSender(personId))) E(403, "not_a_sender", "you are not an approved sender");
  await takeChallenge(clientChallenge(body?.response?.clientDataJSON), personId, "register", "register", null);
  let v;
  try { v = verifyRegistration(body, clientChallenge(body.response.clientDataJSON), { requireUv: notifyPolicy().webauthn.require_user_verification }); } catch (e) { return wa(e); }
  const s = st();
  if (await s.credentialExists(v.credentialId)) E(409, "credential_exists");
  await s.insertCredential({ id: v.credentialId, person_id: personId, spki: v.spki, alg: v.alg, counter: v.counter, aaguid: v.aaguid, at: iso() });
  audit(personId, "notify.credential.register", "person:" + personId, { alg: v.alg });
  return { credential_id: v.credentialId, alg: v.alg };
}
const credentialsOf = (personId: string): Promise<Row[]> => st().credentialsOf(personId);

export async function assertionOptions(personId: string, messageId: string, purpose: string): Promise<Row> {
  if (purpose !== "approve" && purpose !== "send") E(400, "bad_purpose", "purpose must be approve or send");
  const m = await st().messageHead(messageId);
  if (!m || !(await activeSender(personId, m.org_id))) return E(404, "message_not_found");
  const creds = await credentialsOf(personId);
  if (!creds.length) E(403, "fido2_required", "register a security key first");
  const challenge = await newChallenge(personId, "assert", purpose, messageId, m.msg_hash);
  return { challenge, rpId: webauthnConfig().rpId, timeout: 120000, userVerification: "required", allowCredentials: creds.map((c) => ({ type: "public-key", id: c.id })), message_hash: m.msg_hash };
}
/** Verifies a fresh assertion whose challenge is bound to (purpose, message id, CURRENT message hash). Returns the credential id. */
async function requireAssertion(personId: string, m: Row, purpose: string, a: AssertionInput): Promise<string> {
  if (!a || typeof a !== "object") E(403, "assertion_required", "a security key assertion bound to this message is required");
  const ch = clientChallenge(a.response?.clientDataJSON);
  const row = await takeChallenge(ch, personId, "assert", purpose, m.id);
  if (row.msg_hash !== m.msg_hash) E(409, "message_changed", "the message changed after the challenge was issued");
  const cred = (await credentialsOf(personId)).find((c) => c.id === a.id);
  if (!cred) E(403, "credential_unknown", "that security key is not registered to you");
  let counter: number;
  try {
    counter = verifyAssertion(a, { id: cred!.id, spki: cred!.spki, alg: cred!.alg, counter: cred!.sign_count }, ch, { requireUv: notifyPolicy().webauthn.require_user_verification }).counter;
  } catch (e) { return wa(e); }
  await st().touchCredential(cred!.id, counter, iso());
  return cred!.id;
}

// ---------------------------------------------------------------------------------------------
// Block log (public: time bucket, org, category, reason code, no content)
// ---------------------------------------------------------------------------------------------

export async function logBlock(orgId: string | null, orgName: string, category: string, reason: string): Promise<void> {
  const bucket = new Date(Math.floor(nowFn.now().getTime() / 3_600_000) * 3_600_000).toISOString();
  await st().logBlock(bucket, orgId, orgName, category, reason);
  audit("system", "notify.blocked", "notify_org:" + (orgId ?? "none"), { category, reason });
}
export const publicBlockLog = (limit = 200, before?: number): Promise<Row[]> => st().blockLog(Math.min(Math.max(limit, 1), 500), before ?? Number.MAX_SAFE_INTEGER);

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

async function senderGate(personId: string, orgId: string | null, category: string | null): Promise<Row> {
  const s = await activeSender(personId, orgId ?? undefined);
  const pending = await st().anySenderStatus(personId);
  if (!s) return E(403, "sender_unverified", pending ? "your sender binding is not active" : "you are not a registered sender");
  if (s.org_status !== "verified") E(403, "sender_unverified", "organisation is not verified");
  const k = await killedFor(s.org_id);
  if (k) { await logBlock(s.org_id, s.org_name, category ?? "other", "kill_switch"); E(423, "kill_switch", k === "all" ? "all sending is suspended" : "this sender is suspended"); }
  if (!(await credentialsOf(personId)).length) E(403, "fido2_required", "register a FIDO2 security key before sending");
  if (s.role === "eci_liaison" && !hasRole(personId, "eci_liaison")) E(403, "sender_unverified", "election commission liaison role missing");
  return s;
}

export async function createMessage(personId: string, b: Row): Promise<Row> {
  const p = notifyPolicy();
  const s = await senderGate(personId, b.org_id ? String(b.org_id) : null, b.category ? String(b.category) : null);
  const category = String(b.category ?? "");
  if (!p.categories.includes(category)) E(400, "bad_category", "unknown category", { categories: p.categories });
  if (!p.org_kinds[s.org_kind].categories.includes(category)) { await logBlock(s.org_id, s.org_name, category, "category_not_allowed"); E(403, "category_not_allowed", category === "election_info" ? "election information may only be sent through the Election Commission liaison" : "this organisation cannot send this category"); }
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
  if (hits.length) { await logBlock(s.org_id, s.org_name, category, "content_policy"); E(422, "content_policy", "message refused: notifications never ask for OTP, PIN, passwords, login, payment or links outside the allow-list", { rules: [...new Set(hits.map((h) => h.rule))] }); }
  const gate = mccGate({ category, state: target.state, district: target.district, templateId, declaration, now: nowFn.now() });
  if (!gate.allowed) { await logBlock(s.org_id, s.org_name, category, gate.reason!); E(422, gate.reason!, "blocked by Model Code of Conduct rules", { window: gate.window }); }
  const required = category === "emergency" ? (templateId ? p.approvals.emergency_template : p.approvals.emergency_free_text) : p.approvals.standard;
  const id = crypto.randomUUID();
  const hash = messageHash({ org_id: s.org_id, category, target, title_en: titleEn, title_te: titleTe, text_en: en, text_te: te, template_id: templateId, slots, declaration });
  await st().insertMessage({ id, org_id: s.org_id, created_by: personId, category, state: target.state, district: target.district, target: JSON.stringify(target), title_en: titleEn, title_te: titleTe, text_en: en, text_te: te, template_id: templateId, slots: slots ? JSON.stringify(slots) : null, declaration: declaration ? JSON.stringify(declaration) : null, msg_hash: hash, approvals_required: required, mcc_window: gate.window, at: iso() });
  audit(personId, "notify.message.create", "notify_message:" + id, { org: s.org_id, category, window: gate.window });
  return { id, status: "pending_approval", msg_hash: hash, approvals_required: required, mcc_window: gate.window };
}

const publicMsg = async (m: Row): Promise<Row> => ({
  id: m.id, org_id: m.org_id, category: m.category, status: m.status, blocked_reason: m.blocked_reason, target: JSON.parse(m.target), title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te,
  template_id: m.template_id, msg_hash: m.msg_hash, approvals_required: m.approvals_required, approvals: await st().approvalCount(m.id),
  declaration: m.declaration ? JSON.parse(m.declaration) : null, mcc_window: m.mcc_window, created_by: m.created_by, created_at: m.created_at, sent_at: m.sent_at, stats: m.stats ? JSON.parse(m.stats) : null, signature: m.signature, key_id: m.key_id,
});
export async function getMessage(personId: string, id: string): Promise<Row> {
  const m = await st().message(id);
  if (!m || !(await activeSender(personId, m.org_id))) return E(404, "message_not_found");
  return publicMsg(m);
}
export async function listMessages(personId: string): Promise<Row[]> {
  const s = st();
  const orgs = await s.activeOrgIds(personId);
  if (!orgs.length) return [];
  return Promise.all((await s.messagesForOrgs(orgs)).map(publicMsg));
}

export async function approveMessage(personId: string, id: string, assertion: AssertionInput): Promise<Row> {
  const s = st();
  const m = await s.message(id);
  if (!m) return E(404, "message_not_found");
  const sg = await senderGate(personId, m.org_id, m.category);
  if (m.status !== "pending_approval") E(409, "bad_state", `message is ${m.status}`);
  if (m.created_by === personId) { audit(personId, "notify.message.self_approval_refused", "notify_message:" + id, {}); E(403, "dual_control", "a different sender must approve this message"); }
  if (await s.approvalExists(id, personId)) E(409, "already_approved");
  const cred = await requireAssertion(personId, m, "approve", assertion);
  await s.insertApproval(id, personId, iso(), cred);
  const n = await s.approvalCount(id);
  const done = n >= m.approvals_required;
  if (done) await s.setApproved(id, iso());
  audit(personId, "notify.message.approve", "notify_message:" + id, { org: sg.org_id, approvals: n, of: m.approvals_required });
  return { id, status: done ? "approved" : "pending_approval", approvals: n, approvals_required: m.approvals_required };
}

export async function cancelMessage(personId: string, id: string): Promise<Row> {
  const s = st();
  const m = await s.message(id);
  if (!m || !(await activeSender(personId, m.org_id))) return E(404, "message_not_found");
  if (!["pending_approval", "approved"].includes(m.status)) E(409, "bad_state", `message is ${m.status}`);
  await s.cancelMessage(id);
  audit(personId, "notify.message.cancel", "notify_message:" + id, {});
  return { id, status: "cancelled" };
}

const audienceIds = (target: { units: string[]; all_in_state: boolean }): Promise<string[]> => (target.all_in_state ? st().residents() : st().residentsIn(target.units));

async function blockSend(m: Row, org: Row, reason: string, status = 422, extra: Record<string, unknown> = {}): Promise<never> {
  await st().blockMessage(m.id, reason);
  await logBlock(org.org_id ?? m.org_id, org.org_name, m.category, reason);
  return E(status, reason, "blocked: " + reason, extra);
}

export async function sendMessage(personId: string, id: string, assertion: AssertionInput): Promise<Row> {
  const p = notifyPolicy(), store = st();
  const m = await store.message(id);
  if (!m) return E(404, "message_not_found");
  const s = await senderGate(personId, m.org_id, m.category); // kill switch, verified org, FIDO2 present
  if (m.status !== "approved") E(409, m.status === "pending_approval" ? "approval_required" : "bad_state", m.status === "pending_approval" ? "two-person approval is not complete" : `message is ${m.status}`);
  const approvers = (await store.approverIds(id)).filter((x) => x !== m.created_by);
  if (new Set(approvers).size < m.approvals_required) E(409, "approval_required", "two-person approval is not complete");
  await requireAssertion(personId, m, "send", assertion); // fresh assertion bound to the message hash
  // Authoritative gates at send time (the world may have changed since creation)
  const text = [m.text_en, m.text_te, m.title_en, m.title_te];
  if (lintContent(text).length) await blockSend(m, s, "content_policy");
  const target = JSON.parse(m.target);
  const gate = mccGate({ category: m.category, state: m.state, district: m.district, templateId: m.template_id, declaration: m.declaration ? JSON.parse(m.declaration) : null, now: nowFn.now() });
  if (!gate.allowed) await blockSend(m, s, gate.reason!, 422, { window: gate.window });
  if (!(m.category === "emergency" && p.sender_caps.emergency_exempt)) {
    const since = (ms: number) => new Date(nowFn.now().getTime() - ms).toISOString();
    const c = (ms: number) => store.sentSince(m.org_id, since(ms));
    if ((await c(3_600_000)) >= p.sender_caps.per_org_per_hour || (await c(86_400_000)) >= p.sender_caps.per_org_per_day) await blockSend(m, s, "sender_rate_cap", 429);
  }
  const audience = await audienceIds(target);
  if (audience.length > p.limits.max_audience) await blockSend(m, s, "audience_too_large", 422, { audience: audience.length });
  const sentAt = iso(), expires = new Date(nowFn.now().getTime() + p.limits.message_ttl_hours * 3_600_000).toISOString();
  const payload = { v: 1, id: m.id, sender: { org_id: m.org_id, name: s.org_name }, category: m.category, target, title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te, msg_hash: m.msg_hash, sent_at: sentAt, expires_at: expires, ...(m.category === "emergency" || m.declaration ? { declared: !!m.declaration } : {}) };
  const sig = signPayload(payload);
  if (!(await store.claimSending(id, { sent_at: sentAt, expires_at: expires, signature: sig.signature, key_id: sig.key_id, key_version: sig.key_version, signed_payload: sig.canonical }))) E(409, "bad_state", "already being sent");
  audit(personId, "notify.message.send", "notify_message:" + id, { org: m.org_id, category: m.category, audience: audience.length, key_id: sig.key_id });
  const dm: DeliverableMessage = { id: m.id, category: m.category, org_name: s.org_name, title_en: m.title_en, title_te: m.title_te, text_en: m.text_en, text_te: m.text_te, signature: sig.signature, key_id: sig.key_id, sent_at: sentAt, expires_at: expires };
  const stats: Record<string, number> = { audience: audience.length, delivered: 0, deferred: 0, opted_out: 0, daily_cap: 0, weekly_cap: 0, none: 0, push_sent: 0, sms_sent: 0 };
  for (const pid of audience) {
    const r = await deliverTo(pid, dm);
    if (r.result === "delivered") { stats.delivered++; if (r.push === "sent") stats.push_sent++; if (r.sms === "sent") stats.sms_sent++; }
    else if (r.result === "deferred") stats.deferred++;
    else stats[r.skip ?? "none"]++;
  }
  await store.markSent(id, JSON.stringify(stats));
  return { id, status: "sent", signature: sig.signature, key_id: sig.key_id, key_version: sig.key_version, signed_payload: sig.canonical, stats };
}

/** Public per-sender audit view: what each verified org sent (content is public by design) and its signature. */
export async function publicSenderLog(orgId: string): Promise<Row | null> {
  const s = st();
  const o = await s.orgPublic(orgId);
  if (!o) return null;
  const msgs = await s.sentMessages(orgId);
  return { org: o, messages: msgs.map((m) => ({ ...m, declaration: m.declaration ? { accepted: JSON.parse(m.declaration).accepted, reason: JSON.parse(m.declaration).reason } : null })) };
}
export const publicOrgs = (): Promise<Row[]> => st().publicOrgs();

// ---------------------------------------------------------------------------------------------
// Pre-flight (S-155): lint without creating anything, the public kill/MCC status, admin lookups
// ---------------------------------------------------------------------------------------------

/** What the compose screen shows while typing: the content linter's findings per field. Creates nothing, writes no block log, needs an active sender binding. */
export async function lintMessage(personId: string, b: Row): Promise<Row> {
  if (!(await activeSender(personId))) E(403, "not_a_sender", "you are not an approved sender");
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
export async function publicStatus(state: string, district: string | null, orgId: string | null): Promise<Row> {
  const kills = await st().openKills();
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
export async function lookupPeople(q: string): Promise<Row> {
  const query = q.trim().slice(0, 40);
  if (query.length < 3) E(400, "query_too_short", "type at least 3 characters of a name hint, or a full phone number");
  const phone = asPhone(query);
  const s = st();
  const rows: Row[] = phone
    ? (personsOnPhone(phone) as unknown as Row[])
    : await s.personsByLabel("%" + query.toLowerCase().replace(/[!%_]/g, "!$&") + "%");
  const people = await Promise.all(rows.slice(0, 10).map(async (r) => {
    let tail: string | null = phone ? maskTail(phone) : null;
    if (!tail && r.phone_enc) { try { tail = maskTail(getKeys().decrypt("phone", r.phone_enc)); } catch { tail = null; } }
    const roles = listRolesDetailed(r.id).map((x) => ({ role: x.role, department: x.department, jurisdiction: x.jurisdiction }));
    const senders = (await s.sendersWithOrgName(r.id)).map((x) => ({ sender_id: x.id, org_name: x.org_name, role: x.role, status: x.status }));
    return { person_id: r.id, phone_tail: tail, tier: r.tier, roles, senders, matched_by: phone ? "phone" : "name_hint" };
  }));
  return { people, note: "Pseudonymous references only. Phone numbers and names are not returned." };
}

/** Admin: the security keys of one sender (by sender binding id or person id), for revocation without pasting credential ids. Public key material is not returned. */
export async function senderCredentials(sender: string): Promise<Row> {
  const s = st();
  const x = await s.senderByIdOrPerson(sender);
  if (!x) return E(404, "sender_not_found");
  const creds = await s.credentialsAll(x.person_id);
  return { sender: { id: x.id, org_name: x.org_name, role: x.role, status: x.status }, credentials: creds.map((c) => ({ id: c.id, alg: c.alg, created_at: c.created_at, last_used_at: c.last_used_at, revoked: !!c.revoked_at, revoked_at: c.revoked_at })) };
}
