# S-233: where media is hosted, and the cost cap

Status: **open, needs the owner.** Nothing here is decided by the build.

## What exists today
Videos are not uploaded. An admin links a direct media file on a host listed in `MEDIA_VIDEO_HOSTS`; the app stores only the link, credit and text. So the app serves no video bytes and pays no video bandwidth.

## Options
| Option | Good | Cost / risk |
|---|---|---|
| A. Keep link-only, files on a cheap object store or the owner's own host | no storage or transcoding in the app, no extra moving parts | the owner hosts and keeps links alive; no 360p/720p variants unless the owner makes them |
| B. Paid video host (adaptive streaming, captions) | small files for phones | monthly fee; a third party sees viewers' IP addresses, so the privacy notice and the host list must name it |
| C. Own upload and transcoding in the app | one place, full control | big build (scan path S-147, transcoding, storage), server bandwidth and disk cost, abuse risk; not recommended for a first release |

## Recommendation
Stay on A for the first release. Cap the library at a number the owner can host (suggest 30 items), give a size guide in the admin form (under 20 MB, 360p, under 3 minutes), and revisit B if usage needs adaptive streaming.

## Needed from the owner
1. Pick A, B or C.
2. A monthly cost ceiling and who watches it.
3. The host names to add to `MEDIA_VIDEO_HOSTS`.
