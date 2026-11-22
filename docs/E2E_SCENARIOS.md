# E2E Scenarios

Each scenario has an ID used as a tag in `e2e/` specs (`@E2E-xx`). Status is tracked in `docs/stories/tracker.json`.
Layers: **API** = HTTP-level test (no browser), **UI** = Playwright browser.

| ID | Layer | Scenario | Expected |
|---|---|---|---|
| E2E-01 | API | `GET /api/v1/states` | Returns AP and TG with seat counts 175/25 and 119/17 |
| E2E-02 | API | `GET /api/v1/elections?state=TG&year=2023&type=assembly` | 119 results, winners by constituency, INC largest party |
| E2E-03 | API | `GET /api/v1/elections/AP/summary?year=2024&type=assembly` | Party seat tally sums to 175; alliance aggregation endpoint returns TDP+JSP+BJP total |
| E2E-04 | API | `GET /api/v1/elections/AP/swing?from=2019&to=2024` | Swing per party, sums to ~0 pp |
| E2E-05 | API | `GET /api/v1/elections/TG/marginal?threshold=2` | Only seats with margin < 2% of votes |
| E2E-06 | API | `GET /api/v1/census/TG/districts` | Returns census-year-tagged district rows incl. population, literacy, SC/ST % |
| E2E-07 | API | Invalid state / year → 400/404 with JSON error | No stack traces |
| E2E-08 | API | Data quality gate over all generated snapshots | Seat counts, unique ids, margin ≤ votes |
| E2E-09 | UI | Open home; switch state AP→TG | Header, headline numbers, and map change; URL has `?state=TG`; choice persists on reload |
| E2E-10 | UI | Elections page: choose TG 2023 assembly | Seat tally chart + table; "Source: ECI" shown |
| E2E-11 | UI | Toggle alliance view for AP 2024 | Alliance seats shown, caveat text visible |
| E2E-12 | UI | Search a constituency by name (English and Telugu) | Profile opens with history, census context, survey card |
| E2E-13 | UI | Map layer switch (winner → margin → turnout) | Legend updates, keyboard focus reachable, table fallback available |
| E2E-14 | UI | Compare two constituencies across states | Side-by-side with sources |
| E2E-15 | UI | Citizen takes survey (valid) | Submission accepted, thank-you, results gated until n≥30 |
| E2E-16 | UI | Survey validation: missing required field, duplicate submission | Inline errors; duplicate rejected |
| E2E-17 | UI | Language toggle EN ↔ తెలుగు | Nav and key labels translate; persists |
| E2E-18 | UI | Demo-data badge on synthetic survey stats | Badge visible; methodology link works |
| E2E-19 | UI | Admin login → data refresh status page | Shows per-source last-updated; non-admin blocked |
| E2E-20 | UI | Mobile viewport (375px) navigation | No horizontal scroll, menu usable, map table fallback |
| E2E-21 | UI | Accessibility smoke (axe) on home, elections, constituency | No critical violations |
| E2E-22 | UI | Offline/slow data: API 500 on elections | Friendly error + retry, no blank page |
| E2E-23 | Pipeline | Ingest from fixture CSV → snapshot | Normalised JSON equals golden file; re-run idempotent |
| E2E-24 | Pipeline | Census ingest with missing API key | Falls back to CSV fixture, logs warning, exit 0 |
