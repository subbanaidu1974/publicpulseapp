# Media hub: news, live channels, library, reports and counts

What was built for stories S-225, S-226, S-228, S-229, S-231, S-232, S-234, S-235 and S-236. Nothing here shows a member any outside content until an admin has recorded our permission and a *different* admin has switched the source on.

## Sources (S-225)
One record per outlet or channel: name (English, Telugu), its own website, feed or official stream address, what we may show (headline only, or headline plus a short snippet), state (AP, TG or both), the permission note (where the written permission is kept), the date it was given, and a contact for takedowns. Addresses must be https. A new source is **off**. Switching on needs the permission note, a date that is not in the future, a contact, and a different admin than the one who added it. Every step is audited. Admin screen: `#/media-admin`.

## News (S-226)
Reads the outlet's official RSS or Atom feed only (no page scraping, no article bodies). Shows headline, outlet name, time and a link to the publisher in a new tab. Items older than 7 days are not shown. A feed is re-read lazily at most every 15 minutes while members open the tab; a source not read successfully for 6 hours is flagged "may be out of date". A short "top stories" digest is the newest few items. Every item is labelled as the publisher's, not ours.
**No source is switched on in this build.** The News section stays empty until the owner obtains permissions and an admin records them.

## Live channels (S-228)
A channel always shows a link to its own site. If it gave an official stream address on an approved host (`MEDIA_VIDEO_HOSTS`), a Play button appears (never starts by itself) and the stream is health-checked; if it is down, members see "stream unavailable" and the link. We never record or re-stream. **No channel is switched on in this build.** HLS (.m3u8) needs a player library; it is not added until the owner approves that download.

## Candidate AP and Telangana feeds (S-242)
Two sources are loaded **switched off, with no permission record**: The Hindu, Andhra Pradesh (`https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss`) and The Hindu, Telangana (`.../telangana/feeder/default.rss`). Both addresses answered with a valid RSS feed on 2026-11-26. Having a public feed is not permission to republish: the owner must obtain written permission (and check The Hindu's terms), then an admin records it on the source (admin screen, "Record permission") and a *different* admin switches it on. The admin who records the permission cannot also switch the source on. Telugu-language outlets and the two governments' own press feeds are not loaded; their feed addresses and permissions have not been checked.

## Candidate Telugu news channels on YouTube (S-279)
Ten channels' YouTube video feeds are loaded **switched off, with no permission record**: NTV Telugu, TV9 Telugu, 10TV News Telugu, Sakshi TV, ABN Telugu, TV5 News, V6 News Telugu, T News Telugu, Mahaa News and ETV Andhra Pradesh. Each channel id was read from the channel's own YouTube page and its video feed answered with 15 recent videos on 2026-11-27 (ids are in the `mhub_005` migration; recheck an id if a feed ever returns nothing, since channels can have several YouTube channels). Once an admin records the channel's written permission and a *different* admin switches it on, its latest videos appear in the Watch tab list and play in YouTube's no-cookie embed after a tap (nothing loads from YouTube before). We keep only title, link and time, never the video. Not loaded: live streams (need a live video link or the channel's own permission), Eenadu/ETV news channel variants and TV5's other channels, which are separate YouTube channels.

## Harvested candidates (S-280 to S-282)
2026-11-27: 21 more news feeds, 8 more YouTube video channels and 15 live news channels (by YouTube channel live address) are loaded switched off with no permission record. The research, what answered, what failed and the terms found (PIB's own copyright policy allows free reproduction) are in [MEDIA_SOURCES_RESEARCH.md](MEDIA_SOURCES_RESEARCH.md). A live channel may now be given as `https://www.youtube.com/channel/UC.../live`; it plays in YouTube's no-cookie live embed after a tap.

## Candidate Google News feeds (S-278)
Four Google News topic feeds are loaded **switched off, with no permission record**: Andhra Pradesh and Telangana, each in English and in Telugu (`https://news.google.com/rss/search?q=...&hl=en-IN|te&gl=IN&ceid=IN:en|te`). All four answered with a valid RSS feed on 2026-11-26 (about 110 headlines each). A Google News feed is an index of many publishers: each headline names its publisher and links to Google's redirect to the publisher's page, so the publishers' rights and Google's own terms for the feed are for the owner to read before an admin records permission and a different admin switches a feed on. Headlines only, no story text, like every other source.

## Candidate Telugu channel feeds (S-244)
Loaded switched off with no permission record, like the Hindu feeds: NTV Telugu (`https://ntvtelugu.com/feed`), TV9 Telugu (`https://tv9telugu.com/feed`), 10TV (`https://10tv.in/feed`) and Sakshi (`https://www.sakshi.com/rss.xml`). All four answered with a valid RSS feed on 2026-11-26. A public feed is not permission to republish: obtain written permission, record it on the source, and let a different admin switch it on. Not loaded: Eenadu and Andhra Jyothy (no working feed address found), and TV5, ABN and others (not checked). Also found working but not loaded, because they are not channels or not checked for terms: Visala Andhra, Mana Telangana, Oneindia Telugu, Prabha, Telangana Today.

## Demo news preview (S-245)
For looking at the News tab before any outlet is cleared: set `CIVIC_DEMO_NEWS=1` (development only, refused in production). One source labelled "DEMO outlet (sample headlines, not real news)" appears with five headlines we wrote, each marked as a sample, linking to example.com. With the same setting the Watch tab also lists three short sample clips (files in `public/demo`, made for the preview, titled as demos) so the player can be tried; our own first video is ready in the stage and never starts by itself. It is not a real outlet and is not in the real source list for production. The automated tests leave it off.

## Watch player with a video list (S-243)
The top of the Watch tab is a stage with a list beside it (below it on a phone). The list holds our own approved videos (signed-in members) and the YouTube videos from news sources an admin switched on, in a fixed order with each video listed once. Choosing a row shows it in the stage: our own video plays from its file with the browser's controls and never starts by itself; a YouTube video loads only YouTube's no-cookie embed. Next and Previous step through the list. There are no recommendations, no autoplay of the next video and no watch history. The file and link players below stay as they were.

## YouTube channels (S-238)
A news source can be a YouTube channel: the admin enters the channel id (About tab, Share channel, Copy channel ID; it starts with UC). We build YouTube's official public feed address ourselves and read only title, link and date. Each video appears as a news item with a link to YouTube and a "Play here" button. Nothing from YouTube is requested until a member taps Play; then only YouTube's no-cookie embed player loads (the CSP allows only `www.youtube-nocookie.com` for frames). YouTube can see the member's address at that point, and the note says so. We never download, copy or re-host a video. The source needs the same permission record and a different admin to switch on. **No channel is switched on in this build**, and channel ids must come from the owner. Counsel should confirm that embedding a channel's videos is covered by its permission and by YouTube's terms.

### Paste a single YouTube video (S-239)
In the media admin screen, "Add one YouTube video by link" takes the link, a headline typed by the admin (nothing is copied from YouTube), the channel name, and the permission record. It becomes its own switched-off source with no feed; a different admin switches it on; it shows for 7 days and plays only after a member taps Play, in the same no-cookie player. Reports and takedown work as for any source.

## Play a YouTube link (S-240)
In the Watch section a member can paste any YouTube video link and play it in YouTube's own no-cookie player. It is the member's own choice, so it needs no admin approval and shows nothing to anyone else. The link is read in the browser only: it is not sent to our server, not stored (no cookie, no local storage) and not counted. Only `www.youtube-nocookie.com` may be framed (CSP). YouTube sees the member's address once the player loads; the page says so. Links that are not YouTube video links are refused.

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
