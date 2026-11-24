/**
 * Persisted IVR call state (S-146): one sqlite row per call, so an in-flight call survives a server restart and a second instance
 * sees the same state. Rows expire (TTL from data/civic/retention-policy.json, default 15 minutes) and are pruned lazily and by
 * the issues sweep. The caller's number is stored encrypted (KeyProvider purpose "ivr-call-phone"); a PIN is never stored.
 * S-74: this table is in the ISSUES store, which holds no persons.id, so the person id and the adults list are stored ENCRYPTED
 * (purpose "ivr-call-person") and rows are matched to a person for erasure through keyed pseudonyms in `person_keys`.
 * Account erasure deletes any call row that names the person (as the caller or among the adults on the shared SIM).
 */
import { getKeys, getStore, registerMigration, registerStoreErasureHook } from "../core";
import { ivrPseudonym } from "../core/pseudonyms";
import { retentionPolicy } from "../issues/media";
import type { Dialect } from "./dialect";

export type IvrState = "welcome" | "who" | "pin" | "category" | "record" | "confirm" | "status" | "survey" | "done" | "goodbye";
export interface Call {
  callId: string; phone: string; state: IvrState; category?: string; referenceId?: string; lastRef?: string; createdAt: number; turns: number;
  adults?: string[]; personId?: string; needsPin?: boolean; verified?: boolean; dialect?: Dialect;
}

const DDL = `
CREATE TABLE IF NOT EXISTS ivr_call (
  call_id TEXT PRIMARY KEY, phone_enc TEXT NOT NULL, state TEXT NOT NULL, category TEXT, reference_id TEXT, last_ref TEXT,
  adults_enc TEXT, person_enc TEXT, person_keys TEXT, needs_pin INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ivr_call_expiry ON ivr_call(expires_at);
`;
registerMigration("channels_ivr_call_001", DDL, "issues");

export const callTtlMs = () => Number(process.env.CIVIC_IVR_CALL_TTL_MS) || retentionPolicy().ivr_call_state_minutes * 60_000;

/** Created lazily too, so a router used before migrate() (or after a test DB reset) still works. */
const ensured = new WeakSet<object>();
function db() {
  const d = getStore("issues");
  if (!ensured.has(d)) {
    d.exec(DDL);
    // S-151: dialect column, added idempotently (the 001 migration text is unchanged so its checksum stays valid)
    const cols = d.prepare("PRAGMA table_info(ivr_call)").all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === "dialect")) d.exec("ALTER TABLE ivr_call ADD COLUMN dialect TEXT");
    ensured.add(d);
  }
  return d;
}

export interface CallStore {
  get(callId: string, nowMs: number): Call | null;
  has(callId: string, nowMs: number): boolean;
  put(c: Call): void;
  delete(callId: string): void;
  prune(nowMs: number): number;
}

/** Space-delimited keyed pseudonyms of every person the call names (caller and adults on the SIM), for erasure matching. */
const keysOf = (c: Call): string | null => {
  const ids = [...new Set([...(c.personId ? [c.personId] : []), ...(c.adults ?? [])])];
  return ids.length ? " " + ids.map(ivrPseudonym).join(" ") + " " : null;
};

export const sqliteCallStore: CallStore = {
  get(callId, nowMs) {
    const r = db().prepare("SELECT * FROM ivr_call WHERE call_id=?").get(callId) as any;
    if (!r) return null;
    if (r.expires_at <= nowMs) { db().prepare("DELETE FROM ivr_call WHERE call_id=?").run(callId); return null; }
    return {
      callId: r.call_id, phone: getKeys().decrypt("ivr-call-phone", r.phone_enc), state: r.state, category: r.category ?? undefined, referenceId: r.reference_id ?? undefined,
      lastRef: r.last_ref ?? undefined, createdAt: r.created_at, turns: r.turns, adults: r.adults_enc ? JSON.parse(getKeys().decrypt("ivr-call-person", r.adults_enc)) : undefined,
      personId: r.person_enc ? getKeys().decrypt("ivr-call-person", r.person_enc) : undefined, needsPin: !!r.needs_pin, verified: !!r.verified, dialect: r.dialect ?? undefined,
    };
  },
  has(callId, nowMs) { return this.get(callId, nowMs) !== null; },
  put(c) {
    db().prepare(`INSERT INTO ivr_call (call_id,phone_enc,state,category,reference_id,last_ref,adults_enc,person_enc,person_keys,needs_pin,verified,turns,created_at,expires_at,dialect)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(call_id) DO UPDATE SET state=excluded.state, category=excluded.category, reference_id=excluded.reference_id, last_ref=excluded.last_ref,
        adults_enc=excluded.adults_enc, person_enc=excluded.person_enc, person_keys=excluded.person_keys, needs_pin=excluded.needs_pin, verified=excluded.verified, turns=excluded.turns, dialect=excluded.dialect`)
      .run(c.callId, getKeys().encrypt("ivr-call-phone", c.phone), c.state, c.category ?? null, c.referenceId ?? null, c.lastRef ?? null,
        c.adults ? getKeys().encrypt("ivr-call-person", JSON.stringify(c.adults)) : null, c.personId ? getKeys().encrypt("ivr-call-person", c.personId) : null,
        keysOf(c), c.needsPin ? 1 : 0, c.verified ? 1 : 0, c.turns, c.createdAt, c.createdAt + callTtlMs(), c.dialect ?? null);
  },
  delete(callId) { db().prepare("DELETE FROM ivr_call WHERE call_id=?").run(callId); },
  prune(nowMs) { return Number(db().prepare("DELETE FROM ivr_call WHERE expires_at<=?").run(nowMs).changes); },
};

/** Drop expired rows (called by the issues sweep, so abandoned calls do not linger). */
export function pruneIvrCalls(nowMs = Date.now()): number { return sqliteCallStore.prune(nowMs); }

registerStoreErasureHook("issues", "channels.ivr_call", (subjects) => {
  for (const p of subjects) db().prepare("DELETE FROM ivr_call WHERE person_keys LIKE ?").run(`% ${p} %`);
});
