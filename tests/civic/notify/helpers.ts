import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSession, getDb, getKeys, grantRole, migrate, resetDbForTests, smsOutbox } from "../../../server/civic/core";
import { confirmMfa, enrolMfa, base32Decode, totp } from "../../../server/civic/admin/mfa";
import { notifyRouter, setNotifyClock, setPushTransport, setWebAuthnConfig, setMccTemplates, setNotifyCalendar, pushOutbox, DevPushTransport } from "../../../server/civic/notify";
import * as svc from "../../../server/civic/notify/service";
import { setNotifyPolicy } from "../../../server/civic/notify/content";

export const NOON = new Date("2026-06-01T06:30:00Z"); // 12:00 IST, outside quiet hours
export const NIGHT = new Date("2026-06-01T17:00:00Z"); // 22:30 IST, inside quiet hours
export const ORIGIN = "http://localhost:3000";

export function freshWorld(): void {
  process.env.CIVIC_TOTP_WINDOW = "60";
  resetDbForTests(); migrate();
  setNotifyClock(() => NOON); setNotifyCalendar(undefined); setMccTemplates(null); setNotifyPolicy(null);
  setWebAuthnConfig({ rpId: "localhost", rpName: "t", origins: [ORIGIN] });
  const push = new DevPushTransport(); setPushTransport(push); pushOutbox.length = 0; smsOutbox.length = 0;
}
export const devPush = (): DevPushTransport => { const t = new DevPushTransport(); setPushTransport(t); return t; };

// ---- minimal CBOR encoder (test only) ----
type C = number | string | Buffer | C[] | [C, C][] & { map: true } | Map<C, C>;
export function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  throw new Error("cbor encode");
}
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest();
export const challengeOf = (a: { challenge: string }): string => a.challenge;

/** A software FIDO2 authenticator. alg "es256" (P-256) or "eddsa" (Ed25519). */
export class Authn {
  private priv: crypto.KeyObject; private pub: crypto.KeyObject; readonly credId = crypto.randomBytes(20); counter = 0;
  constructor(public alg: "es256" | "eddsa" = "es256") {
    const kp = alg === "es256" ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("ed25519");
    this.priv = kp.privateKey; this.pub = kp.publicKey;
  }
  get id(): string { return this.credId.toString("base64url"); }
  private cose(): Buffer {
    const jwk = this.pub.export({ format: "jwk" }) as { x: string; y?: string };
    const x = Buffer.from(jwk.x, "base64url");
    return cbor(this.alg === "es256" ? new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, Buffer.from(jwk.y!, "base64url")]]) : new Map<C, C>([[1, 1], [3, -8], [-1, 6], [-2, x]]));
  }
  private authData(rpId: string, flags: number, counter: number, attested: boolean): Buffer {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    const base = Buffer.concat([sha(rpId), Buffer.from([flags]), c]);
    if (!attested) return base;
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    return Buffer.concat([base, Buffer.alloc(16), len, this.credId, this.cose()]);
  }
  register(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean; fmt?: string; type?: string } = {}) {
    const cdj = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.create", challenge, origin: o.origin ?? ORIGIN }));
    const ad = this.authData(o.rpId ?? "localhost", o.uv === false ? 0x41 : 0x45, 0, true);
    const att = cbor(new Map<C, C>([["fmt", o.fmt ?? "none"], ["attStmt", new Map<C, C>()], ["authData", ad]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: cdj.toString("base64url"), attestationObject: att.toString("base64url") } };
  }
  assert(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean; counter?: number; corrupt?: boolean } = {}) {
    const cdj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? ORIGIN }));
    const counter = o.counter ?? ++this.counter;
    if (o.counter === undefined) this.counter = counter;
    const ad = this.authData(o.rpId ?? "localhost", o.uv === false ? 0x01 : 0x05, counter, false);
    const data = Buffer.concat([ad, sha(cdj)]);
    const sig = this.alg === "es256" ? crypto.sign("sha256", data, this.priv) : crypto.sign(null, data, this.priv);
    if (o.corrupt) sig[sig.length - 1] ^= 1;
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: cdj.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url") } };
  }
}

let phoneSeq = 0;
export function mkPerson(o: { unit?: string | null; phone?: boolean } = {}): { id: string; token: string } {
  const id = crypto.randomUUID(), now = new Date().toISOString(), n = ++phoneSeq;
  const phone = `+91987${String(1000000 + n)}`;
  getDb().prepare("INSERT INTO persons (id, created_at, eligible_from, residence_unit, phone_hash, phone_enc) VALUES (?,?,?,?,?,?)")
    .run(id, now, now, o.unit === undefined ? "U1" : o.unit, getKeys().hmac("phone", phone), o.phone === false ? null : getKeys().encrypt("phone", phone));
  return { id, token: createSession(id) };
}

export function mkAdmin() {
  const p = mkPerson({ unit: null });
  grantRole("system", p.id, "admin");
  const en = enrolMfa(p.id);
  const secret = base32Decode(en.secret);
  confirmMfa(p.id, totp(secret, Date.now()));
  let step = 0;
  return { ...p, code: () => totp(secret, Date.now() + 30_000 * ++step) };
}
export type Admin = ReturnType<typeof mkAdmin>;

/** A verified organisation (two admins), returns its id. */
export function mkOrg(kind = "department", name = "Revenue Department"): { id: string; a: Admin; b: Admin } {
  const a = mkAdmin(), b = mkAdmin();
  const { id } = svc.requestOrg(a.id, { name, kind, letter_ref: "GO/2026/17", email_domain: kind === "eci_liaison" ? "ceo.nic.in" : "revenue.ap.gov.in", contact: "pio@revenue.ap.gov.in" });
  svc.decideOrg(b.id, id, true);
  return { id, a, b };
}

/** An active sender bound to the org with a registered authenticator. */
export function mkSender(org: { id: string; a: Admin; b: Admin }, role = "department_sender", alg: "es256" | "eddsa" = "es256", register = true) {
  const p = mkPerson({ unit: null });
  const r = svc.requestSender(org.a.id, { org_id: org.id, person_id: p.id, role });
  svc.decideSender(org.b.id, r.id, true);
  const authn = new Authn(alg);
  if (register) { const o = svc.registrationOptions(p.id); svc.finishRegistration(p.id, authn.register(o.challenge as string) as never); }
  return { ...p, authn, senderId: r.id };
}
export type Sender = ReturnType<typeof mkSender>;

export const assertFor = (s: Sender, messageId: string, purpose: "approve" | "send") => s.authn.assert(svc.assertionOptions(s.id, messageId, purpose).challenge as string) as never;

export const MSG = { category: "service", target: { state: "AP", units: ["U1"] }, text_en: "Free health camp at the village hall on Monday.", text_te: "సోమవారం గ్రామ సభా భవనంలో ఉచిత ఆరోగ్య శిబిరం." };

/** Create, approve with the second sender and send with the first. */
export async function sendFull(a: Sender, b: Sender, body: Record<string, unknown> = {}) {
  const m = svc.createMessage(a.id, { ...MSG, ...body });
  svc.approveMessage(b.id, m.id as string, assertFor(b, m.id as string, "approve"));
  return svc.sendMessage(a.id, m.id as string, assertFor(a, m.id as string, "send"));
}

export async function serve(): Promise<{ s: Server; base: string }> {
  const app = express();
  app.use("/notify", notifyRouter);
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/notify` };
}
export async function call(base: string, method: string, p: string, o: { token?: string; body?: unknown; totp?: string } = {}) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: "Bearer " + o.token } : {}), ...(o.totp ? { "x-totp-code": o.totp } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const t = await r.text();
  return { status: r.status, body: (t ? JSON.parse(t) : {}) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export const opt = (id: string, category: string, v = true) => svc && getDb().prepare("INSERT OR REPLACE INTO notify_prefs (person_id, category, opted_in, updated_at) VALUES (?,?,?,?)").run(id, category, v ? 1 : 0, new Date().toISOString());
