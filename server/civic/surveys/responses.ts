/**
 * Anonymous survey responses (S-30, DESIGN_2028 3.3): the storage side. Lives in the SURVEY store only; the person-side has_responded
 * row is in the identity store, a different database file with a different set of tables (docs/STORES.md).
 *
 * What a response row is (and is not):
 *   - random UUID primary key (crypto.randomUUID, assigned at flush time), WITHOUT ROWID: no sequence, no insertion order, no rowid
 *   - NO timestamp column of any kind (no created_at / updated_at); no person id, no token, no signature, no hash of either
 *   - only the answers and four coarse strata: age_band, gender, tier (+ quality flag, both SERVER-verified via the key class), mandal code
 *   - assisted (IVR / volunteer-assisted) responses go to a separate table, labelled channel='assisted', platform_linkable=1
 *
 * Batching: a response is first written, encrypted, to `response_journal` (random uuid key, no timestamp) in the SAME transaction that
 * spends its token. Rows move from the journal to the response table in SHUFFLED batches, flushed every CIVIC_SURVEY_FLUSH_MS (random
 * 0.5x..1.5x jitter, default 60 s) or when CIVIC_SURVEY_FLUSH_ITEMS (default 25) are waiting. Because the journal is durable, a crash loses
 * nothing: recoverResponseJournal() (called at start-up and by the jobs runner) flushes whatever is left. The journal is the only place
 * where a response exists before shuffling; it is encrypted at rest with the civic key provider (purpose "survey-credential").
 * Residual risk (stated in docs/SURVEYS.md): SQLite page layout and the WAL file can still leak coarse write order to someone who has the
 * raw files; a database operator with file access is outside the secrecy guarantee anyway.
 */
import crypto from "node:crypto";
import { getKeys, getStore, registerMigration, runInStore } from "../core";
import type { SurveyForResponse } from "./source";

export const AGE_BANDS = ["18-24", "25-34", "35-44", "45-59", "60+"] as const;
export const GENDERS = ["M", "F", "O", "NS"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export type Gender = (typeof GENDERS)[number];
export type Answers = Record<string, string | string[] | number>;
/** `age_band` "NA" only on the assisted channel (the phone flow does not ask); gender "NS" = not stated. */
export interface Strata { age_band: AgeBand | "NA"; gender: Gender; tier: "T1" | "T2"; quality: "normal" | "low"; mandal: string }
export interface ResponseRecord { survey_id: string; answers: Answers; strata: Strata; kind: "app" | "assisted" }

registerMigration("survey_001_responses", `
CREATE TABLE survey_signing_key (
  survey_id TEXT NOT NULL, key_class TEXT NOT NULL CHECK (key_class IN ('T1','T2','T1_LOW','T2_LOW')),
  n_b64 TEXT NOT NULL, e_b64 TEXT NOT NULL, bits INTEGER NOT NULL, d_enc TEXT NOT NULL,
  PRIMARY KEY (survey_id, key_class)
) WITHOUT ROWID;
CREATE TABLE spent_token (
  survey_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  PRIMARY KEY (survey_id, token_hash)
) WITHOUT ROWID;
CREATE TABLE survey_response (
  id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, answers TEXT NOT NULL,
  age_band TEXT NOT NULL, gender TEXT NOT NULL, tier TEXT NOT NULL, quality TEXT NOT NULL, mandal TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE survey_response_assisted (
  id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, answers TEXT NOT NULL,
  age_band TEXT NOT NULL, gender TEXT NOT NULL, tier TEXT NOT NULL, quality TEXT NOT NULL, mandal TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'assisted'), platform_linkable INTEGER NOT NULL CHECK (platform_linkable = 1)
) WITHOUT ROWID;
CREATE TABLE response_journal (
  id TEXT PRIMARY KEY, payload_enc TEXT NOT NULL
) WITHOUT ROWID;
`, "survey");

const PURPOSE = "survey-credential";
const db = () => getStore("survey");

// ---- validation ----
export class ResponseInvalid extends Error { constructor(public detail: string) { super(detail); } }

/** Check answers against the frozen question set; returns the normalised answers or throws ResponseInvalid. */
export function validateAnswers(survey: SurveyForResponse, raw: unknown): Answers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ResponseInvalid("answers must be an object keyed by question id");
  const given = raw as Record<string, unknown>;
  const ids = new Set(survey.questions.map((q) => q.id));
  for (const k of Object.keys(given)) if (!ids.has(k)) throw new ResponseInvalid(`unknown question "${k.slice(0, 40)}"`);
  const out: Answers = {};
  for (const q of survey.questions) {
    const v = given[q.id];
    if (v === undefined || v === null) throw new ResponseInvalid(`question "${q.id}" is not answered`);
    if (q.kind === "single") {
      if (typeof v !== "string" || !q.options.includes(v)) throw new ResponseInvalid(`question "${q.id}": not one of the options`);
      out[q.id] = v;
    } else if (q.kind === "multi") {
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !q.options.includes(x))) throw new ResponseInvalid(`question "${q.id}": choose from the options`);
      const set = [...new Set(v as string[])];
      if (set.length !== v.length) throw new ResponseInvalid(`question "${q.id}": an option was chosen twice`);
      if (q.max_select && set.length > q.max_select) throw new ResponseInvalid(`question "${q.id}": at most ${q.max_select} options`);
      out[q.id] = set.sort();
    } else {
      const okNum = typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
      const okOpt = typeof v === "string" && q.options.includes(v);
      if (!okNum && !okOpt) throw new ResponseInvalid(`question "${q.id}": answer 1 to 5`);
      out[q.id] = v as string | number;
    }
  }
  return out;
}

// ---- shuffled batching writer ----
export interface BatchConfig { flushMs: number; flushItems: number; shuffle: <T>(a: T[]) => T[]; random: () => number; onFlush?: (batch: { id: string; kind: string }[]) => void }
const secureShuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const defaults = (): BatchConfig => ({
  flushMs: Math.max(1, Number(process.env.CIVIC_SURVEY_FLUSH_MS) || 60_000),
  flushItems: Math.max(1, Number(process.env.CIVIC_SURVEY_FLUSH_ITEMS) || 25),
  shuffle: secureShuffle, random: () => crypto.randomInt(1_000_000) / 1_000_000,
});
let cfg: BatchConfig | null = null;
const config = (): BatchConfig => (cfg ??= defaults());
/** Tests: override batching (shuffle, thresholds, an observer of each flushed batch's order). null restores env-driven defaults. */
export function setBatching(o: Partial<BatchConfig> | null): void { cfg = o ? { ...defaults(), ...o } : null; if (timer) { clearTimeout(timer); timer = null; } }

let timer: ReturnType<typeof setTimeout> | null = null;
let waiting = 0;
function armTimer(): void {
  if (timer) return;
  const c = config();
  timer = setTimeout(() => { timer = null; try { flushResponses(); } catch { /* retried by the next enqueue, the next tick or recovery */ } }, Math.round(c.flushMs * (0.5 + c.random())));
  timer.unref?.();
}
/** Stop the flush timer (process shutdown, tests). */
export function stopResponseTimer(): void { if (timer) { clearTimeout(timer); timer = null; } waiting = 0; }

/** The journal INSERT for one response. Callers run it inside their own survey-store transaction (the token spend). */
export function journalInsert(rec: ResponseRecord): void {
  db().prepare("INSERT INTO response_journal (id, payload_enc) VALUES (?, ?)").run(crypto.randomUUID(), getKeys().encrypt(PURPOSE, JSON.stringify(rec)));
}
/** Call AFTER the journalling transaction committed: counts the item and flushes when the batch is big enough, else arms the jittered timer. */
export function afterEnqueue(): void {
  waiting++;
  if (waiting >= config().flushItems) { try { flushResponses(); } catch { armTimer(); } } else armTimer();
}
/** Journal one response in its own transaction (assisted channel, which spends no token). */
export function enqueueResponse(rec: ResponseRecord): void { runInStore("survey", () => journalInsert(rec)); afterEnqueue(); }

/** Move every journalled response into its table, in shuffled order, with fresh random ids. Returns how many moved. */
export function flushResponses(): number {
  const rows = db().prepare("SELECT id, payload_enc FROM response_journal").all() as unknown as { id: string; payload_enc: string }[];
  waiting = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  if (!rows.length) return 0;
  const c = config();
  const recs = c.shuffle(rows.map((r) => ({ jid: r.id, rec: JSON.parse(getKeys().decrypt(PURPOSE, r.payload_enc)) as ResponseRecord })));
  const batch: { id: string; kind: string }[] = [];
  runInStore("survey", () => {
    const ins = db().prepare("INSERT INTO survey_response (id, survey_id, answers, age_band, gender, tier, quality, mandal) VALUES (?,?,?,?,?,?,?,?)");
    const insA = db().prepare("INSERT INTO survey_response_assisted (id, survey_id, answers, age_band, gender, tier, quality, mandal, channel, platform_linkable) VALUES (?,?,?,?,?,?,?,?,'assisted',1)");
    const del = db().prepare("DELETE FROM response_journal WHERE id = ?");
    for (const { jid, rec } of recs) {
      const id = crypto.randomUUID(), s = rec.strata;
      const args = [id, rec.survey_id, JSON.stringify(rec.answers), s.age_band, s.gender, s.tier, s.quality, s.mandal] as const;
      if (rec.kind === "assisted") insA.run(...args); else ins.run(...args);
      del.run(jid);
      batch.push({ id, kind: rec.kind });
    }
  });
  c.onFlush?.(batch);
  return batch.length;
}
/** Start-up / job hook: flush anything a crash left in the journal. */
export const recoverResponseJournal = (): number => flushResponses();
export const pendingResponses = (): number => (db().prepare("SELECT COUNT(*) c FROM response_journal").get() as { c: number }).c;

/** Counts for the results side: [app, assisted] per survey (journalled responses are not counted until flushed). */
export function responseCounts(surveyId: string): { app: number; assisted: number } {
  const c = (t: string) => (db().prepare(`SELECT COUNT(*) c FROM ${t} WHERE survey_id = ?`).get(surveyId) as { c: number }).c;
  return { app: c("survey_response"), assisted: c("survey_response_assisted") };
}
