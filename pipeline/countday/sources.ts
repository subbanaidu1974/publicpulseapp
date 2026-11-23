/**
 * Pluggable results sources (S-41). NONE of these scrapes ECI, CEO or any results site; the user has not authorised scraping and
 * the terms/robots of those sites are unverified (docs/GAP_AUDIT.md). All four are unverified against any real feed.
 *
 *  FixtureSource       SYNTHETIC generator for tests and demos. Every name says SYNTHETIC; batches carry synthetic: true.
 *  FileDropSource      an operator places a licensed/official feed file (neutral JSON or CSV, see docs/COUNT_DAY.md) in a directory.
 *  TcpdDelayedSource   the existing TCPD/in-rolls snapshot (data/generated/elections.json): DELAYED, post-count only, final declared seats.
 *  HttpSource          stub with config and NO default URL; speaks the neutral JSON schema only.
 */
import fs from "node:fs";
import path from "node:path";
import type { CandidateResult } from "../../src/lib/elections";
import type { FeedAc, FeedBatch, ResultsSource } from "./types";
import { validateBatch } from "./validate";

/* ---------------- fixture (SYNTHETIC) ---------------- */

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export interface FixtureOpts {
  state: string;
  acCount?: number;
  /** Rounds per seat. */
  totalRounds?: number;
  /** Progress step: at step s, seat i has counted max(0, s - i%5) rounds. Use Infinity for "everything declared". */
  step?: number;
  seed?: number;
  electionType?: "assembly" | "ls";
  year?: number;
  /** Test hook: at this step, restate seat 1 downward with a correction (an anomaly that needs two-person review). */
  correctionAtStep?: number;
  /** Fixed asOf (otherwise `now`). */
  asOf?: string;
}
export class FixtureSource implements ResultsSource {
  id = "synthetic-fixture"; kind = "fixture" as const; label = "SYNTHETIC count-day generator (test/demo only)";
  step: number;
  constructor(private o: FixtureOpts) { this.step = o.step ?? 1; }
  advance(by = 1) { this.step += by; }
  async fetch(now: Date): Promise<FeedBatch> {
    const o = this.o, n = o.acCount ?? 12, total = o.totalRounds ?? 6, rand = rng(o.seed ?? 7);
    const acs: FeedAc[] = [];
    for (let i = 0; i < n; i++) {
      const finals = [0, 1, 2].map(() => Math.floor(40000 + rand() * 60000));
      const valid = finals.reduce((a, b) => a + b, 0) + Math.floor(rand() * 3000);
      const rounds = Math.max(0, Math.min(total, Math.floor(this.step) - (i % 5)));
      const status = rounds === 0 ? "not_started" : rounds >= total ? "declared" : "counting";
      const frac = rounds / total;
      let candidates = finals.map((f, j) => ({ candidate: `SYNTHETIC Candidate ${i + 1}${"ABC"[j]}`, party: `SYN-P${j + 1}`, votes: Math.floor(f * frac) }));
      let correction: FeedAc["correction"] = null;
      if (o.correctionAtStep !== undefined && this.step >= o.correctionAtStep && i === 0 && rounds > 1) {
        candidates = candidates.map((c, j) => (j === 0 ? { ...c, votes: Math.max(0, c.votes - 500) } : c));
        correction = { reason: "SYNTHETIC restatement of round tally" };
      }
      acs.push({ acNo: i + 1, acName: `SYNTHETIC AC ${i + 1}`, status, round: rounds, totalRounds: total, validVotes: Math.floor(valid * frac) + (rounds ? 0 : 0), candidates, correction });
    }
    return { schema: 1, sourceId: this.id, sourceKind: "fixture", synthetic: true, state: o.state, electionType: o.electionType ?? "assembly", year: o.year ?? 2099, asOf: o.asOf ?? now.toISOString(), acs };
  }
}

/* ---------------- file drop ---------------- */

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}

export const CSV_COLUMNS = ["state", "election_type", "year", "ac_no", "ac_name", "round", "total_rounds", "status", "candidate", "party", "votes", "valid_votes", "as_of", "source_id", "correction_reason"] as const;

/** One row per candidate per AC (cumulative votes after `round`). Rows of the same AC must agree on round, status and totals. */
export function csvToBatch(text: string, kind: "file-drop" | "http" = "file-drop"): FeedBatch {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV has no data rows");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  for (const need of ["state", "election_type", "year", "ac_no", "ac_name", "round", "status", "candidate", "party", "votes", "as_of", "source_id"]) if (!head.includes(need)) throw new Error(`CSV column missing: ${need}`);
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();
  const num = (s: string) => (s === "" ? null : Number(s));
  const byAc = new Map<number, FeedAc>();
  let first: string[] | null = null;
  for (const r of rows.slice(1)) {
    first ??= r;
    const no = Number(col(r, "ac_no"));
    let ac = byAc.get(no);
    if (!ac) {
      const reason = col(r, "correction_reason");
      ac = { acNo: no, acName: col(r, "ac_name"), status: col(r, "status") as FeedAc["status"], round: Number(col(r, "round")), totalRounds: num(col(r, "total_rounds")), validVotes: num(col(r, "valid_votes")), candidates: [], correction: reason ? { reason } : null };
      byAc.set(no, ac);
    }
    ac.candidates.push({ candidate: col(r, "candidate"), party: col(r, "party"), votes: Number(col(r, "votes")) });
  }
  const f = first!;
  const asOfRaw = col(f, "as_of");
  return { schema: 1, sourceId: col(f, "source_id"), sourceKind: kind, synthetic: false, state: col(f, "state").toUpperCase(), electionType: col(f, "election_type") as "assembly" | "ls", year: Number(col(f, "year")), asOf: asOfRaw ? new Date(asOfRaw).toISOString() : "", acs: [...byAc.values()] };
}

export class FileDropSource implements ResultsSource {
  id: string; kind = "file-drop" as const; label: string;
  /** `target` is a directory (the lexicographically last *.json / *.csv wins: name files feed-<ISO time>.json) or a single file. */
  constructor(private target: string, id = "file-drop") { this.id = id; this.label = `operator file drop (${path.basename(target)})`; }
  private pick(): string {
    const st = fs.statSync(this.target);
    if (st.isFile()) return this.target;
    const files = fs.readdirSync(this.target).filter((f) => /\.(json|csv)$/i.test(f)).sort();
    if (!files.length) throw new Error("file drop is empty");
    return path.join(this.target, files[files.length - 1]);
  }
  async fetch(): Promise<FeedBatch> {
    const file = this.pick();
    if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error("feed file larger than 25 MB");
    const text = fs.readFileSync(file, "utf8");
    const raw = /\.csv$/i.test(file) ? csvToBatch(text) : JSON.parse(text);
    if (raw && typeof raw === "object") { (raw as FeedBatch).sourceKind = "file-drop"; (raw as FeedBatch).synthetic = (raw as FeedBatch).synthetic === true; }
    const v = validateBatch(raw);
    if (!v.ok) throw new Error("feed file invalid: " + v.errors.slice(0, 5).join("; "));
    return v.batch;
  }
}

/* ---------------- TCPD delayed fallback ---------------- */

export interface TcpdOpts { elections: CandidateResult[]; state: string; year: number; electionType: "assembly" | "ls"; asOf: string; notBefore?: Date }
export class TcpdDelayedSource implements ResultsSource {
  id = "tcpd-delayed"; kind = "tcpd-delayed" as const; label = "TCPD / in-rolls archive (delayed, post-count only)";
  constructor(private o: TcpdOpts) {}
  async fetch(now: Date): Promise<FeedBatch> {
    const { elections, state, year, electionType } = this.o;
    if (this.o.notBefore && now < this.o.notBefore) throw new Error("the delayed archive is post-count only and the count has not ended");
    const rows = elections.filter((r) => r.state === state && r.year === year && r.type === electionType && r.provenance !== "demo");
    if (!rows.length) throw new Error(`no archive rows for ${state} ${electionType} ${year}`);
    const by = new Map<number, CandidateResult[]>();
    for (const r of rows) by.set(r.acNo, [...(by.get(r.acNo) ?? []), r]);
    const acs: FeedAc[] = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([acNo, rs]) => ({
      acNo, acName: rs[0].acName, status: "declared", round: 1, totalRounds: 1, validVotes: rs[0].validVotes || null,
      candidates: rs.map((r) => ({ candidate: r.candidate, party: r.party, votes: r.votes })), correction: null,
    }));
    return { schema: 1, sourceId: this.id, sourceKind: "tcpd-delayed", synthetic: false, state, electionType, year, asOf: this.o.asOf, acs };
  }
}

/* ---------------- HTTP stub ---------------- */

export interface HttpOpts { url?: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; id?: string }
/** Config only. There is NO default URL: constructing without one throws. Accepts the neutral JSON schema over https (http only for loopback). */
export class HttpSource implements ResultsSource {
  id: string; kind = "http" as const; label: string;
  private url: URL;
  constructor(private o: HttpOpts) {
    if (!o.url) throw new Error("HttpSource needs an explicit url (there is no default; set COUNTDAY_HTTP_URL to a feed you are licensed to use)");
    this.url = new URL(o.url);
    const loop = ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname);
    if (this.url.protocol !== "https:" && !(loop && this.url.protocol === "http:")) throw new Error("HttpSource requires https");
    this.id = o.id ?? "http-feed"; this.label = `HTTP feed (${this.url.host})`;
  }
  async fetch(): Promise<FeedBatch> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(this.url, { headers: { accept: "application/json", ...(this.o.headers ?? {}) }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000), redirect: "error" });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    const text = await res.text();
    if (text.length > (this.o.maxBytes ?? 25 * 1024 * 1024)) throw new Error("feed response too large");
    const raw = JSON.parse(text) as FeedBatch;
    if (raw && typeof raw === "object") { raw.sourceKind = "http"; raw.synthetic = raw.synthetic === true; }
    const v = validateBatch(raw);
    if (!v.ok) throw new Error("feed invalid: " + v.errors.slice(0, 5).join("; "));
    return v.batch;
  }
}
