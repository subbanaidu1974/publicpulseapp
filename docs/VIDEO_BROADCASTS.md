# Video broadcasts (S-230, S-237)

An admin proposes a video or audio item. A **different** admin approves it. Every signed-in member then sees it as a card in the Media tab, under "From us". It never blocks the app (unlike a broadcast poll, S-185).

## What a member sees
* A badge on the Media tab in the top bar, such as "Media (1)", when something new has arrived (screen readers hear "Media, 1 new videos").
* The Media tab opens on "From us" when there is something new. Each card shows the title, a short note, the credit line, and the browser's own player. A "New" label marks cards not seen on this device before.
* The player never starts by itself. If the file cannot be played, a plain message says so.
* Which cards have been seen is remembered **only in this browser** (`pp-video-seen` in local storage). The server never records who opened or watched what.
* A signed-out visitor sees "Sign in to see the videos we send to members". English and Telugu (the Telugu is a machine draft, unreviewed).

## What an admin does
Civic page, admin landing page, "Send a video to all members" (also in Admin console), which opens `#/videos-admin`:
1. Title, optional Telugu title, optional short notes, the web address of a **direct media file** (https, ending in mp4, webm, m4v, ogv, mp3, m4a, ogg, oga, opus or wav), a credit line (who made it and the licence or permission), and an optional start time within 30 days.
2. Two ticks are required: the video does not promote or attack a party or candidate or ask how to vote, and we have the right to show it to the members.
3. "Send for approval". Nothing is visible to members yet, and the proposing admin cannot approve it (the button is off; they can withdraw it).
4. A different admin opens the same screen and chooses Approve (or Refuse). The item goes live at once, or at its start time.
5. Any admin can Recall a live or scheduled item. It disappears for members at their next check (page load, focus, or within a minute). A short recall note is kept for admins.

API (all under `/api/v1/civic/videocast`): `POST /admin`, `GET /admin`, `POST /admin/:id/approve`, `POST /admin/:id/reject`, `POST /admin/:id/recall` (admin role); `GET /` and `POST /:id/view` (any signed-in account).

## Rules the server enforces
* Title, notes and credit may not contain a link, ask for an OTP, PIN, password or ID number, or ask people to choose or vote for a party or candidate.
* The address must be https (http is accepted for localhost outside production only), carry no login, point straight at an audio or video file, and be on the approved host list `MEDIA_VIDEO_HOSTS` (see `.env.example`). The same list is added to the page's `media-src` security policy, so only those hosts can play. Unset means no outside host.
* The proposer cannot approve their own item. An item can be approved or refused once. At most 20 items can wait for approval.
* Every member sees every live item: there is no targeting by party, place, role or any trait.
* Plays are a single counter per item with no person attached, and the count is hidden to admins until it reaches 10. The table has no column that could say who watched (a test checks this).
* Opening, approving, refusing and recalling are in the audit log.

## What is not built (see the tracker)
* **Silence-period and Model Code hold** and a counsel-reviewed checklist (S-231, needs counsel and election dates). Today the safeguards are the two ticks, the wording checks and a second admin.
* **Email link for members with no phone** and push notices (S-230 follow-up). Members see it when they open the app.
* **Hosting or uploading videos ourselves** (S-233): an item is a link to a file on an approved host.
* **Streams (HLS), YouTube or other page links**: only direct files play.
* Captions on broadcast items, mute and unsubscribe (S-232), a report button (S-234).
* Telugu not reviewed by a native speaker. The admin screen is English only.

## Recorded test videos
`npm run e2e:video-videos` runs E2E-222 and saves two 1280x720 videos to `test-results/videos/video-broadcast/`: `admin-sends-video.webm` (admin proposes, cannot approve their own, a second admin approves, later recalls) and `members-see-video.webm` (the Resident, Volunteer, Government officer and Journalist demo users: nothing before approval, then a badge, a New card, a play, never blocked, and nothing after the recall). The test serves a tone from `https://media.example.org`, set up through `MEDIA_VIDEO_HOSTS` in `playwright.config.ts`.
