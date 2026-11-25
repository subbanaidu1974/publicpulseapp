# S-62 decision note: number-intelligence vendor, and a test plan to choose one

Status: DRAFT for the owner. Research of 2026-11-24 from public web pages, not from vendor contracts or sandboxes. Every claim below is a vendor's or a news page's own statement and is UNVERIFIED until tested. No vendor was contacted. This is not a recommendation to buy; it is a plan to find out cheaply which source actually works for Indian numbers.

## 1. What the platform needs from a lookup

The adapter (`server/civic/providers/numberintelHttp.ts`, simulator-verified only) fills: line type (prepaid, postpaid, VoIP, landline), `recycled` (the number was disconnected and reissued), `portedRecently`, the telecom circle, and optionally an activation age with a confidence. The platform uses these to weigh sign-ups (a very young or recycled number is a weaker identity signal). If the lookup fails the number gets "reduced trust" and sign-up still works (the failure policy is built and tested).

## 2. What exists (public claims)

| Source | What it claims | Fit for our needs |
|---|---|---|
| [Infobip Number Lookup](https://www.infobip.com/docs/number-lookup.md) | In India it does not query the HLR; it reads Mobile Number Portability data, and if a number is not ported the network is guessed from the prefix | Line type and porting status maybe; no recycled-number signal; carrier may be wrong for unported numbers |
| [Veriphone, India page](https://veriphone.io/countries/india) | Circle-level, mobile-only public data; best-effort prefix-level operator; a "current" mode resolves ported numbers | Cheap check of line type and circle; no recycling signal stated |
| [Abstract API carrier lookup](https://www.abstractapi.com/tools/carrier-lookup) | Says carrier comes from live HLR and MNP databases | Not stated for India specifically; ask |
| [Telnyx number lookup](https://developers.telnyx.com/docs/identity/number-lookup/index) | Porting and line-type fields | Portability described for North American numbers; India coverage unclear |
| DoT Mobile Number Revocation List (MNRL) through the [DoT Digital Intelligence Platform](https://www.india.gov.in/category/science-it-communication/subcategory/post-telecom/details/mobile-number-revocation-list-mnrl-portal) | Disconnected-number data; TRAI [discontinued its public MNRL publication](https://cms.trai.gov.in/sites/default/files/2024-11/Order_MNRL_discontinuaiton_21112024.PDF) and the feed moved to DoT's platform; regulated firms were directed to use it | The only source found that speaks to disconnected numbers, which is the recycling risk. Eligibility and API terms for a non-profit were not found; ask DoT |
| Commercial MNRL API, for example [Surepass](https://surepass.io/blog/what-is-mnrl-full-form-compliance-and-methods-to-download/) | Says it returns whether a number is disconnected | A vendor product, not an official API; terms, data source and lawful basis for us unchecked |

Plain reading: carrier lookups for India are mostly prefix and portability data. None of the sources found promises an activation age. The disconnected-number list is the only signal near "recycled", and a listing is not conclusive because numbers can be reactivated.

## 3. The design risk to record

If no source gives a reliable recycled or activation-age signal, the sign-up checks rest more on the account-age gate, per-device and per-network caps, and the one-time code itself. That is acceptable for a closed pilot but must be written into the threat model as a known weakness (it already says number intelligence is imperfect; confirm the wording).

## 4. Test plan (cheap, before any contract)

1. Pick 2 or 3 candidates from the table; ask each in writing the questions in `docs/decisions/vendor-shortlist.md` section 6 plus: is the India data live MNP or prefix only, and can it return a disconnected or recycled flag.
2. Build a test set of 200 numbers **with the holders' consent**: team members' and volunteers' numbers across Airtel, Jio, Vi and BSNL in AP and TG, including at least 20 known ported numbers, some prepaid and postpaid, and a few you know were reissued. Do not use numbers collected from the platform.
3. Run the set through each candidate's sandbox or trial and compare line type, circle and porting against what the holders say. Record accuracy and latency. Do not send real residents' numbers to any vendor before a data-processing agreement is signed and counsel agrees.
4. Ask DoT, in writing, whether a non-profit civic platform may use the Digital Intelligence Platform's disconnected-number feed, and on what terms.
5. Choose, then map the vendor's real field names into the adapter's `mapping` setting and run the adapter's contract tests against the vendor's sandbox. Only then is S-62 done.

## 5. Decisions for the owner

* Who runs the vendor evaluation (suggest one engineer, one counsel, one field-operations person) and the budget for trials.
* Whether a vendor that is a foreign company, or that stores numbers outside India, is acceptable (counsel).
* Whether to accept the design risk in section 3 for the pilot if no recycled signal exists.

S-62 stays blocked until a vendor is chosen, a data-processing agreement exists, and the adapter has passed against a real sandbox.
