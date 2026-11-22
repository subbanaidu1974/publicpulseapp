/**
 * Number-intelligence contract v2 (S-62, E2E-77). Installed with identity's `setNumberIntelligence`; the report is a SUPERSET of the
 * existing `NumberIntel { recently_reissued, voip }`, so identity keeps working unchanged and can adopt the richer fields later.
 *
 *   NumberIntelTransport   what a vendor adapter implements: one raw lookup (throws ProviderError).
 *   ManagedNumberIntel     vendor-independent: risk classification, TTL cache keyed by the phone hash, circuit breaker, timeout, the
 *                          FAILURE POLICY, hashed logging.
 *   HttpNumberIntel        ManagedNumberIntel over the neutral JSON shape (CIVIC_NUMINTEL_URL).
 *
 * FAILURE POLICY (never blocks sign-up, never leaks): a timeout, error, open circuit or malformed answer yields
 *   { risk: "unknown", trust: "reduced", recently_reissued: false, voip: false, source: "unknown" }.
 * Sign-up proceeds; `trust: "reduced"` tells callers to weigh the number less (e.g. fewer caps). Unknown results are cached only briefly.
 *
 * PRIVACY: the only personal datum sent is the E.164 number, over TLS (https enforced in production), alone: no person id, IP, device or
 * session. It is never logged; logs carry a short keyed hash. The cache is keyed by the keyed phone hash and holds no number.
 *
 * NEUTRAL SHAPE   POST CIVIC_NUMINTEL_URL   (HMAC headers as in sms.ts; secret CIVIC_NUMINTEL_SECRET)
 *   { "version": 1, "msisdn": "+91XXXXXXXXXX", "request_id": "<random>" }
 *   -> { "line_type": "mobile_prepaid|mobile_postpaid|voip|landline|unknown", "recycled": bool, "ported_recently": bool,
 *        "carrier_circle": "AP|TS|..."|null, "activation_age_days": number|null, "activation_confidence": 0..1|null }
 */
import crypto from "node:crypto";
import { getKeys } from "../core";
import type { NumberIntel, NumberIntelligence } from "../identity/service";
import { CircuitBreaker, ProviderError, assertSecureUrl, postJson, providerLog, type FetchLike } from "./util";

export type LineType = "mobile_prepaid" | "mobile_postpaid" | "voip" | "landline" | "unknown";
export type RiskClass = "low" | "medium" | "high" | "unknown";

/** Raw, vendor-neutral facts a transport returns. Unknown facts are null. */
export interface RawNumberFacts {
  lineType: LineType; recycled: boolean | null; portedRecently: boolean | null; carrierCircle: string | null;
  activationAgeDays: number | null; activationConfidence: number | null;
}
export interface NumberIntelTransport { readonly name: string; lookup(req: { msisdn: string; requestId: string }, ctx: { timeoutMs: number }): Promise<RawNumberFacts> }

export interface NumberIntelReport extends NumberIntel {
  lineType: LineType; recycled: boolean; portedRecently: boolean; carrierCircle: string | null;
  activationAgeDays: number | null;
  /** 0..1: how far to believe `activationAgeDays` (0 when unknown). */
  activationConfidence: number;
  risk: RiskClass;
  /** "reduced" when the lookup failed or the facts are too thin to rely on. */
  trust: "normal" | "reduced";
  source: "vendor" | "cache" | "unknown";
}
export interface NumberIntelligenceV2 extends NumberIntelligence { readonly contract: 2; lookup(e164: string): Promise<NumberIntelReport> }

export const UNKNOWN_REPORT: NumberIntelReport = Object.freeze({
  recently_reissued: false, voip: false, lineType: "unknown", recycled: false, portedRecently: false, carrierCircle: null,
  activationAgeDays: null, activationConfidence: 0, risk: "unknown", trust: "reduced", source: "unknown",
}) as NumberIntelReport;

/** Pure classification. Documented in docs/PROVIDERS.md; vendors differ only in how they fill RawNumberFacts. */
export function classifyNumber(f: RawNumberFacts): Omit<NumberIntelReport, "source"> {
  const known = f.lineType !== "unknown" || f.recycled !== null || f.portedRecently !== null || f.activationAgeDays !== null;
  const voip = f.lineType === "voip", recycled = f.recycled === true, ported = f.portedRecently === true;
  const young = f.activationAgeDays !== null && f.activationAgeDays < 30;
  const conf = f.activationAgeDays === null ? 0 : Math.min(1, Math.max(0, f.activationConfidence ?? 0));
  let risk: RiskClass;
  if (!known) risk = "unknown";
  else if (voip || recycled) risk = "high";
  else if (ported || (young && f.lineType === "mobile_prepaid" && conf >= 0.5) || f.lineType === "landline") risk = "medium";
  else risk = "low";
  return {
    recently_reissued: recycled, voip, lineType: f.lineType, recycled, portedRecently: ported, carrierCircle: f.carrierCircle,
    activationAgeDays: f.activationAgeDays, activationConfidence: conf, risk, trust: known ? "normal" : "reduced",
  };
}

export interface ManagedIntelOpts {
  timeoutMs?: number; cacheTtlMs?: number; unknownTtlMs?: number; cacheMax?: number; breaker?: CircuitBreaker; now?: () => number;
}

export class ManagedNumberIntel implements NumberIntelligenceV2 {
  readonly contract = 2 as const;
  readonly breaker: CircuitBreaker;
  private cache = new Map<string, { at: number; ttl: number; report: NumberIntelReport }>();
  private inflight = new Map<string, Promise<NumberIntelReport>>();
  constructor(readonly transport: NumberIntelTransport, private o: ManagedIntelOpts = {}) { this.breaker = o.breaker ?? new CircuitBreaker(5, 30_000, () => this.now()); }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  /** Never throws; see the failure policy in the file header. */
  async lookup(e164: string): Promise<NumberIntelReport> {
    const hash = getKeys().hmac("phone", e164);
    const hit = this.cache.get(hash);
    if (hit && this.now() - hit.at < hit.ttl) return { ...hit.report, source: "cache" };
    const running = this.inflight.get(hash);
    if (running) return running; // one vendor call per number at a time
    const p = this.fetch(e164, hash).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, p);
    return p;
  }

  private async fetch(e164: string, hash: string): Promise<NumberIntelReport> {
    const timeoutMs = this.o.timeoutMs ?? 2000, tag = hash.slice(0, 10);
    try {
      if (!this.breaker.allow()) throw new ProviderError("circuit open", "circuit_open");
      let t: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ProviderError("number intelligence deadline", "timeout")), timeoutMs + 250); });
      const facts = await Promise.race([this.transport.lookup({ msisdn: e164, requestId: crypto.randomBytes(8).toString("hex") }, { timeoutMs }), deadline]).finally(() => clearTimeout(t));
      if (!validFacts(facts)) throw new ProviderError("vendor facts malformed", "bad_response");
      this.breaker.success();
      const report: NumberIntelReport = { ...classifyNumber(facts), source: "vendor" };
      this.put(hash, report, report.trust === "reduced" ? (this.o.unknownTtlMs ?? 30_000) : (this.o.cacheTtlMs ?? 24 * 3_600_000));
      return report;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("lookup failed", "network");
      if (pe.kind !== "circuit_open") this.breaker.failure();
      providerLog("numberintel", "lookup_failed", { who: tag, kind: pe.kind, status: pe.status }); // hashed id only
      this.put(hash, UNKNOWN_REPORT, this.o.unknownTtlMs ?? 30_000);
      return { ...UNKNOWN_REPORT };
    }
  }
  private put(hash: string, report: NumberIntelReport, ttl: number): void {
    const max = this.o.cacheMax ?? 50_000;
    if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value as string); // oldest first
    this.cache.set(hash, { at: this.now(), ttl, report });
  }
  /** Drop every cached verdict (key rotation changes the cache key: call after rotating "phone"). */
  clearCache(): void { this.cache.clear(); }
  cacheSize(): number { return this.cache.size; }
}

function validFacts(f: unknown): f is RawNumberFacts {
  const x = f as RawNumberFacts | null;
  return !!x && typeof x === "object" && ["mobile_prepaid", "mobile_postpaid", "voip", "landline", "unknown"].includes(x.lineType)
    && (x.recycled === null || typeof x.recycled === "boolean") && (x.portedRecently === null || typeof x.portedRecently === "boolean")
    && (x.activationAgeDays === null || (typeof x.activationAgeDays === "number" && x.activationAgeDays >= 0))
    && (x.activationConfidence === null || (typeof x.activationConfidence === "number" && x.activationConfidence >= 0 && x.activationConfidence <= 1))
    && (x.carrierCircle === null || typeof x.carrierCircle === "string");
}

// --- neutral HTTP -----------------------------------------------------------------------------------------------------------------

export interface HttpIntelOpts extends ManagedIntelOpts { url: string; secret: string; fetchImpl?: FetchLike }

export class HttpNumberIntelTransport implements NumberIntelTransport {
  readonly name = "http";
  constructor(private c: HttpIntelOpts) { assertSecureUrl(c.url, "CIVIC_NUMINTEL_URL"); if (!c.secret) throw new ProviderError("CIVIC_NUMINTEL_SECRET is required", "config"); }
  async lookup(req: { msisdn: string; requestId: string }, ctx: { timeoutMs: number }): Promise<RawNumberFacts> {
    const r = await postJson<Record<string, unknown>>(this.c.url, { version: 1, msisdn: req.msisdn, request_id: req.requestId }, { secret: this.c.secret, timeoutMs: ctx.timeoutMs, fetchImpl: this.c.fetchImpl, now: this.c.now });
    const nb = (v: unknown) => (typeof v === "boolean" ? v : null), nn = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      lineType: (typeof r.line_type === "string" ? r.line_type : "unknown") as LineType, recycled: nb(r.recycled), portedRecently: nb(r.ported_recently),
      carrierCircle: typeof r.carrier_circle === "string" ? r.carrier_circle : null, activationAgeDays: nn(r.activation_age_days), activationConfidence: nn(r.activation_confidence),
    };
  }
}
export class HttpNumberIntel extends ManagedNumberIntel {
  constructor(opts: HttpIntelOpts) { super(new HttpNumberIntelTransport(opts), opts); }
}
