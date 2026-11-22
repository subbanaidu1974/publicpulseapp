# Phase 1 plan (pilot): who owns what

Scope = stories tagged `2028-P1` in tracker.json. Gated in the design on operator/funding and counsel sign-off; development proceeds on explicit instruction, behind dev-only providers (no real SMS, no HSM). Nothing here is production-ready.

| Agent | Stories | Owns |
|---|---|---|
| A core + identity | S-18, S-19, S-20, S-42, S-43 | server/civic/core/**, server/civic/identity/**, tests/civic/core*, tests/civic/identity* |
| B households + compliance | S-21, S-22, S-44 | server/civic/households/**, src/components/civic/Household*, Consent*, tests/civic/households* |
| C geography + issues | S-23, S-24, S-25, S-26, S-27 | server/civic/geo/**, server/civic/issues/**, data/civic/**, tests/civic/geo*, issues* |
| D channels, UI shell, a11y, gate docs | S-45, S-47, S-48 | server/civic/channels/**, src/components/civic/** (except B's), e2e/civic-*.spec.ts, docs/THREAT_MODEL.md |

Shared contract: server/civic/core/index.ts (frozen signatures). Storage: node:sqlite. Providers: dev SMS and dev key provider only.
