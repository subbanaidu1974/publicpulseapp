# Decision memo 1: operator, funding and legal structure (S-152) - DRAFT FOR THE OWNER TO DECIDE

Status: **Owner chose, on 2026-11-24, an independent non-profit with a university or civil-society host for the pilot, funded by the owner or one named grant (disclosed). Open items remain in section 4.** Original status: no decision had been made; this memo prepared one. It is not legal or tax advice. Every trade-off is labelled **[REPO-FACT]** (stated in this repository's own docs), **[VERIFIED]** (read from a primary source this session, URL given) or **[ASSUMPTION]** (engineering judgement, not checked). Almost everything about the legal structures is [ASSUMPTION]; counsel and a chartered accountant must check it before anyone relies on it. This is the design gate in DESIGN_2028 section 8.1 and decision A1.

## 1. Design constraints the operator must satisfy
1. **Neutrality.** The product must not look run by or for a party or government. [REPO-FACT: DESIGN_2028 A1 "independent operator; departments are tenants; funders and board published, no party/government money above a cap"; Terms page says it is not run by a party, government body or the Election Commission.]
2. **Model Code of Conduct and survey-publication rules.** Who the operator is affects whether and how they bind it. [ASSUMPTION; questions E3, E4 in the counsel pack.]
3. **Data Fiduciary duties.** The operator is likely the Data Fiduciary and must publish a contact, give notices, answer rights requests within 90 days and notify breaches. [VERIFIED for these duties as summarised by PIB: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf ; applicability to us is for counsel.]
4. **Funding conflict.** Funders must not buy influence over survey topics, wording or publication. [REPO-FACT A1, A4.]
5. **Continuity.** If the operator closes, data must not pass to a party or be sold; an exit plan and data-on-shutdown rule are needed. [REPO-FACT: DESIGN_2028 section 8.1 asks for exit plan.]
6. **Who can run an HSM/KMS.** Keys for phone hashing, field encryption and signing must sit in a KMS/HSM the operator controls with dual control and published break-glass. [REPO-FACT: DESIGN_2028 3.1, 3.8 items 3 and I1.] Needs a legal entity able to contract a cloud/HSM provider and staff to run key ceremonies.
7. **Accountability.** Public audit log, anchored externally; named grievance officer; board and funder list published. [REPO-FACT A3.]
8. **Statutory contact points.** CERT-In directions bind "service providers, intermediaries, data centres, body corporate and Government organisations" and require a Point of Contact and 6-hour incident reports. [VERIFIED from the CERT-In PDF; see docs/compliance/INCIDENT_AND_VDP.md.] Any option needs a named entity to hold these.

## 2. Options and trade-offs

Scale of fit: **Fits / Partly / Weak / Unknown.** Every cell is [ASSUMPTION] unless stated.

| Constraint | A. Non-profit trust | B. Section 8 company | C. University or civil-society host | D. Government-hosted (NIC / state IT) | E. Commercial with public-interest charter |
|---|---|---|---|---|---|
| Neutrality | Fits if trustees are independent and published | Fits; board and members published | Fits if the institution is not seen as aligned; reputational anchor | **Weak**: visible state hosting undermines trust, esp. around state elections | Partly: depends on shareholders; charter is only as strong as its enforcement |
| MCC / survey rules exposure | Unknown (counsel) | Unknown (counsel) | Unknown; institution may have its own rules | Likely **heavier**: government service during MCC [ASSUMPTION] | Unknown |
| Data Fiduciary duties | Trustees personally exposed? (counsel) | Company is the fiduciary; clear officers | Institution becomes fiduciary or a processor; ethics board adds review | State as fiduciary; different exemptions may apply [UNVERIFIED] | Company is the fiduciary |
| Funding conflict | Donor grants; cap and disclosure possible | Same; also CSR funds possible but tied to rules [UNVERIFIED] | Grant-funded; institution may have donor rules | Budget from government: the conflict itself | Revenue from clients (parties? departments?) is the conflict; charter must bar it |
| Continuity | Trust deed controls dissolution; slower to change | Company law sets winding-up and asset lock for such companies [UNVERIFIED] | Strong while the institution wants it; can lose champion | Strong operations, **policy risk** (change of government) | Weak: sale or insolvency; needs asset-lock |
| Can run KMS/HSM | Needs staff and cloud contract; small team | Same, cleaner contracts | Institution may bring IT security staff and policy | NIC infrastructure available; **key custody by the state** conflicts with neutrality | Fits; vendor may hold keys (must not) |
| Accountability | Registrar filings, trustees | Registrar of Companies filings, auditor, board | University governance, ethics board | RTI, audit and legislature [UNVERIFIED] | Shareholders; weaker public accountability |
| Speed to start the pilot | Medium | Slower (incorporation and compliance) | **Fast** if an institution agrees | Slow (approvals) and politically loaded | **Fast** |
| Cost of ongoing compliance | Low to medium | Medium (annual filings, audit) | Low (institution absorbs) | Low to the project, high in lost independence | Medium |

Notes on each (all [ASSUMPTION] unless marked):
- **A. Non-profit trust.** Simple to set up in principle; rules differ by state (registration process, tax status). Trustee liability and ability to contract with a cloud vendor need counsel. Change of trustees is a capture risk, so the deed needs independent-trustee and quorum rules.
- **B. Section 8 company.** A company limited to non-profit objects with no dividends. Clear directors, audit and filings; a stronger public paper trail. Slower and costlier to incorporate than a trust. Whether CSR funding is allowed and desirable (corporate funders can be party-adjacent) is a policy decision.
- **C. University or civil-society host.** Can host the pilot as a research or public-interest project and also serve as an **independent witness** for the audit-log anchor (DESIGN_2028 3.8 item 5 names a university as a possible witness). Risks: the institution's own funding and governance, student and staff turnover, an ethics-board process, and whether the institution can be a Data Fiduciary and hold keys.
- **D. Government-hosted.** Most reliable infrastructure and most direct route to departments, but the threat model lists the operator under government pressure as an adversary (DESIGN_2028 3.8) and neutrality is the central trust claim. [REPO-FACT for the threat model.] I would not treat this as an acceptable operator for the survey component; a department could still be a **tenant** (A1).
- **E. Commercial with a charter.** Fastest. The charter, an independent oversight board, an asset lock, and a ban on selling data and on political clients would all need contractual force; counsel to test enforceability.

## 3. Recommendation (a recommendation only; the owner decides)
**Recommended for the owner to consider:** an independent **non-profit entity** (either a section 8 company or a registered trust; counsel and a chartered accountant should choose between them) with: a published board that includes no party office-bearer or serving officer; a **funding cap and disclosure** rule; a **university or civil-society partner** as pilot host or fiscal sponsor and as an audit-log witness so the pilot can start before the entity is fully formed; the KMS/HSM contracted in the entity's name in an India region with dual-control custody; the departments as tenants only. Reasons: it best matches constraints 1, 4, 5 and 7 as I read them, and it keeps option C as a fast bridge. This rests on assumptions above that no one has verified. Option D is not recommended for the survey component; option E only if the owner needs speed and accepts the charter risk.

## 4. Questions that need answers (owner, then counsel)
Owner:
1. Which option, or a hybrid (for example a university hosts the pilot, a section 8 company runs state-wide)?
2. Named founding board and who appoints the independent wording panel (DESIGN_2028 8.2). Any party or government link among them?
3. Who pays for SMS, IVR and data, and the per-user budget (8.6)? Who are the candidate funders, and what is the cap per funder?
4. Exit plan: what happens to data and keys if the entity closes; which institution inherits the archive (or is it deleted)?
5. Who holds the grievance officer, CERT-In contact and key-custodian roles?
6. Will the owner accept a pilot hosted by a partner under a written agreement, and who signs it?
Counsel:
7. For each option: does it make us a Data Fiduciary, a Significant Data Fiduciary candidate, or an intermediary; any exemptions available or lost.
8. MCC and survey-publication exposure per option (counsel pack section d).
9. Is the entity a "public authority" under the RTI Act in any option?
10. Tax and registration steps, FCRA if any foreign money is contemplated, trustee/director liability.
11. Enforceability of an asset lock and a funding cap.

## 5. What happens after the decision
Record the decision in DESIGN_2028 section 8.1 and the story tracker (a human step), set the entity name in the notices (gap G3 in the counsel pack), appoint the officers, and rerun the cost model with real quotes (cost-model.md).
