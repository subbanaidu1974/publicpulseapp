# Threat model (Phase 1 pilot) - S-48

Status: DRAFT for the pilot, published with the code as DESIGN_2028 section 3.8 requires. It describes what the code in this repository does today and what is still only a plan. Anything marked **[PLAN]** is not implemented. Anything marked **[VERIFY]** needs counsel or an independent reviewer. Nothing here has been red-teamed yet (see `docs/RELEASE_GATE.md`).

## 1. What this system is and is not

A civic participation platform: verified residents report local issues, track them, and (later) answer issue/service surveys. It is **not** an election, and it publishes no vote forecast. Phase 1 runs behind dev-only providers (no real SMS, no HSM); the controls below describe the target and the current state.

## 2. Assets

| Asset | Why it matters |
|---|---|
| Phone number to person link | Re-identification, harassment, targeting |
| PIN hashes, session tokens, OTP secrets | Account takeover |
| Residence and household data | Location privacy; small-village re-identification |
| Issue reports (text, voice notes, village) | May name individuals; may expose reporters |
| Survey responses (later phases) and the "has responded" flag | Secrecy of opinion; coercion |
| Audit log | Proof of what operators and officers did |
| Keys (pepper, signing, encryption) | Root of every other control |
| Published aggregates and issue metrics | Public trust; manipulation target |
| Sender identity and notification channel (later phases) | Phishing and false emergency messages |

## 3. Adversaries

Political parties and paid crowds; organised cadres with real phones; insiders (officers, volunteers, admins); sender-account hijackers; DDoS and booter services; the operator itself under pressure; state-level actors.

## 4. Controls mapped to DESIGN_2028 3.8

| 3.8 item | Control | State in this repo |
|---|---|---|
| 1 Written threat model | This document, including section 5 | Done (draft) |
| 2 Sybil / OTP-farm cost raising | Number-intelligence lookup (VoIP block, recently re-issued flag), 14-day age gate (`eligible_from`), per-phone/IP/device OTP caps, per-SIM adult cap, global OTP-send budget | Implemented in `server/civic/identity` with dev number-intelligence provider. Device attestation, per-ASN caps, cohort anomaly review before publishing, published anomaly stats: **[PLAN]** |
| 2 Real-person brigading | Weighted and unweighted views, source-cohort reporting, me-too caps per person per day, dedupe of near-identical issues | Me-too caps and dedupe implemented in `server/civic/issues`; weighted/unweighted survey views **[PLAN]** (surveys not in Phase 1) |
| 3 Keys and store separation | Per-purpose keyed hashing and encryption behind a `KeyProvider` | Dev provider only (local key). HSM/KMS adapter, rotation, dual-control break-glass: **[PLAN]**. Separate identity/issue/survey stores with no cross-store joins: identity and issues share one SQLite file in the pilot, so this is **not met** |
| 4 Sender security | FIDO2 keys, signed payloads, anti-phish word, kill-switch | **[PLAN]** (no sender or notification feature exists in Phase 1). The SMS and IVR copy already says "we never ask for OTP or bank details" |
| 5 Audit log | Hash-chained append-only log; no phone numbers, PINs or response contents in metadata | Chain implemented in core. External anchoring with independent witnesses, privileged-read logging, redacted public view: **[PLAN]** |
| 6 Count day | Signed multi-CDN snapshots, queues, OTP budget | OTP-send budget and missed-call callback budget are implemented; the rest is **[PLAN]** and out of Phase 1 scope |
| 7 Breach blast radius | Retention job, account erasure, grievance officer, notices | Erasure and retention job in identity; consent notices and grievance officer placeholder in households (draft wording). Erasure reaching the audit log by redaction, CERT-In reporting, bug bounty: **[PLAN]** / **[VERIFY]** |
| 8 Release gate | Independent red-team and pilot skew evaluation | Checklist in `docs/RELEASE_GATE.md`; not yet executed |

Channel-specific controls (S-45): the missed-call callback is rate limited per number and has a global hourly budget; callbacks send no SMS and ask for no OTP; IVR menus carry no election or party content; audio and recording keys are validated as opaque keys (no traversal); the PWA-lite service worker caches only static assets, never API responses and never map tiles; USSD is deliberately not built.

## 5. What secrecy does NOT guarantee

Read this before relying on any claim of anonymity.

1. **Not cryptographic ballot secrecy.** Even in later survey phases, "has responded" lives with the identity service and answers in a separate store with coarse strata only. This reduces linkage; it does not make linkage impossible. Whoever controls both stores plus the keys, or a court-ordered or coerced operator, may be able to rejoin them.
2. **Small groups re-identify people.** In a small village, a combination of village, age band and gender can point to one person. Minimum cell sizes (30) and roll-up reduce this but cannot remove it, and issue reports with free text or voice can identify the reporter by content alone.
3. **Network and telecom observers see metadata.** The SMS provider, telecom and IVR aggregator see that a number sent or received a message or call, and when. Voice notes carry the speaker's voice. Missed-call and IVR channels run over operators we do not control.
4. **Phones are not trusted.** A shared phone, a family member watching, coercion at home, or a stolen unlocked device defeats any app-level secrecy. A household head cannot see members' answers by design, but can see the roster and can pressure members.
5. **Number recycling and SIM swap.** A recycled or swapped number can receive OTPs; flags and age gates reduce the risk, they do not remove it.
6. **Dev providers are not production.** Dev OTP exposure (`CIVIC_EXPOSE_DEV_OTP=1`, refused in production), the local dev key, and the console SMS provider provide no real protection.
7. **The operator is a trusted party until controls are real.** Until HSM/KMS, dual control and external audit anchoring exist, a malicious operator or admin with server access can read or alter data.
8. **Audit logs prove order, not truth.** A hash chain without external anchors can be rebuilt by whoever holds the database.
9. **Legal compulsion.** Law-enforcement and court-order access is a policy question **[VERIFY]**; technical controls do not override it.
10. **The pilot is a signal, not a representative sample.** Phone ownership, gender and age skew who participates; results must carry that caveat.

## 6. Residual risks accepted for the pilot

Single-store deployment; dev key provider; in-memory IVR call state (lost on restart, calls simply restart); IVR personal-PIN step not built, so shared SIMs are refused over IVR rather than guessed; audio files are placeholders; no device attestation.

## 7. Review cadence

Re-read at each release gate and whenever a new channel, role, or data store is added. Findings from the independent red team must be appended here with status.
