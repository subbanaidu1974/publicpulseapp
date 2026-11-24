/**
 * Audit-metadata scrubber (S-160, THREAT_MODEL T-31). The rule "no phone numbers, PINs, OTPs or response contents in audit metadata" is enforced
 * here, inside audit(), rather than by reviewer discipline:
 *
 *   - keys whose normalised name is a known sensitive one (pin, otp, phone, answers, token, password, ...) have their VALUE replaced;
 *   - any key whose name ends in pin / otp / phone / token / password / secret / answers is treated the same way (new_pin, oldPin, phone_number);
 *   - E.164-like and Indian mobile numbers inside any string value are masked, wherever they appear and however deeply nested;
 *   - bare 4-6 digit strings under a key that names a code (code, pin, otp, passcode, ...) are replaced;
 *   - long digit runs given as numbers under a sensitive key are replaced too.
 *
 * The scrubber never throws and never drops the audit row: a violation is replaced by "[scrubbed]" and the row gains `_scrubbed: <n>` so the
 * attempt is visible in the (hash-chained) log, and `auditScrubCount()` lets tests and ops see it happened. Redaction rather than rejection
 * is deliberate: an audit write that throws would roll back the surrounding action (T-26), turning a coding slip into an outage.
 */

export const SCRUBBED = "[scrubbed]";

/** Normalised key names (lower case, letters and digits only) whose value is never allowed in audit metadata. */
const SENSITIVE_KEYS = new Set([
  "pin", "newpin", "oldpin", "currentpin", "otp", "otpcode", "phone", "phonenumber", "msisdn", "mobile", "mobilenumber", "answers", "answer",
  "responses", "response", "responsebody", "choices", "token", "accesstoken", "bearer", "password", "passcode", "secret", "apikey", "totp", "recoverycode", "recoverycodes",
]);
const SENSITIVE_SUFFIXES = ["pin", "otp", "phone", "token", "password", "secret", "answers", "passcode", "msisdn"];
/** Keys that may legitimately hold a short numeric code of another kind; a 4-6 digit value under them is replaced only when the key says it is a secret code. */
const CODE_KEYS = new Set(["code", "pin", "otp", "passcode", "verificationcode", "otpcode", "smscode"]);

/** +91 / 91 / bare Indian mobile numbers, other E.164-looking runs of 10-15 digits (spaces or dashes allowed inside), not part of a longer alphanumeric token. */
const PHONE_RE = /(?<![A-Za-z0-9])(?:\+\s?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,14}\d(?![A-Za-z0-9])/g;
const MIN_DIGITS = 10;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const isSensitiveKey = (k: string): boolean => {
  const n = norm(k);
  return SENSITIVE_KEYS.has(n) || SENSITIVE_SUFFIXES.some((s) => n.length > s.length && n.endsWith(s));
};

let scrubbed = 0;
/** How many values the scrubber has replaced since start-up (or the last reset). */
export const auditScrubCount = (): number => scrubbed;
export const resetAuditScrubCount = (): void => { scrubbed = 0; };

/** Mask phone-shaped digit runs in a string. Returns the cleaned string and how many runs were masked. */
export function maskPhones(s: string): { text: string; n: number } {
  let n = 0;
  const text = s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < MIN_DIGITS || digits > 15) return m;
    n++;
    return SCRUBBED;
  });
  return { text, n };
}

function scrubValue(key: string, v: unknown, depth: number, hits: { n: number }): unknown {
  if (v === null || v === undefined) return v;
  const k = norm(key);
  if (key && isSensitiveKey(key)) { hits.n++; return SCRUBBED; }
  if (typeof v === "string") {
    if (key && CODE_KEYS.has(k) && /^\d{4,6}$/.test(v)) { hits.n++; return SCRUBBED; }
    const m = maskPhones(v);
    hits.n += m.n;
    return m.text;
  }
  if (typeof v === "number") {
    if (key && CODE_KEYS.has(k) && Number.isInteger(v) && v >= 1000 && v <= 999999) { hits.n++; return SCRUBBED; }
    if (Number.isInteger(v) && Math.abs(v) >= 6_000_000_000 && Math.abs(v) <= 999_999_999_999 && /^[6-9]\d{9}$|^91[6-9]\d{9}$/.test(String(Math.abs(v)))) { hits.n++; return SCRUBBED; }
    return v;
  }
  if (depth > 6) { hits.n++; return SCRUBBED; } // do not walk arbitrarily deep structures
  if (Array.isArray(v)) return v.map((x) => scrubValue(key, x, depth + 1, hits));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) out[kk] = scrubValue(kk, vv, depth + 1, hits);
    return out;
  }
  return v;
}

/** Returns metadata that is safe to write. Pure apart from the module counter. */
export function scrubAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const hits = { n: 0 };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) out[k] = scrubValue(k, v, 0, hits);
  if (hits.n > 0) { out._scrubbed = hits.n; scrubbed += hits.n; }
  return out;
}

/** Scan already-written metadata (a JSON string) for what the scrubber would reject. Used by tests and the ops check; returns the offending key paths. */
export function findAuditViolations(metaJson: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(metaJson); } catch { return ["unparseable"]; }
  const bad: string[] = [];
  const walk = (key: string, path: string, v: unknown, depth: number) => {
    if (v === null || v === undefined) return;
    if (key && isSensitiveKey(key) && v !== SCRUBBED) { bad.push(path); return; }
    if (typeof v === "string") {
      if (key && CODE_KEYS.has(norm(key)) && /^\d{4,6}$/.test(v)) bad.push(path);
      else if (maskPhones(v).n > 0) bad.push(path);
    } else if (typeof v === "number") {
      if (key && CODE_KEYS.has(norm(key)) && Number.isInteger(v) && v >= 1000 && v <= 999999) bad.push(path);
    } else if (depth <= 6 && Array.isArray(v)) v.forEach((x, i) => walk(key, `${path}[${i}]`, x, depth + 1));
    else if (depth <= 6 && typeof v === "object") for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) walk(kk, path ? `${path}.${kk}` : kk, vv, depth + 1);
  };
  walk("", "", parsed, 0);
  return bad;
}
