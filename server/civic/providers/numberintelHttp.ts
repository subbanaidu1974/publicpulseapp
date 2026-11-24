/**
 * Generic HTTP number-intelligence adapter (S-62, E2E-77). One configurable JSON-over-HTTPS lookup: API key in a header, request field
 * names, and a response mapping (dot paths + a line-type value map) onto the contract's RawNumberFacts. The failure policy, caching,
 * breaker and hashed logging come from ManagedNumberIntel unchanged.
 *
 * NOT a specific vendor. It has only been run against the local simulator (./mock/vendorIntelServer.ts). The mapping for any real vendor
 * (e.g. an Indian MNP/number-intelligence provider) MUST be confirmed against that vendor's own documentation and sandbox before use:
 * field names, what "recycled"/"ported" mean there, whether activation age exists at all, error taxonomy, rate limits. See docs/PROVIDERS.md.
 */
import { ManagedNumberIntel, type ManagedIntelOpts, type NumberIntelTransport, type RawNumberFacts } from "./numberintel";
import { ProviderError, assertSecureUrl, postJson, type FetchLike } from "./util";

type LineType = RawNumberFacts["lineType"];
const LINE_TYPES: readonly LineType[] = ["mobile_prepaid", "mobile_postpaid", "voip", "landline", "unknown"];

export interface GenericIntelMapping {
  /** JSON field carrying the E.164 number. Default "msisdn". */
  numberField?: string;
  /** JSON field for the random request id, or null to omit. Default "request_id". */
  requestIdField?: string | null;
  /** Constant fields added to every request body (e.g. an API version). Default { version: 1 }. Must not carry personal data. */
  extraBody?: Record<string, string | number | boolean>;
  /** Header carrying the API key. Default "x-api-key". With "authorization" set apiKeyPrefix to e.g. "Bearer ". */
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  /** Dot paths into the response JSON. Defaults are the neutral shape's names. */
  response?: {
    lineType?: string; recycled?: string; portedRecently?: string; carrierCircle?: string; activationAgeDays?: string; activationConfidence?: string;
    /** Vendor line-type value (case-insensitive) -> contract line type. Unmapped values become "unknown". */
    lineTypeMap?: Record<string, LineType>;
  };
}

export interface GenericHttpIntelOpts extends ManagedIntelOpts {
  url: string; apiKey: string; mapping?: GenericIntelMapping; fetchImpl?: FetchLike;
}

const pick = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

export class GenericHttpIntelTransport implements NumberIntelTransport {
  readonly name = "generic-http";
  constructor(private c: GenericHttpIntelOpts) {
    assertSecureUrl(c.url, "CIVIC_NUMINTEL_URL");
    if (!c.apiKey) throw new ProviderError("CIVIC_NUMINTEL_API_KEY is required", "config");
  }
  async lookup(req: { msisdn: string; requestId: string }, ctx: { timeoutMs: number }): Promise<RawNumberFacts> {
    const m = this.c.mapping ?? {}, r = m.response ?? {};
    const body: Record<string, unknown> = { ...(m.extraBody ?? { version: 1 }), [m.numberField ?? "msisdn"]: req.msisdn };
    const ridField = m.requestIdField === undefined ? "request_id" : m.requestIdField;
    if (ridField) body[ridField] = req.requestId;
    const res = await postJson<unknown>(this.c.url, body, {
      timeoutMs: ctx.timeoutMs, fetchImpl: this.c.fetchImpl, now: this.c.now,
      headers: { [(m.apiKeyHeader ?? "x-api-key").toLowerCase()]: (m.apiKeyPrefix ?? "") + this.c.apiKey },
    });
    if (!res || typeof res !== "object") throw new ProviderError("vendor answer is not an object", "bad_response");
    const rawType = pick(res, r.lineType ?? "line_type");
    let lineType: LineType = "unknown";
    if (typeof rawType === "string") {
      const k = rawType.toLowerCase();
      const mapped = Object.entries(r.lineTypeMap ?? {}).find(([v]) => v.toLowerCase() === k)?.[1];
      lineType = mapped ?? (r.lineTypeMap ? "unknown" : (LINE_TYPES as readonly string[]).includes(k) ? (k as LineType) : "unknown");
    }
    const nb = (v: unknown) => (typeof v === "boolean" ? v : null);
    const age = pick(res, r.activationAgeDays ?? "activation_age_days"), conf = pick(res, r.activationConfidence ?? "activation_confidence");
    const circle = pick(res, r.carrierCircle ?? "carrier_circle");
    return {
      lineType,
      recycled: nb(pick(res, r.recycled ?? "recycled")),
      portedRecently: nb(pick(res, r.portedRecently ?? "ported_recently")),
      carrierCircle: typeof circle === "string" && circle ? circle : null,
      activationAgeDays: typeof age === "number" && Number.isFinite(age) && age >= 0 ? age : null,
      activationConfidence: typeof conf === "number" && conf >= 0 && conf <= 1 ? conf : null,
    };
  }
}

export class GenericHttpNumberIntel extends ManagedNumberIntel {
  constructor(opts: GenericHttpIntelOpts) { super(new GenericHttpIntelTransport(opts), opts); }
}
