/**
 * AWS KMS key provider adapter (S-64, E2E-79). NOT yet run against real AWS: it is certified only against the local simulator
 * (./mock/awsKmsServer.ts) built from the public KMS JSON API and Signature Version 4 documentation. See docs/PROVIDERS.md.
 *
 * KMS holds only the KEK. The envelope provider generates each 32-byte data key locally and wraps it with KMS `Encrypt`
 * (EncryptionContext {"aad": "<purpose/version aad>"} so a wrapped key replayed under another purpose fails), unwraps with `Decrypt`.
 * `generateDataKey` (KMS GenerateDataKey) is also available for adopters who prefer KMS-generated keys.
 *
 * Requests are signed with SigV4 implemented on node:crypto (no AWS SDK). Static credentials only (env); an instance-role / SSO
 * credential chain is deliberately not implemented: pass `credentials` as a function to plug one in.
 *
 * ERRORS: KMS answers 4xx/5xx with {"__type":"ThrottlingException","message":...}. Mapped to ProviderError:
 *   ThrottlingException / LimitExceededException -> http 429 (retryable, trips the breaker)
 *   KMSInternalException / DependencyTimeoutException / 5xx -> http 500+ (retryable, trips the breaker)
 *   AccessDeniedException, DisabledException, NotFoundException, InvalidCiphertextException, ... -> http 4xx (permanent, no retry)
 */
import crypto from "node:crypto";
import { EnvelopeKeyProvider, type EnvelopeOpts, type KmsBackend } from "./keys";
import { CircuitBreaker, ProviderError, assertSecureUrl, providerLog, type FetchLike } from "./util";

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface AwsKmsOpts extends EnvelopeOpts {
  region: string;
  /** Override for tests / VPC endpoints / FIPS. Default https://kms.{region}.amazonaws.com */
  endpoint?: string;
  credentials: AwsCredentials | (() => AwsCredentials);
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  breaker?: CircuitBreaker;
}

const sha256hex = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => crypto.createHmac("sha256", k).update(s).digest();

export interface SigV4Input { method: string; url: URL; headers: Record<string, string>; body: string; region: string; service: string; creds: AwsCredentials; now: Date }

/** Returns the headers to send (input headers + host-independent x-amz-date, optional token, Authorization). */
export function signV4(i: SigV4Input): Record<string, string> {
  const amzDate = i.now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
  const day = amzDate.slice(0, 8);
  const h: Record<string, string> = { ...i.headers, "x-amz-date": amzDate };
  if (i.creds.sessionToken) h["x-amz-security-token"] = i.creds.sessionToken;
  const all: Record<string, string> = { ...h, host: i.url.host };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonical = [i.method, i.url.pathname || "/", i.url.search.replace(/^\?/, ""), names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), sha256hex(i.body)].join("\n");
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + i.creds.secretAccessKey, day), i.region), i.service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(sts).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return h;
}

const THROTTLE = new Set(["ThrottlingException", "LimitExceededException", "TooManyRequestsException", "RequestLimitExceeded"]);
const SERVER = new Set(["KMSInternalException", "DependencyTimeoutException", "InternalFailure", "ServiceUnavailableException", "KMSInvalidStateException"]);

export class AwsKmsBackend implements KmsBackend {
  readonly name = "aws-kms";
  readonly breaker: CircuitBreaker;
  private endpoint: URL;
  constructor(private c: Omit<AwsKmsOpts, "kekId">) {
    if (!c.region) throw new ProviderError("CIVIC_AWS_KMS_REGION is required", "config");
    const ep = c.endpoint || `https://kms.${c.region}.amazonaws.com`;
    assertSecureUrl(ep, "CIVIC_AWS_KMS_ENDPOINT");
    this.endpoint = new URL(ep);
    this.breaker = c.breaker ?? new CircuitBreaker(3, 30_000, c.now);
    const creds = typeof c.credentials === "function" ? c.credentials() : c.credentials;
    if (!creds?.accessKeyId || !creds?.secretAccessKey) throw new ProviderError("AWS credentials are required (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", "config");
  }

  private async call<T>(target: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.breaker.allow()) throw new ProviderError("KMS circuit open", "circuit_open");
    const timeoutMs = this.c.timeoutMs ?? 3000;
    const body = JSON.stringify(payload);
    const creds = typeof this.c.credentials === "function" ? this.c.credentials() : this.c.credentials;
    const headers = signV4({
      method: "POST", url: this.endpoint, body, region: this.c.region, service: "kms", creds, now: new Date(this.c.now ? this.c.now() : Date.now()),
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` },
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const f: FetchLike = this.c.fetchImpl ?? ((u, i) => fetch(u, i) as never);
    try {
      let status: number, text: string;
      try {
        const res = await f(this.endpoint.toString(), { method: "POST", headers, body, signal: ac.signal });
        status = res.status; text = await res.text();
      } catch {
        throw ac.signal.aborted ? new ProviderError(`KMS timed out after ${timeoutMs} ms`, "timeout") : new ProviderError("KMS unreachable", "network");
      }
      if (status < 200 || status >= 300) {
        let type = "";
        try { type = String((JSON.parse(text) as { __type?: string }).__type ?? "").split("#").pop() ?? ""; } catch { /* not JSON */ }
        const mapped = THROTTLE.has(type) ? 429 : (SERVER.has(type) || status >= 500) ? Math.max(500, status) : status;
        providerLog("kms", "aws_error", { op: target, type, status });
        throw new ProviderError(`KMS ${target} failed: ${type || "HTTP " + status}`, "http", mapped);
      }
      try { return JSON.parse(text) as T; } catch { throw new ProviderError("KMS answer is not JSON", "bad_response"); }
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("KMS call failed", "network");
      // 4xx other than throttling is an answer (AccessDenied, Disabled...), not an outage.
      if (pe.kind !== "http" || (pe.status ?? 500) >= 500 || pe.status === 429) this.breaker.failure(); else this.breaker.success();
      throw pe;
    } finally { clearTimeout(timer); }
  }

  private async ok<T>(target: string, payload: Record<string, unknown>): Promise<T> {
    const r = await this.call<T>(target, payload);
    this.breaker.success();
    return r;
  }

  async wrap(keyId: string, plaintext: Buffer, aad: string): Promise<string> {
    const r = await this.ok<{ CiphertextBlob?: unknown }>("Encrypt", { KeyId: keyId, Plaintext: plaintext.toString("base64"), EncryptionContext: { aad } });
    if (typeof r.CiphertextBlob !== "string" || !r.CiphertextBlob) throw new ProviderError("KMS Encrypt answer has no CiphertextBlob", "bad_response");
    return r.CiphertextBlob;
  }
  async unwrap(wrapped: string, aad: string): Promise<Buffer> {
    const r = await this.ok<{ Plaintext?: unknown }>("Decrypt", { CiphertextBlob: wrapped, EncryptionContext: { aad } });
    if (typeof r.Plaintext !== "string") throw new ProviderError("KMS Decrypt answer has no Plaintext", "bad_response");
    return Buffer.from(r.Plaintext, "base64");
  }
  /** KMS-generated 32-byte data key: returns the clear key and its wrapped form. Not used by EnvelopeKeyProvider (it generates locally). */
  async generateDataKey(keyId: string, aad: string): Promise<{ plaintext: Buffer; wrapped: string }> {
    const r = await this.ok<{ Plaintext?: unknown; CiphertextBlob?: unknown }>("GenerateDataKey", { KeyId: keyId, KeySpec: "AES_256", EncryptionContext: { aad } });
    if (typeof r.Plaintext !== "string" || typeof r.CiphertextBlob !== "string") throw new ProviderError("KMS GenerateDataKey answer is incomplete", "bad_response");
    return { plaintext: Buffer.from(r.Plaintext, "base64"), wrapped: r.CiphertextBlob };
  }
}

export class AwsKmsKeyProvider extends EnvelopeKeyProvider {
  readonly aws: AwsKmsBackend;
  constructor(o: AwsKmsOpts) {
    const backend = new AwsKmsBackend(o);
    super(backend, o);
    this.aws = backend;
  }
  override health() { return { ...super.health(), provider: "aws-kms", breaker: this.aws.breaker.state }; }
}
