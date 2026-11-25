# Independent cryptographic review: handoff pack (internal, prepared by the builders)

Status: this is a scoping document for a human to commission a review. It is the builders' own description. It is not a review, no reviewer has been engaged, and nothing here is approved. Owner and date for the commissioning are intentionally blank.

Commissioned by: ____________  Reviewer (independent of the builders): ____________  Date: ______

## 1. What is to be reviewed

The anonymous survey credential: an RSA blind-signature scheme, RFC 9474 RSABSSA-SHA384-PSS-Randomized, so a verified resident can answer a survey once without the answer being linkable to their account by the application or its operator (within the limits in `docs/THREAT_MODEL.md` section 5). Design text: `docs/SURVEYS.md` ("Credential, single shot and responses", "Blind signatures (S-30)").

Parameters: RSA-2048 minimum (`CIVIC_SURVEY_KEY_BITS` may raise it, never lower), e = 65537, SHA-384, MGF1-SHA384, 48-byte salt, 32-byte random message prefix, 32-byte random token. One key pair per (survey, key class), key classes `T1`, `T2`, `T1_LOW`, `T2_LOW`.

## 2. Files in scope

| File | Role | Lines |
|---|---|---|
| `server/civic/surveys/blind.ts` | Server primitives: BigInt `modPow`/`modInv`, key generation (`node:crypto`), `blindSign` (re-blinded RSA private operation with a self-check), `verifyCredential` (node OpenSSL RSASSA-PSS), `spentKey`, plus a reference client (`emsaPssEncode`, `referenceBlind`, `referenceFinalize`) used by tests | 124 |
| `src/lib/blind.ts` | Browser client: random token, prefix and salt, hand-written EMSA-PSS encode, blind (`m * r^e`), finalize (unblind, then verify with WebCrypto before use). Written independently of the server reference client | 94 |
| `server/civic/surveys/credential.ts` | Protocol composition: eligibility, one signature per person per survey (`has_responded` inserted in the same transaction as the signature), 10-minute idempotent retry window (signature stored encrypted, keyed by nonce hash), key-class binding, signing-key storage (private exponent encrypted with the civic key provider, purpose `survey-credential`), `/respond` redemption, spent-token table, per-network respond limiter | 247 |
| `server/civic/surveys/responses.ts` | What is stored at redemption: no person id, token, signature or timestamp; encrypted journal, shuffled batch flush, random row ids | 159 |
| `server/civic/surveys/eligibility.ts`, `server/civic/core/index.ts` (key provider) | Who may obtain a credential; key custody (DEV-ONLY provider today, gate row 4) | n/a |

## 3. Tests and vectors present

- `tests/civic/surveys/blind.test.ts` (@E2E-39): browser client output verifies on the server and vice versa; server reference client and browser client interchangeable; distinct blinding per request; forged, altered and out-of-range inputs rejected (bit flip, wrong token, wrong prefix, random signature, short signature, zero, `n+1`, wrong length, other key); keys below 2048 bits refused; fixed vectors.
- `tests/civic/surveys/blind.vectors.json`: a throwaway published RSA-2048 key and cases with fixed prefix, token, salt and blinding factor r, giving byte-exact blinded message, blind signature, final signature and spent key, checked on both implementations.
- `tests/civic/surveys/credential.test.ts` (@E2E-38, @E2E-39): single shot (second request is 409, no re-issue), atomic rollback, retry window (same nonce and blinded value returns the same signature; different blinded value is refused; expired window), key-class mismatch, replayed token rejected, token not redeemable at another survey, forged or altered credentials, answers not matching the frozen question set do not spend the credential, respond flood slows down.
- `tests/civic/hardening/redteam.test.ts`: points at the replay and cross-survey tests (internal self-assessment).

## 4. Known limits, stated by the builders

1. The throwaway vectors are self-generated. The official RFC 9474 Appendix A.1 vector (RSABSSA-SHA384-PSS-Randomized, 4096-bit) is now in tests/civic/surveys/rfc9474.vector.json and passes byte for byte on both the server code and the browser client (tests/civic/surveys/rfc9474.test.ts: encoded message, blinded message, blind signature, final signature, OpenSSL verification). The RFC lists further vectors for other variants (A.2 to A.4); this system uses only the randomized variant, so they were not run. An independent reviewer should still confirm.
2. The EMSA-PSS encoder is hand-written twice (server reference, browser). Server verification uses OpenSSL, which independently checks the encoding; the tests verify the output of both encoders that way, so a wrong-but-consistent encoder pair is excluded by that check and by the self-generated vectors, but not by any third-party vector.
3. BigInt `modPow` is not constant time. Mitigation: `blindSign` multiplies by a fresh random `r^e` before exponentiating by d and divides after, so the caller does not choose the exponentiated value; the result is checked with the public key before release. No timing measurement has been made.
4. `blindSign` accepts any value in (0, n); it does not reject values sharing a factor with n (negligible for random RSA moduli, but not checked).
5. Key generation uses `crypto.generateKeyPair`; private keys are stored encrypted by the dev key provider (all keys derived from one environment string). Real custody is gate row 4 and out of scope for the cryptographic review but affects what the scheme protects.
6. Protocol composition is the builders' own design: key classes (tier and number-quality encoded in which key signed, so published figures can show quality strata), a spent-token table keyed by `sha256(prefix||token)`, shuffled batching of stored responses, and a 10-minute retry window that keeps (person, survey, encrypted blind signature) in the identity store. Timing and network metadata links (the credential request and the respond call from the same address and time) are mitigated only by advice to delay and by not logging IPs; they are not eliminated.
7. Eligibility inputs (account age, tier, residence, number intelligence) are not part of the cryptography and are tested separately.
8. Results are statistical outputs of a self-selected, non-representative pilot; that is a methodology issue (`docs/SURVEY_METHOD.md`), not a cryptographic one.

## 5. Questions for the reviewer

1. Does the implementation conform to RFC 9474 for the randomized variant (message preparation with the 32-byte prefix, EMSA-PSS parameters, blinding, finalize and verify)? The Appendix A.1 vector has been run by the build team (see section 4 item 1); please confirm and consider the other variants out of scope.
2. Is the hand-written EMSA-PSS encoder correct for all key sizes the system allows (2048, 3072, 4096) and for emBits not a multiple of 8?
3. Is the re-blinding in `blindSign` sound, and is the residual timing exposure of BigInt arithmetic acceptable here? Should the private operation move to OpenSSL (`crypto.privateDecrypt` with no padding, or a native binding)?
4. Does the combination of per-class keys, the retry window and the spent-token table leak anything linking a credential request to a response beyond what the threat model section 5 admits? In particular the key-class partition size when classes are small (T2 and LOW classes).
5. Is a per-survey, per-class key the right granularity; what are the key-generation, rotation and destruction requirements after a survey closes?
6. Is verifying the unblinded signature in the browser (and refusing to use an invalid one) sufficient protection against a malicious signer, including a signer that signs with a different key per user (key-tagging)? The client fetches the public key from a plain GET; there is no key transparency or consistency check. Is one needed?
7. Is the 32-byte token plus 32-byte prefix and the `sha256(prefix||token)` spent key adequate against collisions and enumeration?
8. Review of `docs/SURVEYS.md` claims about what the response store can and cannot say, against `responses.ts`.

## 6. How to run what exists

```
npx vitest run tests/civic/surveys/blind.test.ts tests/civic/surveys/credential.test.ts
npx vitest run tests/civic/hardening/redteam.test.ts
```

Source is at the commit that contains this file; record the commit hash when commissioning.

## 7. Deliverables to ask for

Written findings with severity, fix-or-accept status for each, a statement of which RFC 9474 vectors passed, and the reviewer's name, independence statement and date, to be attached under `docs/gate/` by a human. Findings should also be appended to `docs/THREAT_MODEL.md` section 8.
