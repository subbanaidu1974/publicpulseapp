import type { AcView, CountStatus, FeedAc, FeedBatch, FeedCandidate, SeatLabel, SourceKind } from "./types";

const KINDS: SourceKind[] = ["fixture", "file-drop", "tcpd-delayed", "http"];
const STATUSES: CountStatus[] = ["not_started", "counting", "declared"];
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export const LIMITS = { maxAcs: 600, maxCandidates: 60 };

/** Structural validation of a whole batch. A batch with any error here is rejected outright. Per-AC consistency is checkAc(). */
export function validateBatch(raw: unknown): { ok: boolean; batch?: FeedBatch; errors?: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["batch must be an object"] };
  const b = raw as Record<string, unknown>;
  if (b.schema !== 1) errors.push("schema must be 1");
  if (!str(b.sourceId, 80)) errors.push("sourceId required");
  if (!KINDS.includes(b.sourceKind as SourceKind)) errors.push("sourceKind invalid");
  if (typeof b.synthetic !== "boolean") errors.push("synthetic must be a boolean");
  if (b.sourceKind === "fixture" && b.synthetic !== true) errors.push("fixture batches must be marked synthetic");
  if (!str(b.state, 4)) errors.push("state required");
  if (b.electionType !== "assembly" && b.electionType !== "ls") errors.push("electionType must be assembly or ls");
  if (!isInt(b.year) || (b.year as number) < 1950 || (b.year as number) > 2100) errors.push("year invalid");
  if (typeof b.asOf !== "string" || !Number.isFinite(Date.parse(b.asOf))) errors.push("asOf must be an ISO instant");
  if (!Array.isArray(b.acs)) errors.push("acs must be an array");
  else if (b.acs.length > LIMITS.maxAcs) errors.push("too many acs");
  else {
    const seen = new Set<number>();
    b.acs.forEach((a, i) => {
      const p = `acs[${i}]`;
      if (!a || typeof a !== "object") { errors.push(`${p} must be an object`); return; }
      const ac = a as Record<string, unknown>;
      if (!isInt(ac.acNo) || (ac.acNo as number) < 1) errors.push(`${p}.acNo invalid`);
      else if (seen.has(ac.acNo as number)) errors.push(`${p}.acNo ${ac.acNo} duplicated`); else seen.add(ac.acNo as number);
      if (!str(ac.acName, 120)) errors.push(`${p}.acName required`);
      if (!STATUSES.includes(ac.status as CountStatus)) errors.push(`${p}.status invalid`);
      if (!isInt(ac.round) || (ac.round as number) < 0) errors.push(`${p}.round invalid`);
      if (ac.totalRounds !== null && ac.totalRounds !== undefined && (!isInt(ac.totalRounds) || (ac.totalRounds as number) < 1)) errors.push(`${p}.totalRounds invalid`);
      if (ac.validVotes !== null && ac.validVotes !== undefined && (!isInt(ac.validVotes) || (ac.validVotes as number) < 0)) errors.push(`${p}.validVotes invalid`);
      if (!Array.isArray(ac.candidates) || ac.candidates.length > LIMITS.maxCandidates) errors.push(`${p}.candidates invalid`);
      else (ac.candidates as unknown[]).forEach((c, j) => {
        const cc = c as Record<string, unknown> | null;
        if (!cc || !str(cc.candidate, 120) || typeof cc.party !== "string" || cc.party.length > 80 || !isInt(cc.votes) || (cc.votes as number) < 0) errors.push(`${p}.candidates[${j}] invalid (name, party, non-negative integer votes)`);
      });
      if (ac.correction !== null && ac.correction !== undefined && (typeof ac.correction !== "object" || typeof (ac.correction as { reason?: unknown }).reason !== "string")) errors.push(`${p}.correction must be {reason}`);
    });
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 30) };
  const batch = b as unknown as FeedBatch;
  return { ok: true, batch: { ...batch, acs: batch.acs.map((a) => ({ ...a, totalRounds: a.totalRounds ?? null, validVotes: a.validVotes ?? null, correction: a.correction ?? null })) } };
}

const ck = (c: FeedCandidate) => `${c.candidate}|${c.party}`;
const RANK: Record<CountStatus, number> = { not_started: 0, counting: 1, declared: 2 };
export const sumVotes = (cs: FeedCandidate[]) => cs.reduce((s, c) => s + c.votes, 0);

export interface AcCheck { invalid: string[]; anomalies: string[] }

/**
 * Per-seat consistency against the last PUBLISHED view of that seat.
 *  invalid   - cannot be published and cannot be approved (the feed must be corrected): vote sum above valid votes, a round or a candidate's votes going
 *              down without a flagged correction, a correction without a reason, counted votes on a seat that has not started.
 *  anomalies - plausible but surprising: held back from publication until two different admins approve.
 */
export function checkAc(prev: AcView | undefined, ac: FeedAc): AcCheck {
  const invalid: string[] = [], anomalies: string[] = [];
  const total = sumVotes(ac.candidates);
  if (ac.validVotes != null && total > ac.validVotes) invalid.push(`votes_exceed_valid:${total}>${ac.validVotes}`);
  if (ac.status === "not_started" && (total > 0 || ac.round > 0)) invalid.push("votes_on_not_started");
  if (ac.status === "counting" && ac.round < 1) invalid.push("counting_without_round");
  if (ac.status === "declared" && total === 0) invalid.push("declared_without_votes");
  if (ac.totalRounds != null && ac.round > ac.totalRounds) invalid.push("round_above_total");
  const corr = ac.correction;
  if (corr && !corr.reason.trim()) invalid.push("correction_without_reason");
  if (corr && corr.reason.trim()) anomalies.push("correction");
  if (ac.status === "declared" && ac.totalRounds != null && ac.round < ac.totalRounds) anomalies.push("declared_early");
  if (prev) {
    const hasCorrection = !!(corr && corr.reason.trim());
    if (ac.round < prev.round && !hasCorrection) invalid.push(`round_decreased:${prev.round}>${ac.round}`);
    const now = new Map(ac.candidates.map((c) => [ck(c), c.votes]));
    for (const p of prev.candidates) {
      const v = now.get(ck(p));
      if (v === undefined) { if (prev.round > 0) anomalies.push(`candidate_removed:${p.candidate}`); continue; }
      if (v < p.votes && !hasCorrection) invalid.push(`votes_decreased:${p.candidate}:${p.votes}>${v}`);
    }
    const had = new Set(prev.candidates.map(ck));
    if (prev.round > 0) for (const c of ac.candidates) if (!had.has(ck(c))) anomalies.push(`candidate_added:${c.candidate}`);
    if (RANK[ac.status] < RANK[prev.status]) anomalies.push(`status_regress:${prev.status}>${ac.status}`);
    if (prev.status === "declared" && ac.status === "declared") {
      const same = prev.candidates.length === ac.candidates.length && prev.candidates.every((p) => now.get(ck(p)) === p.votes);
      if (!same) anomalies.push("declared_changed");
    }
  }
  return { invalid, anomalies: [...new Set(anomalies)] };
}

/** Seat label. "won" requires status === "declared"; a partial count is never "won". */
export function labelFor(status: CountStatus, candidates: FeedCandidate[]): { label: SeatLabel; leader: AcView["leader"]; margin: number | null } {
  const sorted = [...candidates].sort((a, b) => b.votes - a.votes || a.candidate.localeCompare(b.candidate));
  const top = sorted[0];
  if (status === "not_started" || !top || top.votes <= 0) return { label: "not_started", leader: null, margin: null };
  const margin = sorted.length > 1 ? top.votes - sorted[1].votes : top.votes;
  const leader = { candidate: top.candidate, party: top.party, votes: top.votes };
  if (status === "declared") return { label: "won", leader, margin };
  return { label: margin === 0 ? "tied" : "leading", leader: margin === 0 ? null : leader, margin };
}

export function toAcView(ac: FeedAc, asOf: string, underReview = false): AcView {
  const l = labelFor(ac.status, ac.candidates);
  const candidates = [...ac.candidates].sort((a, b) => b.votes - a.votes || a.candidate.localeCompare(b.candidate)).map((c) => ({ candidate: c.candidate, party: c.party, votes: c.votes }));
  return {
    acNo: ac.acNo, acName: ac.acName, status: ac.status, label: l.label, round: ac.round, totalRounds: ac.totalRounds ?? null,
    validVotes: ac.validVotes ?? null, totalVotes: sumVotes(ac.candidates), leader: l.leader, margin: l.margin, candidates, underReview, asOf,
  };
}
