# People Pulse — Telugu States (AP + Telangana): Redesign

## 1. Goal
One public-opinion + election-intelligence platform for **Andhra Pradesh (175 assembly / 25 LS)** and **Telangana (119 assembly / 17 LS)**: citizens give structured feedback, anyone can explore verified election history and census context down to constituency level, and analysts see trend/swing/alliance analytics.

Today's app is AP-only, all data hard-coded and synthetic (`src/data/staticData.ts`). The redesign makes **state a first-class dimension** and replaces synthetic numbers with a **sourced, versioned data layer**, keeping synthetic survey data clearly labelled "Demo".

## 2. Data honesty rules (non-negotiable)
- Every number shown carries a `source` + `asOf`. Seed/synthetic data carries `provenance: "demo"` and renders a "Demo data" badge.
- Survey results are **not** predictions. The UI shows sample size, margin of error, and weighting method; below n=30 per cell they are suppressed.
- No individual voter data. Respondents are stored as hashed phone/email + demographics buckets only.

## 3. Data sources
| Need | Source | Access |
|---|---|---|
| Assembly + LS results 1951→2024 (candidate level, votes, margin, party) | **TCPD Lok Dhaba** (Ashoka Univ.) CSV; ECI statistical reports | Download CSV → `pipeline/` ingest |
| Latest results 2023 TG, 2024 AP/TG, by-polls | **ECI results portal** (results.eci.gov.in) | Scraper w/ fixtures; fallback to TCPD |
| Booth-level (Form 20) | ECI CEO AP / CEO Telangana PDFs | Phase 3, OCR/manual |
| Constituency boundaries (post-2008 delimitation) | **DataMeet maps** GeoJSON (github.com/datameet/maps) | Fetch raw GitHub |
| District/state boundaries (AP 26, TG 33) | DataMeet / Survey of India derived | GeoJSON |
| Census 2011 PCA (population, SC/ST, literacy, workers, sex ratio) district + sub-district | **Census of India PCA**, mirrored on data.gov.in (Open Government Data) | `DATA_GOV_IN_API_KEY` (free) → API; else CSV |
| Census 2027 / caste enumeration | Not yet published | Schema is versioned by `censusYear` so 2027 drops in |
| Electors / turnout / gender ratio, SSR roll stats | ECI / CEO state portals | CSV ingest |
| News/misinformation | Fact-check feeds (optional) | Phase 4 |

Pipeline output is **static JSON snapshots** committed under `data/generated/` (state-scoped), so the app works offline and CI is deterministic. API keys never reach the browser.

## 4. Election-trend features (latest trends)
Grounded in the 2023 TG, 2024 AP/TG outcomes (verify against ECI before publishing — the ingest tests pin totals):
1. **Alliance arithmetic** — AP 2024 was won by a pre-poll TDP–JSP–BJP alliance. Model *party* and *alliance* vote share per election; "what if" alliance toggle (re-aggregate historical votes under an alliance) with consolidation-of-vote caveat.
2. **Swing & margin analysis** — swing vs previous election of same type, margin buckets (<2%, 2–5%, 5–10%, >10%), "marginal seats", bellwethers (seats that matched the statewide winner N times).
3. **Assembly vs Lok Sabha split-voting** — constituencies where LS and Assembly winners differ within the same year (AP/TG 2014, 2019, 2024).
4. **Turnout & electors** — turnout trend, gender turnout gap, urban/rural, NOTA share.
5. **Welfare-scheme sentiment** — women-centric DBT schemes are a driver in both states; surveys carry a dedicated scheme-awareness/approval module.
6. **Regional cleavages** — AP: Uttarandhra / Coastal / Rayalaseema; TG: Hyderabad-GHMC / North / South; capital-region (Amaravati) and Hyderabad urban dynamics.
7. **Youth & first-time voters, caste/community blocs from census context** (SC/ST reserved seats exposed from delimitation data; no caste-vote inference).
8. **Poll-of-polls** — aggregate our surveys + imported public polls with house-effect adjustment (Phase 4).
9. **Misinformation guardrails** — visible methodology, source links, no deepfake/AI-generated "results"; share-cards embed provenance.

## 5. Architecture
```
 pipeline/ (Node, tsx)            data/generated/<state>/*.json   (committed snapshots)
  census.ts ─┐                           │
  elections.ts ─┼─ normalize ─ validate ─┘
  boundaries.ts ┘
                                           ▼
 server.ts (Express)  /api/v1/states, /elections, /constituencies, /census, /surveys
    └─ src/lib/elections.ts (pure analytics, unit-tested)
                                           ▼
 React app (Vite): StateSwitcher → Home | Elections | Constituency | Map | Survey | Admin
```
- **Domain core** (`src/lib/`): pure TS functions (swing, margins, alliance aggregation, split-voting) — no I/O, fully unit-tested.
- **State config** (`src/lib/states.ts`): AP and TG metadata (seat counts, regions, party palette, languages).
- **API** versioned `/api/v1`, JSON, read-only for public data; survey writes rate-limited.
- **i18n**: English + Telugu (`te`) strings; all new UI uses a `t()` helper. Telugu-first mobile layout.
- **Storage**: Phase 1 file-based JSON + existing localStorage; Phase 3 moves survey responses to SQLite/Postgres behind a repository interface.
- **Accessibility/perf**: WCAG AA contrast, keyboard-navigable map with table fallback, 3G-friendly (data split per state, lazy-loaded GeoJSON).

## 6. Information architecture
Home (state switcher, headline cards, latest result) · **Elections** (results explorer, trends, swing, alliances) · **Constituency** (profile: history, census context, survey) · **Map** (district/constituency choropleth, layer = winner/margin/turnout/census) · **Survey** · **Compare** · **Reports/Methodology** · **Admin** (data refresh status, survey moderation).

## 7. Testing & automation
- Unit (Vitest): analytics, validators, ingest normalizers w/ fixtures.
- API integration (Vitest + supertest-style fetch against ephemeral server).
- E2E (Playwright, Chromium): each scenario in `docs/E2E_SCENARIOS.md` maps to a spec tagged with its ID (`@E2E-01`).
- Data quality gate in CI: seat counts (AP 175/25, TG 119/17), no duplicate constituency IDs, votes ≥ margin, shares sum ≈100%.
- Story tracker (`docs/stories/tracker.json`) is the source of truth; `npm run tracker` regenerates `docs/STORY_TRACKER.md` and fails CI if a done story lacks an automated test reference.

## 8. Risks
Election data licensing/attribution (cite TCPD/ECI, CC-BY-NC for TCPD → non-commercial note); ECI site structure changes (scraper fixtures + TCPD fallback); Census 2011 is stale for 2026 (labelled, 2027 pending); AP/TG district reorganisation (map 2011 districts ↔ current via crosswalk); political-neutrality (no editorial party ranking; alphabetical default ordering).
