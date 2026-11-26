# Media hub: news, live channels, library, reports and counts

What was built for stories S-225, S-226, S-228, S-229, S-231, S-232, S-234, S-235 and S-236. Nothing here shows a member any outside content until an admin has recorded our permission and a *different* admin has switched the source on.

## Sources (S-225)
One record per outlet or channel: name (English, Telugu), its own website, feed or official stream address, what we may show (headline only, or headline plus a short snippet), state (AP, TG or both), the permission note (where the written permission is kept), the date it was given, and a contact for takedowns. Addresses must be https. A new source is **off**. Switching on needs the permission note, a date that is not in the future, a contact, and a different admin than the one who added it. Every step is audited. Admin screen: `#/media-admin`.

## News (S-226)
Reads the outlet's official RSS or Atom feed only (no page scraping, no article bodies). Shows headline, outlet name, time and a link to the publisher in a new tab. Items older than 7 days are not shown. A feed is re-read lazily at most every 15 minutes while members open the tab; a source not read successfully for 6 hours is flagged "may be out of date". A short "top stories" digest is the newest few items. Every item is labelled as the publisher's, not ours.
**No source is switched on in this build.** The News section stays empty until the owner obtains permissions and an admin records them.

## Live channels (S-228)
A channel always shows a link to its own site. If it gave an official stream address on an approved host (`MEDIA_VIDEO_HOSTS`), a Play button appears (never starts by itself) and the stream is health-checked; if it is down, members see "stream unavailable" and the link. We never record or re-stream. **No channel is switched on in this build.** HLS (.m3u8) needs a player library; it is not added until the owner approves that download.

## Library and transcripts (S-229)
A broadcast video can be flagged "also keep in the Watch library" and carry a transcript (20 to 4000 characters, no links). Only our own or licensed items; same approval rule as any broadcast.

## Silence windows and corrections (S-231)
An admin enters a window (label, start, end, at most 14 days). While it runs, nothing new goes live: approving a video inside a window sets its start to the window's end, and videos already waiting are held. Ending a running window early needs a different admin, and releases what it was holding. A video withdrawn in the last 7 days appears as a correction with its note. **Not done:** the real election dates and counsel's reading of the Model Code; the neutrality checklist is still counsel's to approve. The system knows no dates by itself; an admin must enter them.

## Member mute (S-232)
A "mute new-video alerts on this device" tick on the Media tab hides the Media badge and the automatic jump to From us. It is stored only in the browser. Not done: email choices or unsubscribe (no video email is sent).

## Reports and takedown (S-234)
Every news item, live channel and video has a Report button (reason plus an optional note, no links). One report per person per item, stored with a keyed hash and **no person id**. An admin dismisses or takes down: news is hidden, a video is recalled (a correction shows), a channel is switched off.

## Counts without tracking (S-236)
A click on a news or channel link and a play are counted per item per day as plain numbers. No cookie, no person, no watch list. The admin Numbers list shows nothing under 10.

## Not done / needs the owner
- Which outlets and channels, and their written permissions (S-226, S-228).
- Hosting and cost (S-233): see `docs/decisions/S-233-media-hosting.md`.
- District filter for news; HLS player; Telugu review of all Media text; counsel on silence-period dates and the Model Code.

Tests: E2E-223, E2E-224 (unit), E2E-225, E2E-226 (e2e, recorded with `npm run e2e:media-videos`).
