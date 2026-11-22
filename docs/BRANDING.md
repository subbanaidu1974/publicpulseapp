# Product naming and metadata (S-127) - DRAFT, for the product owner to approve

Status: **DRAFT working name. Not approved.** Nothing here has had a trademark or domain search.

## Proposed working name

**People Pulse** (Telugu: **పీపుల్ పల్స్**), with the descriptor "AP and Telangana public data".

Why this and not something new:
- It is already the name used across DESIGN.md, DESIGN_2028.md, the consent notices in `server/civic/households/notices` and the navbar, so changing it costs the least and keeps notices and code consistent.
- It is neutral: no party, leader, colour, slogan or election word. The "Pulse Survey" name for later opinion surveys (DESIGN_2028 B1) fits under it, and it avoids "vote", "ballot" and "result".
- It does not say "Telugu" in the name, so the product is not tied to one language in case of Hindi or Urdu surfaces later.

Alternatives considered and not chosen: "Telugu Pulse" (language-bound), "Jana Vani" (the Telugu name may read as a party or media brand; needs a native-speaker check), "Praja Pulse" (similar concern).

## Where it is used

| Place | Value |
|---|---|
| `index.html` title | People Pulse: AP and Telangana public data |
| Telugu title | పీపుల్ పల్స్: ఏపీ, తెలంగాణ ప్రజా సమాచారం (`meta.title` in `src/i18n/index.tsx`) |
| Description (EN/TE) | `meta.description` keys |
| Open Graph / Twitter | `og:title`, `og:description`, `og:locale` (+ alternate), `twitter:*` in `index.html`, kept in step with the language by `syncHead` |
| hreflang | `en`, `te`, `x-default` links injected at runtime from the live origin (`?lang=en`, `?lang=te`); the page reads `?lang=` on load |

## Open items before launch

- Owner approval of the name, then trademark and domain search (the name is common).
- `og:image`: none shipped. Use a licensed, non-partisan image; do not use a party colour palette.
- A fixed canonical production URL for hreflang and `og:url` (today built from `window.location.origin`).
- README and `metadata.json` still carry the older name text (README is another agent's task).
- Telugu strings are a machine-assisted draft until a native-speaker reviewer signs off (`reviewStatus` in `src/i18n/content.ts`).
