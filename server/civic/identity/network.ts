/**
 * Request context: who is calling, and how far to believe the client-supplied network hints (S-60).
 *
 * TRUST_PROXY (read by server/security.ts, Express "trust proxy"): set it to the number of reverse-proxy hops in front of the app
 * (or a CIDR list) so req.ip is the real client address taken from X-Forwarded-For. Left unset, req.ip is the TCP peer and X-Forwarded-For
 * is ignored, which is what you want when the app is exposed directly. A wrong value lets any client choose its own IP, so set it exactly.
 *
 * X-Device-Id / X-Asn are client-controlled and are IGNORED unless one of these holds:
 *   1. the request carries a valid attestation token in `X-Attestation` (checked by the installed AttestationVerifier; the device id and
 *      ASN come from the verified token, never from the headers), or
 *   2. the TCP peer is a trusted edge: its address matches CIVIC_TRUSTED_EDGE_IPS (comma list of IPs / IPv4 CIDRs), the edge sent
 *      `X-Edge-Verified: 1` (it must strip that header from client requests) and, when CIVIC_EDGE_SECRET is set, `X-Civic-Edge: <secret>`.
 * Otherwise the context is "unverified": device and ASN are empty. The trust state is used for caps weighting only (capScale).
 */
import crypto from "node:crypto";
import type { Request } from "express";
import { getKeys } from "../core";
import { networkPrefix } from "./service";

export interface AttestationResult { verified: boolean; deviceId?: string; asn?: string; reason?: string }
/** Verifies a device/app attestation token (Play Integrity, App Attest, a signed edge token...). Install a real one with setAttestationVerifier. */
export interface AttestationVerifier { verify(token: string, ctx: { ip: string }): Promise<AttestationResult> }

const isProd = () => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";

/** Dev token: `dev1.<deviceId>.<asn>.<hmac>`. Generate with devAttestationToken(). Never verifies in production. */
class DevAttestationVerifier implements AttestationVerifier {
  async verify(token: string): Promise<AttestationResult> {
    if (isProd()) return { verified: false, reason: "dev verifier disabled in production" };
    const m = /^dev1\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{0,32})\.([0-9a-f]{64})$/.exec(token);
    if (!m) return { verified: false, reason: "malformed" };
    const want = Buffer.from(getKeys().hmac("attest", m[1] + "|" + m[2]), "hex"), given = Buffer.from(m[3], "hex");
    if (want.length !== given.length || !crypto.timingSafeEqual(want, given)) return { verified: false, reason: "bad signature" };
    return { verified: true, deviceId: m[1], asn: m[2] };
  }
}
let verifier: AttestationVerifier = new DevAttestationVerifier();
export function setAttestationVerifier(v: AttestationVerifier | null): void { verifier = v ?? new DevAttestationVerifier(); }
export function getAttestationVerifier(): AttestationVerifier { return verifier; }
/** True while the dev stub is the verifier (a production readiness check can use this). */
export function isDevAttestationVerifier(): boolean { return verifier instanceof DevAttestationVerifier; }
/** Mint a token the dev verifier accepts (tests and local development). */
export function devAttestationToken(deviceId: string, asn = ""): string {
  return `dev1.${deviceId}.${asn}.${getKeys().hmac("attest", deviceId + "|" + asn)}`;
}

export type TrustState = "attested" | "edge" | "unverified";
export interface RequestContext {
  ip: string;
  prefix: string;
  device: string;
  asn: string;
  trust: TrustState;
  /** False = "not verified": device/ASN hints were not believed. */
  verified: boolean;
}

const norm = (ip: string) => ip.trim().replace(/^::ffff:/i, "");
const v4 = (ip: string): number | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.some((n) => n > 255) ? null : ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
};
function ipMatches(peer: string, entry: string): boolean {
  const p = norm(peer), e = entry.trim();
  if (!e) return false;
  const [net, bits] = e.split("/");
  if (bits === undefined) return norm(net) === p;
  const pn = v4(p), nn = v4(norm(net)), b = Number(bits);
  if (pn === null || nn === null || !(b >= 0 && b <= 32)) return false;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((pn & mask) >>> 0) === ((nn & mask) >>> 0);
}
export const trustedEdgeIps = (): string[] => (process.env.CIVIC_TRUSTED_EDGE_IPS || "").split(",").map((x) => x.trim()).filter(Boolean);
const hdr = (req: Request, name: string): string => { const v = req.headers[name]; return (Array.isArray(v) ? v[0] : v) ?? ""; };

/** Is this request from a configured trusted edge that vouches for its headers? */
export function isTrustedEdge(req: Request): boolean {
  const list = trustedEdgeIps();
  if (!list.length) return false;
  const peer = req.socket?.remoteAddress ?? "";
  if (!list.some((e) => ipMatches(peer, e))) return false;
  if (hdr(req, "x-edge-verified") !== "1") return false;
  const secret = process.env.CIVIC_EDGE_SECRET;
  if (secret) {
    const given = Buffer.from(hdr(req, "x-civic-edge")), want = Buffer.from(secret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  }
  return true;
}

export const clientIp = (req: Request): string => req.ip || req.socket?.remoteAddress || "unknown";

/** Resolve the caller's network identity. Spoofed X-Device-Id / X-Asn never reach the returned context. */
export async function requestContext(req: Request): Promise<RequestContext> {
  const ip = clientIp(req);
  const base = { ip, prefix: networkPrefix(ip) };
  const token = hdr(req, "x-attestation").slice(0, 2048);
  if (token) {
    try {
      const r = await verifier.verify(token, { ip });
      if (r.verified && r.deviceId) return { ...base, device: r.deviceId.slice(0, 64), asn: (r.asn ?? "").slice(0, 32), trust: "attested", verified: true };
    } catch { /* an unavailable verifier means "not verified", never an error for the caller */ }
  }
  if (isTrustedEdge(req)) {
    return { ...base, device: hdr(req, "x-device-id").slice(0, 64), asn: hdr(req, "x-asn").slice(0, 32), trust: "edge", verified: true };
  }
  return { ...base, device: "", asn: "", trust: "unverified", verified: false };
}

/** Lockout/limit source key: IP plus the (believed) device id. */
export const sourceKey = (c: RequestContext): string => c.ip + "|" + c.device;

/**
 * Caps weighting: verified clients (attested or behind the trusted edge) get the full cap; unverified clients get
 * cap * CIVIC_UNVERIFIED_CAP_FACTOR (default 1 = no difference, so deployments opt in as attestation coverage grows). Always at least 1.
 */
export function capScale(c: RequestContext, base: number): number {
  if (c.verified) return base;
  const f = Number(process.env.CIVIC_UNVERIFIED_CAP_FACTOR ?? 1);
  return Math.max(1, Math.floor(base * (f > 0 && f <= 1 ? f : 1)));
}
