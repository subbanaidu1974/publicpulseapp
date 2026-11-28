/**
 * TOTP multi-factor authentication for admins (S-140), implemented in-house per RFC 6238 / RFC 4226 (HMAC-SHA1, 6 digits, 30 s step,
 * +/-1 step tolerance). The secret is stored encrypted (KeyProvider purpose "totp"); recovery codes are stored only as keyed hashes
 * and work once. A code is accepted at most once (the matched time-step counter must increase), which blocks replay of a sniffed code.
 */
import crypto from "node:crypto";
import { audit, getDb, getKeys, registerErasureHook, registerMigration } from "../core";
import { identityDb } from "../core/asyncBridge";
import { AdminStore } from "../../data/repos/admin";

const st = (): AdminStore => new AdminStore(identityDb());

registerMigration("admin_001_mfa_requests", `
CREATE TABLE admin_mfa (
  person_id TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_counter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE admin_mfa_recovery (
  person_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (person_id, code_hash)
);
CREATE TABLE role_requests (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('grant','revoke')),
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX idx_role_requests_status ON role_requests(status, created_at);
-- The issues module's Phase-1 officer_role stub rows become real core roles (department + LGD scope carried over).
CREATE TABLE IF NOT EXISTS officer_role (
  person_id TEXT NOT NULL, role TEXT NOT NULL, department TEXT, jurisdiction_lgd TEXT, label TEXT,
  PRIMARY KEY (person_id, role)
);
INSERT OR IGNORE INTO roles (person_id, role, jurisdiction, department, granted_by, granted_at)
  SELECT o.person_id, o.role, COALESCE(o.jurisdiction_lgd, ''), COALESCE(o.department, ''), 'system:migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM officer_role o WHERE o.role IN ('officer','moderator') AND o.person_id IN (SELECT id FROM persons WHERE deleted_at IS NULL);
`);
registerErasureHook("admin.mfa", (personId) => {
  const d = getDb();
  d.prepare("DELETE FROM admin_mfa WHERE person_id = ?").run(personId);
  d.prepare("DELETE FROM admin_mfa_recovery WHERE person_id = ?").run(personId);
  d.prepare("UPDATE role_requests SET status = 'expired' WHERE status = 'pending' AND (person_id = ? OR requested_by = ?)").run(personId, personId);
});

// ---- RFC 4648 base32 (no padding) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---- RFC 4226 / 6238 ----
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export const TOTP_STEP_S = 30;
export const totpCounter = (timeMs: number, step = TOTP_STEP_S): number => Math.floor(timeMs / 1000 / step);
export function totp(secret: Buffer, timeMs: number, digits = 6, step = TOTP_STEP_S): string { return hotp(secret, totpCounter(timeMs, step), digits); }
/** Returns the matched counter (within +/- `window` steps) or null. Constant-time per candidate. */
export function matchTotp(secret: Buffer, code: string, timeMs: number, window = Number(process.env.CIVIC_TOTP_WINDOW ?? 1)): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const c0 = totpCounter(timeMs);
  let hit: number | null = null;
  for (let c = c0 - window; c <= c0 + window; c++) {
    const want = Buffer.from(hotp(secret, c)), given = Buffer.from(code);
    if (crypto.timingSafeEqual(want, given) && hit === null) hit = c;
  }
  return hit;
}

// ---- Enrolment + verification ----
const rcHash = (code: string) => getKeys().hmac("mfa-recovery", code.toLowerCase().replace(/[^a-z0-9]/g, ""));
const newRecoveryCode = () => { const h = crypto.randomBytes(5).toString("hex"); return h.slice(0, 5) + "-" + h.slice(5); };

export interface MfaStatus { enrolled: boolean; confirmed: boolean; recovery_codes_left: number }
export async function mfaStatus(personId: string): Promise<MfaStatus> {
  const row = await st().mfaRow(personId);
  return { enrolled: !!row, confirmed: !!row?.confirmed, recovery_codes_left: await st().recoveryLeft(personId) };
}

/** Start (or restart, while unconfirmed) enrolment. Returns the secret and recovery codes ONCE; only encrypted/hashed forms are stored. */
export async function enrolMfa(personId: string, label = "People Pulse"): Promise<{ secret: string; otpauth_uri: string; recovery_codes: string[] }> {
  if ((await mfaStatus(personId)).confirmed) throw new Error("already enrolled");
  const raw = crypto.randomBytes(20);
  const secret = base32Encode(raw);
  const codes = Array.from({ length: 8 }, newRecoveryCode);
  await st().startEnrolment(personId, getKeys().encrypt("totp", secret), new Date().toISOString(), codes.map(rcHash));
  audit(personId, "admin.mfa.enrol_started", "person:" + personId, {});
  const issuer = encodeURIComponent("People Pulse");
  return { secret, otpauth_uri: `otpauth://totp/${issuer}:${encodeURIComponent(label)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`, recovery_codes: codes };
}

async function secretOf(personId: string): Promise<{ secret: Buffer; confirmed: boolean; last: number } | null> {
  const row = await st().mfaRow(personId);
  if (!row) return null;
  return { secret: base32Decode(getKeys().decrypt("totp", row.secret_enc)), confirmed: !!row.confirmed, last: row.last_counter };
}

/** Confirm enrolment with the first valid code from the authenticator app. */
export async function confirmMfa(personId: string, code: string, now = Date.now()): Promise<boolean> {
  const s = await secretOf(personId);
  if (!s || s.confirmed) return false;
  const c = matchTotp(s.secret, code, now);
  if (c === null) return false;
  await st().confirm(personId, c);
  audit(personId, "admin.mfa.enrolled", "person:" + personId, {});
  return true;
}

/** Verify a TOTP code (single use per time step) or a recovery code (single use). Only for confirmed enrolments. */
export async function verifyMfa(personId: string, o: { code?: string; recovery?: string }, now = Date.now()): Promise<{ ok: boolean; via?: "totp" | "recovery" }> {
  const s = await secretOf(personId);
  if (!s || !s.confirmed) return { ok: false };
  if (o.code) {
    const c = matchTotp(s.secret, o.code, now);
    if (c !== null && c > s.last && (await st().advanceCounter(personId, c))) return { ok: true, via: "totp" };
  }
  if (o.recovery) {
    if (await st().useRecovery(personId, rcHash(o.recovery), new Date(now).toISOString())) { audit(personId, "admin.mfa.recovery_used", "person:" + personId, {}); return { ok: true, via: "recovery" }; }
  }
  return { ok: false };
}
