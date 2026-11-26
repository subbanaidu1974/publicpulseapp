# Media tab roadmap (written 2026-11-26)

Stories S-224 to S-236 in `docs/stories/tracker.json`. Nothing here is built yet. This page says what we will build, in what order, and what has to be decided or cleared first. Telugu text will be machine-drafted and must be reviewed.

## What the owner asked for

1. A Media tab with **daily media news**, in depth.
2. A **free media player**.
3. **Live channels**.
4. **Broadcast videos to all registered members**.

## Ground rules (they decide the design)

- **Link, do not copy.** News is shown as headline, outlet, time and a link to the publisher. No full articles, no scraped pages. Written permission or published terms are recorded per source before it is switched on (S-225). This follows S-125: no hard-coded news and no hotlinked media.
- **Official streams only.** Live channels are embedded or linked through the channel's own official stream. We never capture or re-stream a channel. Each channel needs written confirmation.
- **Free means open source.** The player uses the browser's own video and audio plus hls.js (Apache-2.0). No paid player, no vendor script, no tracking.
- **Neutral platform.** The app publishes no party result and does not promote parties or candidates. A broadcast is not allowed to either.
- **No watch history.** We count views per item, hidden under 10, and never keep who watched what.

## Order of work

| Step | Story | What | Needs from outside |
|---|---|---|---|
| 1 | S-224 | Media tab shell, four sections, honest empty states | nothing |
| 2 | S-227 | Free built-in player (video, audio, captions, keyboard, low data) | nothing |
| 3 | S-225 | News source register with terms and permission per source | owner lists outlets |
| 4 | S-233 | Storage, transcoding, cost cap for videos we host | owner decision: own server or paid host |
| 5 | S-230 | Broadcast a video to every registered member (card, badge, email link) | nothing for our own videos |
| 6 | S-231 | Safeguards: two-person approval, neutrality checklist, silence-period hold, recall | counsel |
| 7 | S-232 | Member mute, language, one-tap unsubscribe | counsel wording |
| 8 | S-229 | Watch library of our own explainers | people to make them |
| 9 | S-226 | Daily news feeds (blocked until step 3 has permitted sources) | outlet permissions |
| 10 | S-228 | Live channels (blocked until each channel confirms) | channel permissions |
| 11 | S-234, S-236 | Report button, labels, corrections; counts without tracking | none |
| 12 | S-235 | Recorded journeys in English and Telugu, five demo users | none |

Steps 1, 2, 4, 5, 8, 11 and 12 can be built without anyone's permission. Steps 9 and 10 cannot start until the owner gets written permission, the same way the panchayat data waits on S-204.

## Daily news, in depth (S-226)

- Sources: only official RSS or API feeds that an outlet has allowed. Telugu and English, AP and Telangana, plus national items that mention either state.
- Each item: headline, outlet, publish time, state or district tag, link out. Items older than 7 days drop off. A banner appears if a source has gone quiet.
- Sections: Top today, My district, Government notices, Elections (labelled as the publisher's reporting, never as a result).
- A daily digest card at the top. Written by a person or built only from the headlines themselves.
- A source can be removed the same day it objects. Every item has a Report button (S-234).

## Free player and Watch (S-227, S-229)

- One player for video and audio: play, pause, seek, captions, speed, audio-only, 360p first on slow links, keyboard and screen-reader operable, never autoplays.
- Our own explainers first (how to vote, how to read a result, how to report an issue), in English and Telugu, each with a transcript.

## Live channels (S-228)

- A directory of Telugu news channels that offer an official stream. Each shows the channel's name and a link to its own site, and a clear "stream unavailable" state when it is down.
- We do not host or record live video. This keeps cost and risk low.

## Broadcast video to all registered members (S-230, S-231, S-232)

- An admin picks an approved video, writes a title and a short note, and chooses a time. A second admin must approve before it goes out.
- Members see it as the top Media card with an unread badge. Email-only members get an email link. It does **not** block the app, unlike a poll (S-185). Members can mute broadcasts, except government safety notices.
- Held automatically during an election silence period or any Model Code restriction. An admin can recall it, and the correction is shown.
- Counts of "seen" only, hidden under 10.

## Decisions and clearances the owner or counsel must make

1. **Which outlets** to ask, and who sends the permission requests (we send nothing ourselves; drafts only, as with `PANCHAYAT_PERMISSION_REQUESTS.md`).
2. **Which channels** to list, and written confirmation from each that embedding or linking its official stream is allowed.
3. **Counsel**: wording of the notice for video broadcasts, the Model Code and silence-period rules for a platform that messages members, and who is liable for a broadcast an admin sends.
4. **Hosting**: our own server or a paid video host, and the monthly cap (S-233).
5. **Who makes the explainers**, and who reviews the Telugu.

## What is not planned

DRM and downloads; recording or re-streaming channels; advertising; recommendations based on behaviour; targeting a broadcast by party, caste or religion; paid placement; user-uploaded public video.
