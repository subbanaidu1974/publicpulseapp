/**
 * S-29 (@E2E-38) eligibility + single shot, S-30 (@E2E-39) anonymous credential over HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { getDb, getStore } from "../../../server/civic/core";
import { checkEligibility, minAccountDays } from "../../../server/civic/surveys/eligibility";
import { credentialClock, idemWindowMs, purgeCredentialIdem } from "../../../server/civic/surveys/credential";
import { flushResponses, pendingResponses } from "../../../server/civic/surveys/responses";
import { setSurveySource } from "../../../server/civic/surveys/source";
import { deleteAccount } from "../../../server/civic/identity/service";
import * as client from "../../../src/lib/blind";
import { GOOD_ANSWERS, GOOD_STRATA, T0, call, freshWorld, getCredential, mkPerson, mkSurvey, serve, useSurveys } from "./helpers";

let srv: Server, base: string;
beforeEach(async () => { freshWorld(); const s = await serve(); srv = s.s; base = s.base; });
afterEach(() => { srv.close(); delete process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS; });

const eligibility = (id: string, token: string) => call(base, "GET", `/${id}/credential/eligibility`, { token });

describe("eligibility is decided on the server (S-29)", () => {
  it("@E2E-38 requires authentication", async () => {
    const s = mkSurvey(); useSurveys(s);
    expect((await call(base, "GET", `/${s.id}/credential/eligibility`)).status).toBe(401);
    expect((await call(base, "POST", `/${s.id}/credential/request`, { body: {} })).status).toBe(401);
  });

  it("@E2E-38 an eligible T1 resident gets key class T1 and the mandal to use as a stratum", async () => {
    const s = mkSurvey(); useSurveys(s);
    const r = await eligibility(s.id, mkPerson().token);
    expect(r.body).toMatchObject({ eligible: true, key_class: "T1", tier: "T1", quality: "normal", mandal: "DEMO-M-KLP", channel: "app" });
  });

  it("@E2E-38 account age defaults to 14 days, is configurable, and the response says when the person becomes eligible", async () => {
    expect(minAccountDays()).toBe(14);
    const s = mkSurvey(); useSurveys(s);
    const young = mkPerson({ ageDays: 3 });
    const r = await eligibility(s.id, young.token);
    expect(r.body).toMatchObject({ eligible: false, code: "account_too_new" });
    expect(new Date(r.body.eligible_from).getTime()).toBe(T0.getTime() + 11 * 86_400_000);
    expect((await call(base, "POST", `/${s.id}/credential/request`, { token: young.token, body: { blinded: "x", nonce: "n".repeat(16), key_class: "T1" } })).body.error).toBe("account_too_new");
    process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS = "2";
    expect((await eligibility(s.id, young.token)).body.eligible).toBe(true);
    process.env.CIVIC_SURVEY_MIN_ACCOUNT_DAYS = "40";
    expect((await eligibility(s.id, mkPerson({ ageDays: 30 }).token)).body.code).toBe("account_too_new");
  });

  it("@E2E-38 tier below T1, a missing residence and a pending enrolment are refused", async () => {
    const s = mkSurvey(); useSurveys(s);
    expect((await eligibility(s.id, mkPerson({ tier: "T0", village: null }).token)).body.code).toBe("tier_too_low");
    expect((await eligibility(s.id, mkPerson({ tier: "T1", village: null }).token)).body.code).toBe("residence_missing");
    expect((await eligibility(s.id, mkPerson({ flags: ["pending_activation"] }).token)).body.code).toBe("pending_enrolment");
    expect((await eligibility(s.id, mkPerson({ tier: "T2" }).token)).body).toMatchObject({ eligible: true, key_class: "T2" });
  });

  it("@E2E-38 residence must be inside the scope: state, district, mandal, village and constituency (incl. boundary versions)", async () => {
    const klr = mkPerson({ village: "DEMO-V-KLR" }), hnk = mkPerson({ village: "DEMO-V-HNK" }), anm = mkPerson({ village: "DEMO-V-ANM" });
    const ok = async (units: any, who: { token: string }, state = "AP") => { const s = mkSurvey({ scope: { state, units } }); useSurveys(s); return (await eligibility(s.id, who.token)).body; };
    expect((await ok({}, klr)).eligible).toBe(true);
    expect((await ok({}, hnk)).code).toBe("outside_scope"); // Telangana village, AP survey
    expect((await ok({}, hnk, "TG")).eligible).toBe(true);
    expect((await ok({ district: ["DEMO-D-GNT"] }, klr)).eligible).toBe(true);
    expect((await ok({ district: ["DEMO-D-KRS"] }, klr)).code).toBe("outside_scope");
    expect((await ok({ mandal: ["DEMO-M-KLP"] }, klr)).eligible).toBe(true);
    expect((await ok({ mandal: ["DEMO-M-TNL"] }, klr)).code).toBe("outside_scope");
    expect((await ok({ village: ["DEMO-V-KLR"] }, klr)).eligible).toBe(true);
    expect((await ok({ constituency: ["DEMO-C-TNL"] }, klr)).eligible).toBe(true);
    expect((await ok({ constituency: ["DEMO-C-PTR"] }, klr)).code).toBe("outside_scope");
    // Angalakuduru moved from Tenali to Ponnur on 2026-01-01: at T0 (June 2026) it is Ponnur
    expect((await ok({ constituency: ["DEMO-C-PTR"] }, anm)).eligible).toBe(true);
    expect((await ok({ constituency: ["DEMO-C-TNL"] }, anm)).code).toBe("outside_scope");
    // a union of units: any listed unit admits
    expect((await ok({ district: ["DEMO-D-KRS"], village: ["DEMO-V-KLR"] }, klr)).eligible).toBe(true);
  });

  it("@E2E-38 a recycled number is excluded; a VoIP number is admitted at reduced trust with its own key class", async () => {
    const s = mkSurvey(); useSurveys(s);
    expect((await eligibility(s.id, mkPerson({ flags: ["recently_reissued"] }).token)).body.code).toBe("number_recycled");
    const v = await eligibility(s.id, mkPerson({ flags: ["voip"] }).token);
    expect(v.body).toMatchObject({ eligible: true, key_class: "T1_LOW", quality: "low" });
    expect((await eligibility(s.id, mkPerson({ tier: "T2", flags: ["voip"] }).token)).body.key_class).toBe("T2_LOW");
  });

  it("@E2E-38 unknown, closed, not-yet-open and held surveys are refused", async () => {
    const closed = mkSurvey({ status: "closed" }), future = mkSurvey({ opens_at: "2026-09-01T00:00:00.000Z", closes_at: "2026-10-01T00:00:00.000Z" }), held = mkSurvey({ status: "election_window_hold" });
    useSurveys(closed, future, held);
    const who = mkPerson();
    expect((await eligibility(crypto.randomUUID(), who.token)).body.code).toBe("survey_not_found");
    for (const s of [closed, future, held]) expect((await eligibility(s.id, who.token)).body.code).toBe("survey_not_open");
    expect(checkEligibility(who.id, null).ok).toBe(false);
  });

  it("@E2E-38 a deleted person is not eligible", () => {
    const s = mkSurvey(); const who = mkPerson();
    deleteAccount(who.id);
    expect((checkEligibility(who.id, s, T0) as any).code).toBe("person_not_found");
  });
});

describe("single shot: one response per person per survey, final (S-29)", () => {
  it("@E2E-38 the credential is issued once; a second request is 409 already_responded and never reissues", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const a = await getCredential(base, who, s.id);
    expect(a.req.status).toBe(200);
    const b = await getCredential(base, who, s.id); // a NEW nonce and a new blinding: a different attempt
    expect(b.req.status).toBe(409);
    expect(b.req.body.error).toBe("already_responded");
    expect(b.req.body.blind_signature).toBeUndefined();
    expect((await eligibility(s.id, who.token)).body).toMatchObject({ eligible: false, code: "already_responded" });
    const rows = getDb().prepare("SELECT COUNT(*) c FROM has_responded WHERE person_id = ? AND survey_id = ?").get(who.id, s.id) as { c: number };
    expect(rows.c).toBe(1);
  }, 60_000);

  it("@E2E-38 the has_responded row is written in the same request, and a failed signature rolls it back (atomic)", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const bad = await call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body: { blinded: Buffer.alloc(256).toString("base64url"), nonce: "n".repeat(20), key_class: "T1" } });
    expect(bad.status).toBe(400); // zero is out of range -> signing refused
    expect(getDb().prepare("SELECT COUNT(*) c FROM has_responded WHERE person_id = ?").get(who.id)).toMatchObject({ c: 0 });
    expect((await getCredential(base, who, s.id)).req.status).toBe(200); // the shot is still there
    expect(getDb().prepare("SELECT COUNT(*) c FROM has_responded WHERE person_id = ?").get(who.id)).toMatchObject({ c: 1 });
  }, 60_000);

  it("@E2E-38 two people each get one; the same person may answer a different survey", async () => {
    const s1 = mkSurvey(), s2 = mkSurvey(); useSurveys(s1, s2);
    const a = mkPerson(), b = mkPerson();
    expect((await getCredential(base, a, s1.id)).req.status).toBe(200);
    expect((await getCredential(base, b, s1.id)).req.status).toBe(200);
    expect((await getCredential(base, a, s2.id)).req.status).toBe(200);
  }, 60_000);

  it("@E2E-38 the key class must be the server-assigned one", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson({ tier: "T2" });
    const r = await call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body: { blinded: "A".repeat(342), nonce: "n".repeat(20), key_class: "T1" } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "key_class_mismatch", key_class: "T2" });
    expect((await call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body: { blinded: "A", nonce: "n".repeat(20), key_class: "ZZ" } })).body.error).toBe("invalid_key_class");
    expect((await call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body: { blinded: "A", nonce: "short", key_class: "T2" } })).body.error).toBe("invalid_nonce");
    expect((await call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body: { blinded: "AAAA", nonce: "n".repeat(20), key_class: "T2" } })).body.error).toBe("invalid_blinded");
  }, 60_000);
});

describe("retry window: the same request within 10 minutes returns the same blind signature (S-29)", () => {
  const send = (s: { id: string }, who: { token: string }, body: object) => call(base, "POST", `/${s.id}/credential/request`, { token: who.token, body });

  it("@E2E-38 a dropped response can be retried with the same nonce and blinded value: same signature, still ONE has_responded row", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const key = client.keyFromJwk((await call(base, "GET", `/${s.id}/credential/key?class=T1`)).body.key);
    const st = await client.blind(key);
    const body = { blinded: st.blindedB64, nonce: "retry-nonce-0123456789", key_class: "T1" };
    const first = await send(s, who, body);
    expect(first.body.replayed).toBe(false);
    credentialClock.now = () => new Date(T0.getTime() + 9 * 60_000);
    const again = await send(s, who, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, blind_signature: first.body.blind_signature });
    expect(getDb().prepare("SELECT COUNT(*) c FROM has_responded WHERE person_id = ?").get(who.id)).toMatchObject({ c: 1 });
    await client.finalize(key, st, again.body.blind_signature); // and it is a valid signature on the client's token
  }, 60_000);

  it("@E2E-38 the same nonce with a DIFFERENT blinded value is refused (no second credential through the window)", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const key = client.keyFromJwk((await call(base, "GET", `/${s.id}/credential/key?class=T1`)).body.key);
    const [a, b] = [await client.blind(key), await client.blind(key)];
    expect((await send(s, who, { blinded: a.blindedB64, nonce: "same-nonce-0123456789", key_class: "T1" })).status).toBe(200);
    const r = await send(s, who, { blinded: b.blindedB64, nonce: "same-nonce-0123456789", key_class: "T1" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("nonce_reuse");
  }, 60_000);

  it("@E2E-38 after the window the stored signature is gone and the retry is 409 already_responded; the stored value is encrypted and keyed by a nonce hash", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const key = client.keyFromJwk((await call(base, "GET", `/${s.id}/credential/key?class=T1`)).body.key);
    const st = await client.blind(key);
    const body = { blinded: st.blindedB64, nonce: "window-nonce-0123456789", key_class: "T1" };
    const first = await send(s, who, body);
    const row = getDb().prepare("SELECT * FROM cred_idem").get() as any;
    expect(JSON.stringify(row)).not.toContain("window-nonce");
    expect(JSON.stringify(row)).not.toContain(first.body.blind_signature);
    expect(row.sig_enc).toMatch(/^v1\./);
    expect(idemWindowMs()).toBe(10 * 60_000);
    credentialClock.now = () => new Date(T0.getTime() + 10 * 60_000 + 1000);
    const late = await send(s, who, body);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("already_responded");
    expect((getDb().prepare("SELECT COUNT(*) c FROM cred_idem").get() as any).c).toBe(0);
    expect(purgeCredentialIdem(new Date(T0.getTime() + 3_600_000))).toBe(0);
  }, 60_000);

  it("@E2E-38 account deletion removes the retry-window rows", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    expect((await getCredential(base, who, s.id)).req.status).toBe(200);
    expect((getDb().prepare("SELECT COUNT(*) c FROM cred_idem").get() as any).c).toBe(1);
    deleteAccount(who.id);
    expect((getDb().prepare("SELECT COUNT(*) c FROM cred_idem").get() as any).c).toBe(0);
  }, 60_000);
});

describe("anonymous credential over HTTP (S-30)", () => {
  it("@E2E-39 publishes a per-survey RSA-2048 public key, never the private part", async () => {
    const s = mkSurvey(); useSurveys(s);
    const r = await call(base, "GET", `/${s.id}/credential/key?class=T1`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ survey_id: s.id, key_class: "T1", alg: "RSABSSA-SHA384-PSS-Randomized", bits: 2048, wording_hash: s.wording_hash });
    expect(Object.keys(r.body.key).sort()).toEqual(["alg", "e", "ext", "kty", "n"]);
    const again = await call(base, "GET", `/${s.id}/credential/key?class=T1`);
    expect(again.body.key.n).toBe(r.body.key.n); // stable
    const other = await call(base, "GET", `/${mkSurvey().id}/credential/key`);
    expect(other.status).toBe(404);
    const t2 = await call(base, "GET", `/${s.id}/credential/key?class=T2`);
    expect(t2.body.key.n).not.toBe(r.body.key.n); // one key per class
    expect((await call(base, "GET", `/${s.id}/credential/key?class=bad`)).status).toBe(400);
    const stored = getStore("survey").prepare("SELECT d_enc FROM survey_signing_key WHERE survey_id = ? AND key_class = 'T1'").get(s.id) as { d_enc: string };
    expect(stored.d_enc).toMatch(/^v1\./);
  }, 60_000);

  it("@E2E-39 no keys are minted for a survey that is not open", async () => {
    const d = mkSurvey({ status: "approved" }); useSurveys(d);
    expect((await call(base, "GET", `/${d.id}/credential/key`)).status).toBe(409);
  });

  it("@E2E-39 full flow: eligibility -> blind -> credential -> anonymous respond (no auth, no cookies) -> stored after flush", async () => {
    const s = mkSurvey(); useSurveys(s);
    const who = mkPerson();
    const c = await getCredential(base, who, s.id);
    expect(c.req.status).toBe(200);
    const r = await call(base, "POST", `/${s.id}/respond`, { body: { ...c.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, message: expect.any(String) }); // no id, no receipt
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(pendingResponses()).toBe(1);
    expect(flushResponses()).toBe(1);
    const row = getStore("survey").prepare("SELECT * FROM survey_response").get() as any;
    expect(row).toMatchObject({ survey_id: s.id, age_band: "25-34", gender: "F", tier: "T1", quality: "normal", mandal: "DEMO-M-KLP" });
    expect(JSON.parse(row.answers)).toEqual({ q1: "a", q2: 4, q3: ["x", "y"] });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  it("@E2E-39 a replayed token is rejected, and a token cannot be redeemed at another survey", async () => {
    const s1 = mkSurvey(), s2 = mkSurvey(); useSurveys(s1, s2);
    const c = await getCredential(base, mkPerson(), s1.id);
    const body = { ...c.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA };
    expect((await call(base, "POST", `/${s1.id}/respond`, { body })).status).toBe(201);
    const replay = await call(base, "POST", `/${s1.id}/respond`, { body });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("token_spent");
    await call(base, "GET", `/${s2.id}/credential/key?class=T1`);
    expect((await call(base, "POST", `/${s2.id}/respond`, { body })).status).toBe(401); // another survey's key did not sign it
    flushResponses();
    expect((getStore("survey").prepare("SELECT COUNT(*) c FROM survey_response").get() as any).c).toBe(1);
  }, 60_000);

  it("@E2E-39 forged or altered credentials are rejected", async () => {
    const s = mkSurvey(); useSurveys(s);
    const c = await getCredential(base, mkPerson(), s.id);
    const post = (b: object) => call(base, "POST", `/${s.id}/respond`, { body: { answers: GOOD_ANSWERS, strata: GOOD_STRATA, ...b } });
    const flip = Buffer.from(c.redeem!.signature, "base64url"); flip[5] ^= 1;
    expect((await post({ ...c.redeem, signature: flip.toString("base64url") })).status).toBe(401);
    expect((await post({ ...c.redeem, token: crypto.randomBytes(32).toString("base64url") })).status).toBe(401);
    expect((await post({ ...c.redeem, signature: crypto.randomBytes(256).toString("base64url") })).status).toBe(401);
    expect((await post({ token: "x", prefix: "y", signature: "z" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    // a credential forged by a client holding NO issued signature: sign with its own key
    const own = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const t = crypto.randomBytes(32), p = crypto.randomBytes(32);
    const forged = crypto.sign("sha384", Buffer.concat([p, t]), { key: own.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 });
    expect((await post({ token: t.toString("base64url"), prefix: p.toString("base64url"), signature: forged.toString("base64url") })).status).toBe(401);
    expect((await post(c.redeem!)).status).toBe(201); // the genuine one still works: failures did not spend it
  }, 60_000);

  it("@E2E-39 answers that do not match the frozen question set are 422 and do not spend the credential", async () => {
    const s = mkSurvey(); useSurveys(s);
    const c = await getCredential(base, mkPerson(), s.id);
    const post = (answers: unknown, strata: unknown = GOOD_STRATA) => call(base, "POST", `/${s.id}/respond`, { body: { ...c.redeem, answers, strata } });
    for (const bad of [
      { ...GOOD_ANSWERS, q1: "zzz" }, { ...GOOD_ANSWERS, q2: 6 }, { ...GOOD_ANSWERS, q2: 2.5 }, { ...GOOD_ANSWERS, q3: ["x", "y", "z"] }, { ...GOOD_ANSWERS, q3: ["x", "x"] },
      { ...GOOD_ANSWERS, q3: [] }, { ...GOOD_ANSWERS, extra: "a" }, { q1: "a", q2: 3 }, [], null, "text", { ...GOOD_ANSWERS, q1: ["a"] },
    ]) expect((await post(bad)).status, JSON.stringify(bad)).toBe(422);
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, age_band: "17-24" })).status).toBe(422);
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, gender: "X" })).status).toBe(422);
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, mandal: "DEMO-M-HNK" })).status).toBe(422); // Telangana mandal in an AP survey
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, mandal: "nope" })).status).toBe(422);
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, tier: "T2" })).status).toBe(422); // tier is bound to the credential
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, village: "DEMO-V-KLR" })).status).toBe(422); // no extra quasi-identifiers
    expect((await post(GOOD_ANSWERS, "x")).status).toBe(422);
    expect((await post(GOOD_ANSWERS, { ...GOOD_STRATA, tier: "T1" })).status).toBe(201);
  }, 60_000);

  it("@E2E-39 a T2 credential is stored as tier T2 and a VoIP one as quality low; a closed survey refuses responses", async () => {
    const s = mkSurvey(); useSurveys(s);
    const t2 = await getCredential(base, mkPerson({ tier: "T2" }), s.id);
    const lo = await getCredential(base, mkPerson({ flags: ["voip"] }), s.id);
    expect((await call(base, "POST", `/${s.id}/respond`, { body: { ...t2.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } })).status).toBe(201);
    expect((await call(base, "POST", `/${s.id}/respond`, { body: { ...lo.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } })).status).toBe(201);
    flushResponses();
    const rows = getStore("survey").prepare("SELECT tier, quality FROM survey_response").all() as any[];
    expect(rows.map((r) => `${r.tier}:${r.quality}`).sort()).toEqual(["T1:low", "T2:normal"]);
    const late = mkSurvey(); useSurveys(late);
    const c = await getCredential(base, mkPerson(), late.id);
    setSurveySource(() => ({ ...late, status: "closed" }));
    expect((await call(base, "POST", `/${late.id}/respond`, { body: { ...c.redeem, answers: GOOD_ANSWERS, strata: GOOD_STRATA } })).status).toBe(409);
  }, 60_000);

  it("@E2E-39 the respond endpoint slows down a flood from one network", async () => {
    process.env.CIVIC_SURVEY_RESPOND_PER_MIN = "3";
    try {
      const s = mkSurvey(); useSurveys(s);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await call(base, "POST", `/${s.id}/respond`, { body: {} })).status);
      expect(codes).toEqual([400, 400, 400, 429, 429]);
    } finally { delete process.env.CIVIC_SURVEY_RESPOND_PER_MIN; }
  });
});
