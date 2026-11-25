# S-151 decision note: recorded Telugu audio, size of the job and a brief to send

Status: DRAFT for the owner. No linguist, speaker or studio has been contacted and nothing has been recorded. Not legal advice. The technical recording rules are in `docs/AUDIO_RECORDING_GUIDE.md`; this note adds the size of the job, who is needed, a ready-to-send brief, and when it is needed.

## 1. When it is needed

Phone-menu (IVR) audio is only used by the IVR and missed-call channels. In the draft pilot-only gate (`docs/gate/pilot-profile.json`, not yet approved) IVR is off, so release-gate row 10 would be deferred and this work is not on the pilot's critical path. It becomes a launch prerequisite when IVR is switched on, because the full gate requires human-recorded Telugu audio for every prompt in three dialects. Until then the IVR must stay off: the manifest still marks every file as a placeholder.

## 2. Size of the job (from `data/civic/audio-manifest.json`)

* 17 prompts per dialect: welcome, category, record, who, pin, pinWrong, locked, confirm, status, survey, thanks, invalid, goodbye, survey_notice, survey_q, survey_none, survey_already.
* 3 dialects (coastal, Rayalaseema, Telangana) plus the standard fallback, so at least 51 files to record, review and place.
* About 1,190 Telugu characters of script per dialect. As a rough guess this is a few minutes of finished speech per dialect, but the studio should measure it.
* Every script is a machine draft. A linguist must approve or edit the text first, and the stored text must equal what is spoken (edit `data/civic/audio-scripts/prompts.json` and the manifest `textTe` together).

## 3. People needed

| Role | What they do | Independence |
|---|---|---|
| Telugu linguist, one per dialect area or one covering all three | Approves script text and wording, checks pronunciation of terms like OTP, SMS and PIN, signs the checklist per prompt and dialect | Not a party, leader or government-linked voice |
| Speakers, at least one natural speaker per dialect, ideally one female and one male | Record the prompts | Not a film, TV or political personality; written consent for use of their voice |
| Studio or engineer | Records to the spec, produces master and delivery files, checksums | |
| Listener panel, 5 to 8 per dialect area | Hear the files on a basic phone and repeat back what each prompt asked | Include elders and low-literacy users |
| Counsel | Reviews the speaker consent text | |

## 4. Brief to send (to a linguist or a studio)

Subject: Telugu voice prompts for a civic phone menu, three dialects

> We are building a non-partisan civic information service for Andhra Pradesh and Telangana. Callers use a phone menu in Telugu. We need human-recorded prompts, not synthetic speech, in coastal, Rayalaseema and Telangana Telugu: 17 short prompts per dialect, about 1,200 characters of script each. Please quote for: linguist review of the scripts and wording, speaker casting (one natural speaker per dialect, preferably one female and one male), recording and editing to the specification in the attached guide, a listener test on basic phones, and delivery of master and phone-quality files with checksums. We need written speaker consent for use of the voice in the service and a statement of how long and where it may be used. The voices must not be recognisable as a politician, party figure or celebrity. Please tell us your price, timeline and the dialect expertise of your team.

Attach: `docs/AUDIO_RECORDING_GUIDE.md`, `data/civic/audio-scripts/prompts.json`, `data/civic/audio-manifest.json`.

## 5. After delivery (human steps, then the checker)

1. Linguist signs the per-prompt checklist for each dialect; speaker consent forms are filed.
2. Delivery files go to `public/audio/te/<dialect>/<id>.wav`; the manifest gets real file paths, checksums and the sign-off form id, and its `status` changes from `placeholder` only once every prompt of every dialect is signed.
3. Run the missing-recordings report (`scripts/audio-missing.ts`) and the IVR tests; then a real-phone call test on a basic phone.
4. Attach the signed manifest and forms under `docs/gate/10/evidence/`.

## 6. Decisions for the owner

* Whether to record before the pilot or only when IVR is switched on (recommended: only then).
* One linguist for all three dialects or one per area (one per area is safer for dialect fidelity).
* Budget; every audio price in the cost model is unknown.
* Who signs the speaker consent for the entity (after S-152 forms it).

S-151 stays blocked until a linguist has approved the scripts and recordings exist for every prompt in every dialect.
