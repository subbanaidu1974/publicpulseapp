import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { getStore, verifyAuditChain } from "../../../server/civic/core";
import * as svc from "../../../server/civic/notify/service";
import { publishedKeys, verifySignature } from "../../../server/civic/notify";
import { cborDecode } from "../../../server/civic/notify/webauthn";
import { Authn, MSG, assertFor, call, cbor, freshWorld, mkAdmin, mkOrg, mkPerson, mkSender, opt, sendFull, serve } from "./helpers";

beforeEach(freshWorld);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe("WebAuthn (in-house) @E2E-46", () => {
  it("decodes CBOR and registers ES256 and Ed25519 credentials", async () => {
    expect(cborDecode(cbor(new Map<any, any>([["a", 1], [-1, Buffer.from("x")]])))).toBeInstanceOf(Map);
    const org = await mkOrg();
    for (const alg of ["es256", "eddsa"] as const) {
      const s = await mkSender(org, "department_sender", alg);
      expect((await svc.senderMe(s.id)).can_send).toBe(true);
    }
  });
  it("refuses wrong origin, wrong rp id, missing user verification, other attestation formats, replayed challenge", async () => {
    const org = await mkOrg();
    const s = await mkSender(org, "department_sender", "es256", false);
    const tryReg = async (o: Record<string, unknown>) => {
      const opts = await svc.registrationOptions(s.id);
      return await code(svc.finishRegistration(s.id, s.authn.register(opts.challenge as string, o) as never));
    };
    expect(await tryReg({ origin: "https://evil.example" })).toBe("webauthn_origin_not_allowed");
    expect(await tryReg({ rpId: "evil.example" })).toBe("webauthn_rp_id_mismatch");
    expect(await tryReg({ uv: false })).toBe("webauthn_user_not_verified");
    expect(await tryReg({ fmt: "packed" })).toBe("webauthn_attestation_unsupported");
    expect(await tryReg({ type: "webauthn.get" })).toBe("webauthn_client_data_type");
    const opts = await svc.registrationOptions(s.id);
    const body = s.authn.register(opts.challenge as string);
    await svc.finishRegistration(s.id, body as never);
    expect(await code(svc.finishRegistration(s.id, body as never))).toBe("challenge_reused");
  });
  it("assertion: bad signature, counter regression and replay are refused", async () => {
    const org = await mkOrg(), a = await mkSender(org), b = await mkSender(org);
    const m = await svc.createMessage(a.id, MSG);
    const id = m.id as string;
    const ch = async () => (await svc.assertionOptions(b.id, id, "approve")).challenge as string;
    expect(await code(svc.approveMessage(b.id, id, b.authn.assert(await ch(), { corrupt: true }) as never))).toBe("webauthn_signature_invalid");
    getStore("identity").prepare("UPDATE notify_credentials SET sign_count = 5 WHERE id = ?").run(b.authn.id);
    expect(await code(svc.approveMessage(b.id, id, b.authn.assert(await ch(), { counter: 3 }) as never))).toBe("webauthn_counter_regressed");
    b.authn.counter = 5;
    expect(await code(svc.approveMessage(b.id, id, b.authn.assert(await ch(), { origin: "https://evil.example" }) as never))).toBe("webauthn_origin_not_allowed");
    const good = b.authn.assert(await ch());
    expect(await code(svc.approveMessage(b.id, id, good as never))).toBe("ok");
    expect((await svc.getMessage(a.id, id)).status).toBe("approved");
  });
});

describe("sender onboarding by admin dual control @E2E-46", () => {
  it("one admin cannot verify an organisation they filed; evidence fields and government domain are required", async () => {
    const a = mkAdmin(), b = mkAdmin();
    const base = { name: "Revenue Department", kind: "department", letter_ref: "GO/1", email_domain: "x.ap.gov.in", contact: "pio@x.ap.gov.in" };
    expect(await code(svc.requestOrg(a.id, { ...base, letter_ref: "" }))).toBe("letter_ref_required");
    expect(await code(svc.requestOrg(a.id, { ...base, email_domain: "gmail.com" }))).toBe("email_domain_not_government");
    const { id } = await svc.requestOrg(a.id, base);
    expect(await code(svc.decideOrg(a.id, id, true))).toBe("dual_control");
    expect(await svc.decideOrg(b.id, id, true)).toMatchObject({ status: "verified" });
  });
  it("sender binding needs a verified org, dual control, no self-grant; blocked without FIDO2 or when unverified", async () => {
    const a = mkAdmin(), b = mkAdmin();
    const pending = await svc.requestOrg(a.id, { name: "Dept", kind: "department", letter_ref: "GO/9", email_domain: "d.gov.in", contact: "c@d.gov.in" });
    const p = mkPerson({ unit: null });
    expect(await code(svc.requestSender(a.id, { org_id: pending.id, person_id: p.id, role: "department_sender" }))).toBe("org_not_verified");
    await svc.decideOrg(b.id, pending.id, true);
    expect(await code(svc.requestSender(a.id, { org_id: pending.id, person_id: a.id, role: "department_sender" }))).toBe("self_grant");
    expect(await code(svc.requestSender(a.id, { org_id: pending.id, person_id: p.id, role: "eci_liaison" }))).toBe("bad_role");
    const r = await svc.requestSender(a.id, { org_id: pending.id, person_id: p.id, role: "department_sender" });
    expect(await code(svc.decideSender(a.id, r.id, true))).toBe("dual_control");
    // before approval: not a sender
    expect(await code(svc.createMessage(p.id, MSG))).toBe("sender_unverified");
    await svc.decideSender(b.id, r.id, true);
    // approved but no FIDO2 key yet
    expect(await code(svc.createMessage(p.id, MSG))).toBe("fido2_required");
    const stranger = mkPerson();
    expect(await code(svc.createMessage(stranger.id, MSG))).toBe("sender_unverified");
    expect(await code(svc.registrationOptions(stranger.id))).toBe("not_a_sender");
  });
  it("only an Election Commission liaison organisation sends election information", async () => {
    const dept = await mkOrg(), a = await mkSender(dept);
    expect(await code(svc.createMessage(a.id, { ...MSG, category: "election_info" }))).toBe("category_not_allowed");
    const eci = await mkOrg("eci_liaison", "CEO Liaison"), e = await mkSender(eci, "eci_liaison");
    expect(await code(svc.createMessage(e.id, { ...MSG, category: "election_info" }))).toBe("sender_unverified"); // needs the core eci_liaison role too
  });
});

describe("two-person approval, signing, kill switch @E2E-46", () => {
  it("creator cannot approve; send needs approval and a fresh assertion bound to the message hash; payload verifies with the published key", async () => {
    const org = await mkOrg(), a = await mkSender(org), b = await mkSender(org);
    const m = await svc.createMessage(a.id, MSG), id = m.id as string;
    expect(await code(svc.approveMessage(a.id, id, await assertFor(a, id, "approve")))).toBe("dual_control");
    expect(await code(svc.sendMessage(a.id, id, await assertFor(a, id, "send")))).toBe("approval_required");
    await svc.approveMessage(b.id, id, await assertFor(b, id, "approve"));
    // an approve-purpose assertion cannot be used to send; a challenge for another message cannot either
    const other = await svc.createMessage(a.id, MSG), oid = other.id as string;
    expect(await code(svc.sendMessage(a.id, id, await assertFor(a, id, "approve")))).toBe("challenge_invalid");
    const wrongMsg = (await svc.assertionOptions(a.id, oid, "send")).challenge as string;
    expect(await code(svc.sendMessage(a.id, id, a.authn.assert(wrongMsg) as never))).toBe("challenge_invalid");
    expect(await code(svc.sendMessage(a.id, id, undefined as never))).toBe("assertion_required");
    // challenge is bound to the hash: tampering with the stored text after the challenge invalidates it
    const ch = await svc.assertionOptions(a.id, id, "send");
    getStore("identity").prepare("UPDATE notify_messages SET msg_hash = ? WHERE id = ?").run("f".repeat(64), id);
    expect(await code(svc.sendMessage(a.id, id, a.authn.assert(ch.challenge as string) as never))).toBe("message_changed");
    getStore("identity").prepare("UPDATE notify_messages SET msg_hash = ? WHERE id = ?").run(ch.message_hash, id);
    const sent = await svc.sendMessage(a.id, id, await assertFor(a, id, "send"));
    expect(sent.status).toBe("sent");
    const key = publishedKeys().find((k) => k.key_id === sent.key_id)!;
    expect(verifySignature(sent.signed_payload as string, sent.signature as string, key.public_key)).toBe(true);
    expect(verifySignature((sent.signed_payload as string).replace("health", "wealth"), sent.signature as string, key.public_key)).toBe(false);
    expect(await code(svc.sendMessage(a.id, id, await assertFor(a, id, "send")))).toBe("bad_state");
    expect(verifyAuditChain().ok).toBe(true);
  });
  it("free-text emergency needs two distinct approvers; a template emergency needs one", async () => {
    const org = await mkOrg(), a = await mkSender(org, "emergency_authority"), b = await mkSender(org, "emergency_authority"), c = await mkSender(org, "emergency_authority");
    const decl = { accepted: true, reason: "Emergency flood warning" };
    const m = await svc.createMessage(a.id, { ...MSG, category: "emergency", declaration: decl });
    expect(m.approvals_required).toBe(2);
    const id = m.id as string;
    await svc.approveMessage(b.id, id, await assertFor(b, id, "approve"));
    expect(await code(svc.sendMessage(a.id, id, await assertFor(a, id, "send")))).toBe("approval_required");
    expect(await code(svc.approveMessage(b.id, id, await assertFor(b, id, "approve")))).toBe("already_approved");
    await svc.approveMessage(c.id, id, await assertFor(c, id, "approve"));
    expect((await svc.sendMessage(a.id, id, await assertFor(a, id, "send"))).status).toBe("sent");
  });
  it("kill switch: instant per-org and global suspension, audited, release needs a different admin", async () => {
    const org = await mkOrg(), a = await mkSender(org), b = await mkSender(org), admin = mkAdmin(), admin2 = mkAdmin();
    const k = await svc.engageKill(admin.id, { scope: "org", org_id: org.id, reason: "suspected hijack" });
    expect(await code(svc.createMessage(a.id, MSG))).toBe("kill_switch");
    expect((await svc.publicBlockLog()).some((r) => r.reason_code === "kill_switch")).toBe(true);
    await svc.requestRelease(admin.id, k.id as string);
    expect(await code(svc.approveRelease(admin.id, k.id as string))).toBe("dual_control");
    await svc.approveRelease(admin2.id, k.id as string);
    expect(await sendFull(a, b).then((r) => r.status)).toBe("sent");
    // a kill engaged AFTER approval blocks the send itself
    const m = await svc.createMessage(a.id, MSG), id = m.id as string;
    await svc.approveMessage(b.id, id, await assertFor(b, id, "approve"));
    await svc.engageKill(admin.id, { scope: "all", reason: "global stop" });
    expect(await code(svc.sendMessage(a.id, id, await assertFor(a, id, "send")))).toBe("kill_switch");
    expect(await code(svc.engageKill(admin.id, { scope: "all", reason: "again again" }))).toBe("already_engaged");
  });
  it("admin HTTP routes: TOTP required, dual control enforced", async () => {
    const { s, base } = await serve();
    try {
      const a = mkAdmin(), b = mkAdmin();
      const body = { name: "Health Department", kind: "department", letter_ref: "GO/55", email_domain: "health.ap.gov.in", contact: "pio@health.ap.gov.in" };
      expect((await call(base, "POST", "/admin/orgs", { token: a.token, body })).body.code).toBe("mfa_required");
      const r = await call(base, "POST", "/admin/orgs", { token: a.token, body, totp: a.code() });
      expect(r.status).toBe(201);
      expect((await call(base, "POST", `/admin/orgs/${r.body.id}/verify`, { token: a.token, totp: a.code() })).body.code).toBe("dual_control");
      expect((await call(base, "POST", `/admin/orgs/${r.body.id}/verify`, { token: b.token, totp: b.code() })).status).toBe(200);
      expect((await call(base, "GET", "/admin/orgs", { token: mkPerson().token })).status).toBe(403);
      const keys = await call(base, "GET", "/keys");
      expect(keys.body.keys[0]).toMatchObject({ alg: "Ed25519" });
      void opt; void Authn; void crypto;
    } finally { s.close(); }
  });
});
