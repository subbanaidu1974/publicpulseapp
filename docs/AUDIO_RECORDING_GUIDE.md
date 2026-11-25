# Telugu audio recording guide (S-151) - DRAFT

Status: **DRAFT. No audio has been recorded, no speaker or linguist is chosen, and every script is a machine draft.** Technical numbers below are engineering proposals; the IVR vendor's required format is **unverified** and overrides them (ask the vendor first, see "Before recording"). Scripts: `data/civic/audio-scripts/prompts.json`. Manifest: `data/civic/audio-manifest.json`. Design basis: DESIGN_2028 3.9 (human-recorded audio, three dialect areas) and open question 7.

## Before recording
1. Ask the IVR/telephony vendor for the exact file spec (container, codec, sample rate, channels, max file size, loudness rules). Replace the delivery spec below if it differs.
2. A Telugu linguist (or two, one per dialect area) reviews each script's text first. They may change wording; changes go into `prompts.json` AND the manifest `textTe` together, in one reviewed edit, so the recorded text equals the stored text.
3. Decide how many speakers (below). Get written consent from each speaker for use of their voice in the product, for how long, and whether it may be reused; counsel to review the consent text [VERIFY WITH COUNSEL]. Voice recordings of speakers are not used for any voiceprint purpose.

## Recording spec (proposal)
| Item | Master (keep) | Delivery (to IVR) |
|---|---|---|
| Container | WAV, PCM | WAV, PCM (or what the vendor demands) |
| Channels | Mono | Mono |
| Sample rate / depth | 48 kHz, 24-bit | 8 kHz, 16-bit (telephony narrowband; vendor to confirm, some accept 16 kHz) |
| Codec | none | Linear PCM, or G.711 mu-law / A-law only if the vendor requires it |
| Peak | no higher than -3 dBFS | no higher than -3 dBFS after downsampling |
| Loudness | consistent across all files | target about -20 LUFS integrated (proposal; telephone lines add gain control, check on a real call) |
| Noise floor | below -60 dBFS in silence | same |
| Lead / tail silence | 0.2 s lead, 0.3 s tail (0.3 s tail is needed on `record` so the beep does not clip speech) | same |
| Downsampling | use a proper resampler with a low-pass filter; never record directly at 8 kHz | |

Process: record the master, edit breaths and clicks lightly (no pitch or speed effects), normalise gently, export the delivery file, then **listen to the delivery file over a real phone call on a basic feature phone** on a 2G/3G-quality line. If a word is unclear on the phone, re-record, not re-process.

## Room and microphone
- A quiet, soft-furnished room (a recording booth, or a wardrobe-lined room). No fans, no traffic, no phones nearby, no echo (clap test: no ring).
- Cardioid condenser or good dynamic microphone on a stand, with a pop filter, 15 to 20 cm from the mouth, slightly off-axis. USB microphones are acceptable if the noise floor above is met. No laptop microphones, no phone-in-the-hand recording.
- Headphones for the engineer, not the speaker's speakers. Record in 3 takes per prompt; keep the best, keep all raw takes until sign-off.

## Speaker selection
- One speaker per dialect area (coastal, Rayalaseema, Telangana) at minimum; all three must be natural speakers of that area, not imitating it. Dialect recordings are not interchangeable.
- Gender balance: use at least one female and one male voice across the set; ideally record each dialect with both and let a small listener test (below) choose, because women callers, many of whom are phone-less or first-time users, may trust a female voice more. This is an **assumption to test**, not a verified finding.
- Voice quality: clear, mid-paced, neutral warmth. Not a film, TV or political personality; not a voice identifiable with a party or leader. No celebrity endorsement. No children.
- Pay speakers fairly; the amount is for the operator to set (see cost model, audio line; unit price unknown).
- Test with 5 to 8 listeners per dialect area, including elders and people with low literacy, on a real phone: they repeat back what each prompt asked them to do. Note failures.

## Reading style
Follow the `tone` and `pronunciation` fields per prompt. Read the `formal` text unless the linguist chooses the `plain` variant (both are machine drafts). Say numbers as Telugu words, leave 0.4 s between menu options, read the anti-scam line in `welcome` calmly. Never read an example PIN or OTP.

## File naming and layout
- Existing convention in the manifest: `audio/te/<id>.wav` (served from `public/`). For dialect recordings use `audio/te/<dialect>/<id>.wav`, dialect one of `coastal`, `rayalaseema`, `telangana`. Lower-case ASCII, no spaces. Example: `public/audio/te/coastal/welcome.wav`.
- Master files are **not committed** (large); keep them in the operator's storage with the sign-off form.
- Dialect routing is built (`server/civic/channels/dialect.ts`): the telephony aggregator sends `dialect` (`standard|coastal|rayalaseema|telangana`) on `/missed-call` or any `/ivr` turn, else `CIVIC_IVR_DEFAULT_DIALECT` applies. The IVR plays a dialect file ONLY when the manifest lists that prompt+dialect as `reviewed`; otherwise it plays the standard key, and with `CIVIC_IVR_TTS_FALLBACK=1` a prompt with no reviewed recording at all is rendered as text-to-speech. There is no spoken in-call dialect menu (that needs its own recorded prompt). List what is still missing with `npx tsx scripts/audio-missing.ts` (`--strict` exits 1 while anything is missing). Recording and linguist review are still human steps.

## Linguist review checklist (tick per prompt, per dialect)
- [ ] The recorded words equal the approved script text exactly.
- [ ] Pronunciation is natural for the dialect area; no mispronounced place names or loan words (OTP, SMS, PIN, hash).
- [ ] Register is polite and warm; no officialese; no party, leader or slogan flavour.
- [ ] Numbers and option order are correct and equal the key mapping in the code.
- [ ] Pace and pauses are right; no clipping; no clicks; no breath noise.
- [ ] The anti-scam statement in `welcome` is clearly audible.
- [ ] `survey` is neutral and non-leading; no election words.
- [ ] Heard on a real phone, intelligible.
- [ ] Duration is within `maxDurationSec`.

## Sign-off form (one per speaker per dialect; keep the signed copy, record its id in the manifest)
Fields: form id; dialect; prompt ids covered; speaker name and contact; speaker consent reference; recording date; recording location; microphone and software; master file location; delivery file names; sha256 of each delivery file; linguist name, qualification and dialect expertise; checklist result per prompt (pass/fail/notes); phone test result; reviewer signature and date; operator approver signature and date; decision (approved / re-record list).

## How to add recordings and update the manifest (human steps)
1. Copy the delivery files into `public/audio/te/...` using the names above.
2. Compute each hash: `npx tsx scripts/audio-manifest-check.ts --hash audio/te/coastal/welcome.wav` (prints sha256; changes nothing).
3. After the linguist has signed the form, a human edits `data/civic/audio-manifest.json`. For a dialect recording add under the prompt:
   `"recordings": { "coastal": { "file": "audio/te/coastal/welcome.wav", "status": "recorded", "sha256": "<hash>" } }`
   Use `"status": "reviewed"` plus `"signoff": { "reviewer": "<name>", "date": "<YYYY-MM-DD>", "formRef": "<form id>" }` only after the signed form exists.
4. Set the top-level `"status"` to `"reviewed"` only when every prompt (every dialect) is reviewed.
5. Run `npx tsx scripts/audio-manifest-check.ts` and `npx vitest run tests/compliance`. The check fails if a non-placeholder status has no file, no hash, a wrong hash, or if a reviewed one lacks sign-off. **The script and the tests never change a status; they only report.** Changing a hash after sign-off (re-export) invalidates the sign-off: re-review.
6. Commit the audio files and the manifest edit in one change; the release gate row for audio references the form ids.

Size of the job, people needed and a ready-to-send brief: [docs/decisions/S-151-audio-brief.md](decisions/S-151-audio-brief.md).
