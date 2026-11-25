# S-64 decision note: key management (KMS or HSM), what the code needs, and a test plan

Status: DRAFT for the owner. Research of 2026-11-24 from public documentation pages; no account was opened and nothing was run against a real service. Not legal advice. S-64 is closed as what is built; a provider, an account under the operating entity and a pass against the real service remain a launch prerequisite.

## 1. How our code uses a key service (this narrows the choice)

`server/civic/providers/keys.ts` and `awskms.ts` use envelope encryption: the key service holds only a key-encryption key (KEK). The app generates one random 32-byte data key per purpose and version, wraps it with the key service's `Encrypt`, and unwraps it with `Decrypt`, binding the purpose and version as extra context so a wrapped key replayed under another purpose fails. The unwrapped data keys live in process memory (cached, zeroed on retire).

What follows:
* **Any provider with symmetric encrypt, decrypt and an encryption-context or equivalent works.** We do not need the provider to do HMAC or signing for us. That widens the options.
* **The provider never sees the plain data keys after wrapping, but the running app does.** A compromise of the running server exposes keys in memory while it runs. That is inherent to this design and should be stated to the independent crypto reviewer and in the threat model. A design that sends every HMAC to the key service would avoid it but adds latency, cost and a hard dependency on every request.
* The only adapter built is AWS KMS (SigV4 on `node:crypto`, static credentials only), verified against a local simulator. A second provider would need its own adapter and contract tests.

## 2. Options (public claims, unverified)

| Option | What the docs say | Fit |
|---|---|---|
| AWS KMS | The developer guide says [HMAC keys](https://docs.aws.amazon.com/kms/latest/developerguide/hmac.html) are supported in every region that KMS supports, with FIPS 140-3 hardware. India regions (Mumbai, Hyderabad) were not named in what I found; a region's support is confirmed by trying to create the key | Adapter already exists; best-known; US-headquartered provider |
| Google Cloud KMS or Cloud HSM | [MAC keys](https://docs.cloud.google.com/kms/docs/create-validate-mac-signatures) support HMAC signing; the [locations page](https://docs.cloud.google.com/kms/docs/locations) lists Mumbai and Delhi but my extraction was garbled; key material stays in the chosen region | Needs a new adapter; US-headquartered |
| Azure Key Vault or Managed HSM | Not researched | Ask; needs a new adapter |
| Government or sovereign cloud HSM | Not researched | The operator memo flags state custody of keys as a neutrality problem |
| Self-hosted HSM in an Indian data centre | Not researched | Staff and key-ceremony burden; consistent with a non-profit that wants full control |

Whether a US-headquartered provider holding the KEK is acceptable for pseudonymised phone data of Indian residents is a counsel question, not an engineering one.

## 3. Test plan (before any contract)

1. After the operating entity exists (S-152), open an account under it. Do not use a personal account for production.
2. Create a KEK in an Indian region, and prove the region claim by reading the key's metadata and the provider's data-residency statement.
3. Run the adapter's contract tests against the real service with credentials restricted to Encrypt and Decrypt on that one key. The adapter currently supports static credentials only; production should use a short-lived role instead. That is a small change to plug in (the credentials option accepts a function) but it must be built and tested before production.
4. Run the rotation and break-glass drill from `docs/PROVIDERS.md` once and record it under `docs/gate/04/evidence/` (gate row 4 needs "configuration evidence and a drill record").
5. Record the price per key per month and per 10,000 requests in `data/reference/cost-assumptions.json` with source and date.

## 4. Decisions for the owner and counsel

* Provider: stay with AWS KMS (adapter exists) or choose another and accept building a second adapter.
* Whether a US-headquartered provider may hold the KEK (counsel).
* Who holds the break-glass roles; two named people independent of each other, appointed by the entity.
* Whether to accept "data keys exist in server memory while running" for the pilot, or require a design that does not.

S-64 is closed as "what is built" (owner decision 2026-11-25): the adapter, guards and this plan. A real provider passing the contract tests, short-lived credentials and an attached drill record remain a launch prerequisite.
