/**
 * KeyProvider contract v2 (S-64, E2E-79). Additive on top of core `KeyProvider { hmac, encrypt, decrypt }` (all synchronous).
 *
 * Why envelope encryption: the core interface is synchronous and sits on every request (phone hash, OTP hash, session hash...). A KMS/HSM
 * is a remote, async, failure-prone service. So the KMS holds only a KEK that WRAPS one random 32-byte data key per purpose and version;
 * the wrapped data keys are persisted in a key registry, unwrapped ONCE at startup (`warm()`), cached in memory with a TTL and zeroized on
 * expiry/destroy; hmac/encrypt/decrypt then run locally. A KMS outage therefore does not stop traffic until the cache TTL runs out, and
 * after that every operation FAILS CLOSED (throws) instead of falling back to anything weaker.
 *
 *   EnvelopeKeyProvider    vendor-independent: purposes x versions, rotate/retire, dual-read candidates, break-glass access, cache + zeroize.
 *   KmsBackend             what a vendor adapter implements (async wrap / unwrap / optional hmac against a non-exportable KEK).
 *   RemoteKmsKeyProvider   EnvelopeKeyProvider over the neutral HTTP/JSON KMS shape (CIVIC_KMS_URL), with timeouts and a circuit breaker.
 *   BreakGlass             dual-control recovery path (./breakglass.ts).
 *   Rehash helpers         dual-read / single-write migration for keyed hashes (./rehash.ts).
 *
 * NEUTRAL KMS SHAPE  (all POST JSON; headers X-Civic-Timestamp + X-Civic-Signature as in sms.ts; secret CIVIC_KMS_SECRET)
 *   {url}/v1/wrap    { key_id, plaintext_b64, aad }      -> { ciphertext }
 *   {url}/v1/unwrap  { ciphertext, aad }                 -> { plaintext_b64 }
 *   {url}/v1/hmac    { key_id, data_b64 }                -> { mac_hex }        (only for adopters whose policy forbids exporting an HMAC key at all)
 */
import crypto from "node:crypto";
import { getDb, registerMigration, type KeyProvider } from "../core";
import { CircuitBreaker, ProviderError, assertSecureUrl, postJson, providerLog, type FetchLike } from "./util";

/** Every purpose the civic code uses today. A purpose outside this list (or outside `extra`) cannot be used until provisioned: fail closed. */
export const KNOWN_PURPOSES = [
  "phone", "otp", "rate", "pinsrc", "attest", "session", "enrolcode", "mfa-recovery", "audit", "media-at-rest", "sms-idem",
  "reporter-pseudonym", "actor-pseudonym", "issue-link", "ivr-call-person", "ivr-call-phone", "people_contact", "issue-gps", "residence", "totp", "sms-payload",
  "survey-credential", "survey-actor", "notify-signing", "notify-device", "notify-antiphish",
  "countday-signing", "assist-receipt",
] as const;

/** What rotating a purpose costs (docs/PROVIDERS.md section "Rotation"). `refuse` purposes cannot be rotated without force. */
export const ROTATION_IMPACT: Record<string, "rehash" | "ephemeral" | "encrypt-only" | "refuse"> = {
  phone: "rehash", "reporter-pseudonym": "rehash", "actor-pseudonym": "rehash", "issue-link": "rehash",
  otp: "ephemeral", rate: "ephemeral", pinsrc: "ephemeral", attest: "ephemeral", session: "ephemeral", sms: "ephemeral", "sms-idem": "ephemeral",
  "survey-credential": "encrypt-only", "notify-signing": "encrypt-only", "notify-device": "encrypt-only", "notify-antiphish": "encrypt-only", "survey-actor": "refuse", audit: "refuse", "assist-receipt": "refuse", enrolcode: "rehash", "mfa-recovery": "rehash", "media-at-rest": "rehash",
};

export interface KeyVersionInfo { purpose: string; keyId: string; version: number; createdAt: number; retiredAt: number | null }

export interface KeyProviderV2 extends KeyProvider {
  readonly contract: 2;
  /** The current (write) version of a purpose. Throws when the purpose is not provisioned or its key is not in the cache. */
  keyInfo(purpose: string): KeyVersionInfo;
  /** Versions still usable for READING: current first, then older ones that were not retired. */
  activeVersions(purpose: string): number[];
  /** HMAC under a specific version (dual-read of keyed hashes during a rotation). hmac() == hmacVersioned(current). */
  hmacVersioned(purpose: string, value: string, version: number): string;
  /** Hashes of `value` under every active version, current FIRST: `WHERE hash IN (...)` while a rehash is in flight (dual-read). */
  hmacCandidates(purpose: string, value: string): string[];
  /** New version becomes the write version; older versions stay readable (decrypt / hmacVersioned) until retire(). */
  rotate(purpose: string, o?: { force?: boolean }): Promise<KeyVersionInfo>;
  /** Drop an old version for good (its key is zeroized). Refuses the current version. Run only after the rehash plan reports 0 stale rows. */
  retire(purpose: string, version: number): Promise<void>;
  /** Unwrap every active key into the cache (startup, and the refresh timer). Provisions missing known purposes. */
  warm(purposes?: readonly string[]): Promise<void>;
  /** Background re-unwrap of keys older than half the cache TTL. A failure keeps old keys until their TTL expires (fail closed later, not now). */
  refresh(): Promise<{ ok: boolean }>;
  health(): { provider: string; ready: boolean; cachedKeys: number; oldestLoadAgeMs: number | null; breaker?: string };
  /** Zeroize every cached key. The provider is unusable afterwards (fail closed). */
  destroy(): void;
}

export const isKeyProviderV2 = (p: unknown): p is KeyProviderV2 => !!p && (p as { contract?: unknown }).contract === 2;

// ---------------------------------------------------------------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------------------------------------------------------------

export interface KmsBackend {
  readonly name: string;
  /** Wrap a data key under the KEK `keyId`. `aad` is bound (unwrap with a different aad must fail). */
  wrap(keyId: string, plaintext: Buffer, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
  /** Optional: HMAC computed inside the KMS under a non-exportable key. */
  hmac?(keyId: string, data: Buffer): Promise<string>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Registry of wrapped data keys
// ---------------------------------------------------------------------------------------------------------------------------------

export interface KeyRecord { purpose: string; version: number; kekId: string; wrapped: string; createdAt: number; retiredAt: number | null }
export interface KeyRegistry {
  list(): KeyRecord[];
  put(r: KeyRecord): void;
  retire(purpose: string, version: number, at: number): void;
}

export class MemoryKeyRegistry implements KeyRegistry {
  private rows: KeyRecord[] = [];
  list(): KeyRecord[] { return this.rows.map((r) => ({ ...r })); }
  put(r: KeyRecord): void { this.rows.push({ ...r }); }
  retire(purpose: string, version: number, at: number): void { for (const r of this.rows) if (r.purpose === purpose && r.version === version) r.retiredAt = at; }
}

registerMigration("prov_002_key_registry", `
CREATE TABLE provider_keys (
  purpose TEXT NOT NULL,
  version INTEGER NOT NULL,
  kek_id TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (purpose, version)
);
`);

/** Wrapped data keys in the identity store. Useless without the KMS KEK; back it up with the identity store. */
export class SqlKeyRegistry implements KeyRegistry {
  list(): KeyRecord[] {
    return (getDb().prepare("SELECT purpose, version, kek_id, wrapped, created_at, retired_at FROM provider_keys ORDER BY purpose, version").all() as
      { purpose: string; version: number; kek_id: string; wrapped: string; created_at: number; retired_at: number | null }[])
      .map((r) => ({ purpose: r.purpose, version: r.version, kekId: r.kek_id, wrapped: r.wrapped, createdAt: r.created_at, retiredAt: r.retired_at }));
  }
  put(r: KeyRecord): void {
    getDb().prepare("INSERT INTO provider_keys (purpose, version, kek_id, wrapped, created_at, retired_at) VALUES (?,?,?,?,?,?)").run(r.purpose, r.version, r.kekId, r.wrapped, r.createdAt, r.retiredAt);
  }
  retire(purpose: string, version: number, at: number): void {
    getDb().prepare("UPDATE provider_keys SET retired_at = ? WHERE purpose = ? AND version = ?").run(at, purpose, version);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Envelope provider
// ---------------------------------------------------------------------------------------------------------------------------------

export interface EnvelopeOpts {
  /** KEK id used to wrap NEW data keys. */
  kekId: string;
  registry?: KeyRegistry;
  /** Cache lifetime of an unwrapped key; after it expires (and could not be refreshed) operations throw. 0 = never expire. Default 15 min. */
  cacheTtlMs?: number;
  /** Extra purposes beyond KNOWN_PURPOSES. */
  extraPurposes?: string[];
  /** Decrypts old "v1." ciphertexts (the dev provider) during a migration. Read-only; never used for writes or hmac. */
  legacy?: KeyProvider;
  now?: () => number;
}

interface Entry { purpose: string; version: number; dk: Buffer; hmacKey: Buffer; encKey: Buffer; loadedAt: number; createdAt: number; retiredAt: number | null; kekId: string; wrapped: string }
const aadFor = (purpose: string, version: number) => `civic-key:${purpose}:${version}`;
const sub = (dk: Buffer, label: string) => Buffer.from(crypto.hkdfSync("sha256", dk, Buffer.from("civic-envelope-v2"), Buffer.from(label), 32));

export interface BreakGlassAccess {
  /** A COPY of the data key; the caller must zeroize it. Only BreakGlass holds this capability. */
  copyKey(purpose: string, version: number): Buffer;
  /** The data key re-wrapped under another KEK (the recovery KEK); the clear key never leaves the process. */
  wrapFor(purpose: string, version: number, recoveryKekId: string): Promise<string>;
}

export class EnvelopeKeyProvider implements KeyProviderV2 {
  readonly contract = 2 as const;
  protected registry: KeyRegistry;
  protected cache = new Map<string, Entry>();
  protected records: KeyRecord[] = [];
  private purposes: Set<string>;
  private ttl: number;
  private destroyed = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private gate: { taken: boolean } = { taken: false };
  constructor(protected backend: KmsBackend, protected o: EnvelopeOpts) {
    this.registry = o.registry ?? new MemoryKeyRegistry();
    this.purposes = new Set<string>([...KNOWN_PURPOSES, ...(o.extraPurposes ?? [])]);
    this.ttl = o.cacheTtlMs ?? 15 * 60_000;
  }
  protected now(): number { return this.o.now ? this.o.now() : Date.now(); }
  private ck = (purpose: string, version: number) => purpose + "#" + version;

  private load(purpose: string, version: number): Entry {
    if (this.destroyed) throw new Error("key provider destroyed");
    const e = this.cache.get(this.ck(purpose, version));
    if (!e) throw new Error(`key "${purpose}" v${version} is not available (KMS cache cold or version retired): refusing`);
    if (this.ttl > 0 && this.now() - e.loadedAt > this.ttl) {
      this.zero(e); this.cache.delete(this.ck(purpose, version));
      providerLog("kms", "cache_expired", { purpose, version });
      throw new Error(`key "${purpose}" v${version} cache expired and the KMS could not refresh it: refusing`);
    }
    return e;
  }
  private zero(e: Entry): void { e.dk.fill(0); e.hmacKey.fill(0); e.encKey.fill(0); }
  private current(purpose: string): Entry {
    let best = -1;
    for (const r of this.records) if (r.purpose === purpose && r.retiredAt === null && r.version > best) best = r.version;
    if (best < 0) throw new Error(`purpose "${purpose}" is not provisioned: call warm() / rotate() first`);
    return this.load(purpose, best);
  }
  private activate(r: KeyRecord, dk: Buffer): void {
    this.cache.set(this.ck(r.purpose, r.version), { purpose: r.purpose, version: r.version, dk, hmacKey: sub(dk, "hmac:" + r.purpose), encKey: sub(dk, "enc:" + r.purpose), loadedAt: this.now(), createdAt: r.createdAt, retiredAt: r.retiredAt, kekId: r.kekId, wrapped: r.wrapped });
  }
  private assertPurpose(p: string): void { if (!this.purposes.has(p)) throw new Error(`unknown key purpose "${p}": add it to the provider's purposes and provision it`); }

  // --- core v1 surface (synchronous, fail closed) ---
  hmac(purpose: string, value: string): string {
    return crypto.createHmac("sha256", this.current(purpose).hmacKey).update(value).digest("hex");
  }
  encrypt(purpose: string, plaintext: string): string {
    const e = this.current(purpose);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", e.encKey, iv);
    c.setAAD(Buffer.from(`${purpose}|v${e.version}`));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return `v2.${e.version}.` + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }
  decrypt(purpose: string, ciphertext: string): string {
    if (ciphertext.startsWith("v1.")) {
      if (!this.o.legacy) throw new Error("legacy v1 ciphertext and no legacy provider configured");
      return this.o.legacy.decrypt(purpose, ciphertext);
    }
    const m = /^v2\.(\d{1,6})\.(.+)$/.exec(ciphertext);
    if (!m) throw new Error("unknown ciphertext version");
    const e = this.load(purpose, Number(m[1]));
    const raw = Buffer.from(m[2], "base64url");
    if (raw.length < 28) throw new Error("ciphertext too short");
    const d = crypto.createDecipheriv("aes-256-gcm", e.encKey, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`${purpose}|v${e.version}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  }

  // --- v2 surface ---
  keyInfo(purpose: string): KeyVersionInfo {
    const e = this.current(purpose);
    return { purpose, keyId: `${purpose}:v${e.version}`, version: e.version, createdAt: e.createdAt, retiredAt: e.retiredAt };
  }
  activeVersions(purpose: string): number[] {
    return this.records.filter((r) => r.purpose === purpose && r.retiredAt === null).map((r) => r.version).sort((a, b) => b - a);
  }
  hmacVersioned(purpose: string, value: string, version: number): string {
    return crypto.createHmac("sha256", this.load(purpose, version).hmacKey).update(value).digest("hex");
  }
  hmacCandidates(purpose: string, value: string): string[] { return this.activeVersions(purpose).map((v) => this.hmacVersioned(purpose, value, v)); }

  async warm(purposes: readonly string[] = [...this.purposes]): Promise<void> {
    if (this.destroyed) throw new Error("key provider destroyed");
    this.records = this.registry.list();
    // Unwrap every non-retired record we do not hold (or hold stale). A failure throws: the app must not start half-keyed.
    for (const r of this.records) {
      if (r.retiredAt !== null) continue;
      const have = this.cache.get(this.ck(r.purpose, r.version));
      if (have && (this.ttl === 0 || this.now() - have.loadedAt < this.ttl / 2)) continue;
      const dk = await this.backend.unwrap(r.wrapped, aadFor(r.purpose, r.version));
      if (dk.length !== 32) throw new ProviderError("KMS returned a data key of the wrong length", "bad_response");
      if (have) this.zero(have);
      this.activate(r, dk);
    }
    for (const p of purposes) {
      this.assertPurpose(p);
      if (!this.records.some((r) => r.purpose === p && r.retiredAt === null)) await this.newVersion(p);
    }
    providerLog("kms", "warm", { keys: this.cache.size, backend: this.backend.name });
  }

  private async newVersion(purpose: string): Promise<KeyRecord> {
    const version = this.records.filter((r) => r.purpose === purpose).reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const dk = crypto.randomBytes(32);
    const wrapped = await this.backend.wrap(this.o.kekId, dk, aadFor(purpose, version));
    const rec: KeyRecord = { purpose, version, kekId: this.o.kekId, wrapped, createdAt: this.now(), retiredAt: null };
    this.registry.put(rec);
    this.records.push(rec);
    this.activate(rec, dk);
    return rec;
  }

  async rotate(purpose: string, o: { force?: boolean } = {}): Promise<KeyVersionInfo> {
    this.assertPurpose(purpose);
    if (ROTATION_IMPACT[purpose] === "refuse" && !o.force) throw new Error(`rotating "${purpose}" breaks verification of existing data (see docs/PROVIDERS.md); pass force to override`);
    const rec = await this.newVersion(purpose);
    providerLog("kms", "rotated", { purpose, version: rec.version });
    return { purpose, keyId: `${purpose}:v${rec.version}`, version: rec.version, createdAt: rec.createdAt, retiredAt: null };
  }

  async retire(purpose: string, version: number): Promise<void> {
    const cur = this.records.filter((r) => r.purpose === purpose && r.retiredAt === null).reduce((m, r) => Math.max(m, r.version), 0);
    if (version === cur) throw new Error("cannot retire the current version");
    const rec = this.records.find((r) => r.purpose === purpose && r.version === version && r.retiredAt === null);
    if (!rec) throw new Error("no such active version");
    const at = this.now();
    this.registry.retire(purpose, version, at); rec.retiredAt = at;
    const e = this.cache.get(this.ck(purpose, version));
    if (e) { this.zero(e); this.cache.delete(this.ck(purpose, version)); }
    providerLog("kms", "retired", { purpose, version });
  }

  /** Re-unwrap entries older than half the TTL. Call from a timer (startRefresh). A failure keeps the old entry until its TTL: fail closed later, not now. */
  async refresh(): Promise<{ ok: boolean }> {
    try { await this.warm([]); return { ok: true }; } catch (e) { providerLog("kms", "refresh_failed", { error: e instanceof ProviderError ? e.kind : "error" }); return { ok: false }; }
  }
  startRefresh(everyMs = Math.max(1000, Math.floor((this.ttl || 60_000) / 3))): void {
    if (this.refreshTimer || process.env.NODE_ENV === "test" || process.env.VITEST) return;
    this.refreshTimer = setInterval(() => { void this.refresh(); }, everyMs);
    this.refreshTimer.unref?.();
  }

  health(): { provider: string; ready: boolean; cachedKeys: number; oldestLoadAgeMs: number | null; breaker?: string } {
    const ages = [...this.cache.values()].map((e) => this.now() - e.loadedAt);
    const ready = !this.destroyed && this.cache.size > 0 && (this.ttl === 0 || Math.max(0, ...ages) <= this.ttl);
    return { provider: this.backend.name, ready, cachedKeys: this.cache.size, oldestLoadAgeMs: ages.length ? Math.max(...ages) : null };
  }

  destroy(): void {
    for (const e of this.cache.values()) this.zero(e);
    this.cache.clear(); this.destroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** One-shot capability for BreakGlass (a second call throws, so no other code can obtain it). */
  breakGlassAccess(): BreakGlassAccess {
    if (this.gate.taken) throw new Error("break-glass access was already handed out");
    this.gate.taken = true;
    return {
      copyKey: (purpose, version) => { const e = this.load(purpose, version); return Buffer.from(e.dk); },
      wrapFor: async (purpose, version, kek) => { const e = this.load(purpose, version); return this.backend.wrap(kek, Buffer.from(e.dk), aadFor(purpose, version) + ":recovery"); },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Neutral HTTP KMS
// ---------------------------------------------------------------------------------------------------------------------------------

export interface RemoteKmsOpts extends EnvelopeOpts {
  url: string; secret: string; timeoutMs?: number; fetchImpl?: FetchLike; breaker?: CircuitBreaker;
}

export class HttpKmsBackend implements KmsBackend {
  readonly name = "http-kms";
  readonly breaker: CircuitBreaker;
  constructor(private c: Omit<RemoteKmsOpts, "kekId">) {
    assertSecureUrl(c.url, "CIVIC_KMS_URL");
    if (!c.secret) throw new ProviderError("CIVIC_KMS_SECRET is required", "config");
    this.breaker = c.breaker ?? new CircuitBreaker(3, 30_000, c.now);
  }
  private async call<T>(path: string, body: unknown): Promise<T> {
    if (!this.breaker.allow()) throw new ProviderError("KMS circuit open", "circuit_open");
    try {
      const r = await postJson<T>(this.c.url.replace(/\/+$/, "") + path, body, { secret: this.c.secret, timeoutMs: this.c.timeoutMs ?? 3000, fetchImpl: this.c.fetchImpl, now: this.c.now });
      this.breaker.success();
      return r;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("KMS call failed", "network");
      // 4xx is an answer, not an outage: do not trip the breaker for it.
      if (pe.kind !== "http" || (pe.status ?? 500) >= 500 || pe.status === 429) this.breaker.failure(); else this.breaker.success();
      providerLog("kms", "call_failed", { path, kind: pe.kind, status: pe.status });
      throw pe;
    }
  }
  async wrap(keyId: string, plaintext: Buffer, aad: string): Promise<string> {
    const r = await this.call<{ ciphertext?: unknown }>("/v1/wrap", { key_id: keyId, plaintext_b64: plaintext.toString("base64"), aad });
    if (typeof r.ciphertext !== "string" || !r.ciphertext) throw new ProviderError("KMS wrap answer has no ciphertext", "bad_response");
    return r.ciphertext;
  }
  async unwrap(wrapped: string, aad: string): Promise<Buffer> {
    const r = await this.call<{ plaintext_b64?: unknown }>("/v1/unwrap", { ciphertext: wrapped, aad });
    if (typeof r.plaintext_b64 !== "string") throw new ProviderError("KMS unwrap answer has no plaintext_b64", "bad_response");
    return Buffer.from(r.plaintext_b64, "base64");
  }
  async hmac(keyId: string, data: Buffer): Promise<string> {
    const r = await this.call<{ mac_hex?: unknown }>("/v1/hmac", { key_id: keyId, data_b64: data.toString("base64") });
    if (typeof r.mac_hex !== "string" || !/^[0-9a-f]{64}$/.test(r.mac_hex)) throw new ProviderError("KMS hmac answer is not a SHA-256 hex MAC", "bad_response");
    return r.mac_hex;
  }
}

export class RemoteKmsKeyProvider extends EnvelopeKeyProvider {
  readonly remote: HttpKmsBackend;
  constructor(o: RemoteKmsOpts) {
    const backend = new HttpKmsBackend(o);
    super(backend, o);
    this.remote = backend;
  }
  /** HMAC computed INSIDE the KMS (key never exported). Async, so not usable through the sync KeyProvider; for the few purposes whose policy demands it. */
  hmacRemote(kekId: string, value: string): Promise<string> { return this.remote.hmac(kekId, Buffer.from(value)); }
  override health() { return { ...super.health(), breaker: this.remote.breaker.state }; }
}
