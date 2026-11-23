/**
 * Snapshot pipeline (S-41). Runs OUTSIDE the web server (scripts/countday-ingest.ts): fetch from a ResultsSource, validate against the last
 * published state, hold anomalies for two-person review, then write immutable signed static files:
 *
 *   <dir>/keys.json
 *   <dir>/<ST>/snapshots/<seq>.json   envelope {body, sha256, signature}, never rewritten (written with the exclusive flag)
 *   <dir>/<ST>/ac/<n>.json            latest per-seat envelope (references the snapshot seq and hash)
 *   <dir>/<ST>/latest.json            copy of the newest snapshot envelope (the only mutable pointer, with index.json)
 *   <dir>/<ST>/index.json             hash-chained index, head signed
 *   <dir>/<ST>/status.json            advisory source health (unsigned)
 *   <dir>/<ST>/review/pending.json    ingest-owned; review/decisions.json is server-owned (no shared writer)
 */
import fs from "node:fs";
import path from "node:path";
import { canonical, sha256Hex } from "./canonical";
import type {
  AcBody, AcLink, AcView, DelayLabel, Envelope, FeedAc, FeedBatch, IndexBody, IndexEntry, IndexFile, KeysFile, ResultsSource, Signer, SnapshotBody,
} from "./types";
import { NOTICE_DELAYED, NOTICE_LIVE, NOTICE_SYNTHETIC } from "./types";
import { checkAc, toAcView, validateBatch } from "./validate";

export const APPROVALS_NEEDED = 2;

export interface PendingItem {
  id: string; acNo: number; kind: "anomaly" | "invalid"; reasons: string[]; firstSeen: string; asOf: string; proposed: FeedAc; previous: AcView | null;
}
export interface Decision { approvals: { person: string; at: string; note?: string }[]; rejections: { person: string; at: string; note?: string }[] }
export type Decisions = Record<string, Decision>;

export const stateDir = (dir: string, st: string) => path.join(dir, st.toUpperCase());
export function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; } }
/** Atomic replace (temp file + rename). */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}

export interface IngestConfig { links?: AcLink[]; approvalsNeeded?: number }
export interface IngestResult {
  published: boolean; seq: number | null; reason: "published" | "unchanged" | "source_down" | "batch_rejected" | "mismatch";
  held: { acNo: number; kind: "anomaly" | "invalid"; reasons: string[] }[]; errors: string[]; usedFallback: boolean;
}

export function loadIndex(dir: string, st: string): IndexFile | null { return readJson<IndexFile>(path.join(stateDir(dir, st), "index.json")); }
export function loadLatest(dir: string, st: string): Envelope<SnapshotBody> | null { return readJson<Envelope<SnapshotBody>>(path.join(stateDir(dir, st), "latest.json")); }

export function recordKey(dir: string, signer: Signer, now: Date): void {
  const file = path.join(dir, "keys.json");
  const cur = readJson<KeysFile>(file) ?? { schema: 1, algorithm: "ed25519", keys: [], note: "Public verification keys. Pin the key id out of band; this file is a convenience, not a trust anchor." };
  if (cur.keys.some((k) => k.keyId === signer.keyId)) return;
  cur.keys.push({ keyId: signer.keyId, alg: "ed25519", x: signer.publicKey, addedAt: now.toISOString() });
  writeAtomic(file, JSON.stringify(cur, null, 2));
}

function sign<T>(body: T, signer: Signer): Envelope<T> {
  const sha = sha256Hex(canonical(body));
  return { body, sha256: sha, signature: { alg: "ed25519", keyId: signer.keyId, value: signer.sign(Buffer.from(sha, "utf8")) } };
}
/** What is signed: the hex sha256 of the canonical body, as UTF-8 text. */
export const signedBytes = (sha: string) => Buffer.from(sha, "utf8");

function delayLabelOf(b: FeedBatch, fallback: boolean): DelayLabel { return b.synthetic ? "synthetic" : fallback || b.sourceKind === "tcpd-delayed" ? "delayed-fallback" : "live"; }

export async function ingestOnce(o: {
  dir: string; state: string; source: ResultsSource; fallback?: ResultsSource | null; signer: Signer; now?: Date; config?: IngestConfig;
}): Promise<IngestResult> {
  const now = o.now ?? new Date(), st = o.state.toUpperCase(), sd = stateDir(o.dir, st), cfg = o.config ?? {};
  const need = Math.max(APPROVALS_NEEDED, cfg.approvalsNeeded ?? APPROVALS_NEEDED);
  const statusFile = path.join(sd, "status.json");
  const status = readJson<Record<string, unknown>>(statusFile) ?? {};
  const fail = (reason: IngestResult["reason"], errors: string[], usedFallback = false): IngestResult => {
    writeAtomic(statusFile, JSON.stringify({ ...status, lastAttemptAt: now.toISOString(), lastError: errors[0] ?? reason, consecutiveFailures: Number(status.consecutiveFailures ?? 0) + 1 }, null, 2));
    return { published: false, seq: null, reason, held: [], errors, usedFallback };
  };

  let raw: unknown, usedFallback = false;
  const errs: string[] = [];
  try { raw = await o.source.fetch(now); } catch (e) {
    errs.push(`${o.source.id}: ${(e as Error).message}`);
    if (o.fallback) { try { raw = await o.fallback.fetch(now); usedFallback = true; } catch (e2) { errs.push(`${o.fallback.id}: ${(e2 as Error).message}`); } }
  }
  if (raw === undefined) return fail("source_down", errs);
  const v = validateBatch(raw);
  if (!v.ok) return fail("batch_rejected", v.errors, usedFallback);
  const batch = v.batch;
  if (batch.state.toUpperCase() !== st) return fail("mismatch", [`batch is for ${batch.state}, expected ${st}`], usedFallback);

  const prevEnv = loadLatest(o.dir, st);
  const prev = prevEnv?.body ?? null;
  if (prev && (prev.year !== batch.year || prev.electionType !== batch.electionType)) return fail("mismatch", ["batch is for a different election than the published chain"], usedFallback);
  if (prev && Date.parse(batch.asOf) < Date.parse(prev.asOf)) return fail("batch_rejected", [`batch asOf ${batch.asOf} is older than the published ${prev.asOf}`], usedFallback);

  const prevAcs = new Map<number, AcView>((prev?.acs ?? []).map((a) => [a.acNo, a]));
  const decisions = readJson<Decisions>(path.join(sd, "review", "decisions.json")) ?? {};
  const pendingFile = path.join(sd, "review", "pending.json");
  const oldPending = readJson<Record<string, PendingItem>>(pendingFile) ?? {};
  const pending: Record<string, PendingItem> = {};
  const held: IngestResult["held"] = [];
  const next = new Map(prevAcs);
  const reviewing = new Set<number>();

  for (const ac of batch.acs) {
    const chk = checkAc(prevAcs.get(ac.acNo), ac);
    const same = prevAcs.get(ac.acNo) && canonical(toAcView(ac, prevAcs.get(ac.acNo)!.asOf, false)) === canonical({ ...prevAcs.get(ac.acNo)!, underReview: false });
    if (same) continue;
    const reasons = [...chk.invalid, ...chk.anomalies];
    if (!reasons.length) { next.set(ac.acNo, toAcView(ac, batch.asOf)); continue; }
    const id = sha256Hex(canonical({ st, acNo: ac.acNo, reasons, ac })).slice(0, 16);
    if (chk.invalid.length === 0) {
      const d = decisions[id];
      if (d && d.rejections.length) continue; // rejected: keep the previous view, do not re-queue
      if (d && new Set(d.approvals.map((a) => a.person)).size >= need) { next.set(ac.acNo, toAcView(ac, batch.asOf)); continue; }
    }
    reviewing.add(ac.acNo);
    const kind = chk.invalid.length ? "invalid" : "anomaly";
    pending[id] = oldPending[id] ?? { id, acNo: ac.acNo, kind, reasons, firstSeen: now.toISOString(), asOf: batch.asOf, proposed: ac, previous: prevAcs.get(ac.acNo) ?? null };
    held.push({ acNo: ac.acNo, kind, reasons });
  }
  if (Object.keys(pending).length || Object.keys(oldPending).length) writeAtomic(pendingFile, JSON.stringify(pending, null, 2));

  const label = delayLabelOf(batch, usedFallback);
  // A fallback batch may only be published as delayed-fallback; it can never lower anything because checkAc() already ran above.
  const acs = [...next.values()].map((a) => ({ ...a, underReview: reviewing.has(a.acNo) })).sort((a, b) => a.acNo - b.acNo);
  const sig = (a: AcView[]) => sha256Hex(canonical(a));
  const unchanged = prev && sig(prev.acs) === sig(acs) && prev.delayLabel === label && prev.sourceId === batch.sourceId;
  writeAtomic(statusFile, JSON.stringify({ lastAttemptAt: now.toISOString(), lastOkAt: now.toISOString(), sourceAsOf: batch.asOf, sourceId: batch.sourceId, consecutiveFailures: 0, lastError: errs[0] ?? null, usedFallback }, null, 2));
  if (unchanged) return { published: false, seq: prev.seq, reason: "unchanged", held, errors: errs, usedFallback };

  const seq = (prev?.seq ?? 0) + 1;
  const tally = (pred: (a: AcView) => boolean) => acs.filter(pred).reduce<Record<string, number>>((m, a) => { if (a.leader) m[a.leader.party] = (m[a.leader.party] ?? 0) + 1; return m; }, {});
  const links = cfg.links ?? [];
  const acHashes: Record<string, string> = {};
  for (const a of acs) acHashes[String(a.acNo)] = sha256Hex(canonical(a));
  const body: SnapshotBody = {
    schema: 1, kind: "countday-snapshot", state: st, seq, asOf: batch.asOf, publishedAt: now.toISOString(), sourceId: batch.sourceId, sourceKind: batch.sourceKind,
    synthetic: batch.synthetic, delayLabel: label, electionType: batch.electionType, year: batch.year, prevHash: prevEnv?.sha256 ?? null,
    summary: {
      total: acs.length, notStarted: acs.filter((a) => a.status === "not_started").length, counting: acs.filter((a) => a.status === "counting").length,
      declared: acs.filter((a) => a.status === "declared").length, underReview: acs.filter((a) => a.underReview).length,
      leading: tally((a) => a.label === "leading"), won: tally((a) => a.label === "won"),
    },
    links, acHashes, acs, notice: batch.synthetic ? NOTICE_SYNTHETIC : label === "live" ? NOTICE_LIVE : NOTICE_DELAYED,
  };
  const env = sign(body, o.signer);
  const text = JSON.stringify(env);
  fs.mkdirSync(path.join(sd, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(sd, "snapshots", `${seq}.json`), text, { flag: "wx" });
  // per-seat files for seats whose view changed in this snapshot
  for (const a of acs) {
    if (prev && prev.acHashes[String(a.acNo)] === acHashes[String(a.acNo)] && fs.existsSync(path.join(sd, "ac", `${a.acNo}.json`))) continue;
    const ab: AcBody = { schema: 1, kind: "countday-ac", state: st, acNo: a.acNo, snapshotSeq: seq, snapshotSha256: env.sha256, asOf: batch.asOf, delayLabel: label, synthetic: batch.synthetic, sourceId: batch.sourceId, acSha256: acHashes[String(a.acNo)], ac: a, links, notice: body.notice };
    writeAtomic(path.join(sd, "ac", `${a.acNo}.json`), JSON.stringify(sign(ab, o.signer)));
  }
  const entry: IndexEntry = { seq, asOf: batch.asOf, publishedAt: body.publishedAt, sha256: env.sha256, prevHash: body.prevHash, bytes: Buffer.byteLength(text), sourceId: batch.sourceId, delayLabel: label, keyId: o.signer.keyId };
  const entries = [...(loadIndex(o.dir, st)?.body.entries ?? []), entry];
  const ib: IndexBody = { schema: 1, kind: "countday-index", state: st, entries, head: { seq, sha256: env.sha256 } };
  writeAtomic(path.join(sd, "index.json"), JSON.stringify(sign(ib, o.signer)));
  writeAtomic(path.join(sd, "latest.json"), text);
  recordKey(o.dir, o.signer, now);
  return { published: true, seq, reason: "published", held, errors: errs, usedFallback };
}
