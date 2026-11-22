# Gate row 4: Keys in HSM/KMS with per-purpose keys, rotation and dual-control break-glass

Row 4 of `docs/RELEASE_GATE.md`. This page says exactly what a human must attach. The owner and date are filled in on the row in RELEASE_GATE.md by the person who accepts responsibility; nothing in this repository assigns them. Run `npm run gate:status` to see where the row stands.

## Evidence required

1. Configuration evidence that the production KeyProvider is an HSM/KMS adapter: provider, region, key ids (never key material), per-purpose key list.
2. A rotation drill record: what was rotated, the re-pseudonymisation migration if the HMAC key changed, and the result.
3. A break-glass drill record showing two named people were needed.

## Acceptance criteria

- Production starts without CIVIC_DEV_MASTER_KEY.
- Each purpose has its own key; the key cannot be exported.
- A rotation was performed and the system worked afterwards, including decrypting old ciphertext and verifying the audit chain.

## Automated evidence (in this repository)

These support the row; they do not satisfy it. `npm run gate:status` checks that each path exists (and that a `#@E2E-NN` tag appears in the file).

- `tests/civic/guards.test.ts#@E2E-70` - production refuses the dev provider
- `server/civic/core/index.ts` - KeyProvider interface (the adapter contract is in the comment above it)

## Template

Copy this into `docs/gate/04/evidence/<date>-summary.md`, fill it in, and attach the underlying artefacts (reports, agreements, logs) in the same folder. Do not put secrets, key material or personal data in this folder.

```
KMS/HSM: ____ ; region: ____ ; adapter commit: ____
Purposes and key ids: ____
Rotation drill: date ____ operator ____ result ____
Break-glass drill: date ____ approvers ____ and ____ result ____
```

## Attach

Put the artefacts in `docs/gate/04/evidence/`. A row counts as having human evidence only when that folder holds at least one file other than `.gitkeep`. Then, and only then, a named person sets the owner and date on the row in RELEASE_GATE.md and checks the box.
