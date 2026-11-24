# ADR 02: Affidavit link-outs; written consent for any bulk use of MyNeta / ADR data

Status: accepted (2026-11-24). Story: S-111.

## Context
Candidate affidavit data (assets, declared cases, education) is published by the Election Commission of India (ECI) and re-organised by MyNeta, run by the Association for Democratic Reforms (ADR). ADR's terms do not allow scraping or redistribution without permission. Showing affidavit-derived figures on our pages could also single candidates out, which conflicts with the MCC neutrality rule (identical layout for every candidate).

## Decision
1. Candidate pages carry exactly two external link-outs, in the same order and with the same wording for every candidate: a MyNeta name search and the ECI affidavit portal. Labels are bilingual (EN/TE) and a note states these are external sites whose content is not copied or checked here.
2. Links are built from the candidate name only (`affidavitLinks` in `server/people-data.ts`). The server never fetches MyNeta or ECI affidavit content, never stores it, and the pages embed none of it.
3. No ranking, scoring, filtering or list of candidates by assets or cases is produced from affidavit data.
4. Any bulk use of MyNeta / ADR data (download, API use, mirrored tables, derived datasets) requires a written consent from ADR first. The ready-to-send draft is `docs/decisions/affidavit-consent-request-draft.md`. Nothing has been sent; a named person at the operator sends it and files the reply here.
5. ECI portal terms are checked separately before any use beyond a link.

## Consequences
- No affidavit figures appear in the product until consent is on file.
- Link patterns can break; the `verified` date on each link records the last manual check.
- Tests (`tests/people/affidavit-links.test.ts`) pin the identical shape, bilingual labels and the external-site note.
