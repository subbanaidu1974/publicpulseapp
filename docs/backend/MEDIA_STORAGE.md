# Media storage: images, audio and videos

Design only. Table definitions are in [DATA_MODEL_MYSQL.md](DATA_MODEL_MYSQL.md) section 5.

## 1. What has to be stored
| Kind | Today | Sensitivity | Size (typical) | Read by |
|---|---|---|---|---|
| Citizen issue photos | AES-GCM encrypted file on local disk (`data/civic-media`) | **High**: can show faces, homes, plates, location | 0.3 to 3 MB after resize | the reporter, the moderator, the assigned officer; public only after moderation and only if the reporter allowed it |
| Photo submissions (people and candidate photos) | encrypted file (`data/photo-submissions`) | Medium: pending review | 0.3 to 3 MB | reviewers; public after approval |
| Consultation audio | local file | High: a voice identifies a person | 0.2 to 5 MB | staff who process it |
| Library and broadcast videos | link to a file on an approved host (no upload) | Public once approved | 5 to 500 MB originals | everyone, many times |
| Posters, source logos, public photos | `public/` in the repository | Public | under 1 MB | everyone |
| Election data (JSON, GeoJSON, tiles) | `data/generated`, 48 MB | Public | 0.1 to 10 MB per file | everyone, cached |
| Raw source data | `data/raw`, 1.4 GB | Not served | | an archive |

## 2. Recommendation
1. **Do not store files in MySQL.** Blobs bloat the buffer pool, slow backups and restores, replicate poorly, cannot be served from a CDN, and make point-in-time recovery of the database enormous. MySQL keeps one row per object.
2. **Use S3-compatible object storage** with two buckets: **private** (citizen photos, audio, originals before approval) and **public** (approved videos, posters, public photos, published datasets).
3. **Private bucket:** no public access, server-side encryption, **plus the existing application-level AES-GCM** for citizen photos and audio, so the cloud account alone cannot read them. Served only through the authorised API (`GET /civic/media/:id/content`), which checks who is asking.
4. **Public bucket behind a CDN** with long-lived immutable URLs (content hash in the key). Videos are delivered as **HLS** (360p and 720p) so a phone on a poor network can play them; the original is kept in the private bucket.
5. **Videos: stay link-only until the owner wants upload.** The first release keeps today's links to approved hosts and YouTube. Upload and transcoding (S-260) are an optional later step, because video egress is the cost that can surprise.
6. **Region:** an Indian region for everything personal (citizen photos and audio). Public content may be served from the CDN's edge network.
7. **Never provider-specific:** use only the S3 API (put, get, multipart, presign, lifecycle, versioning, delete). Then moving provider means copying buckets.

## 3. Options compared
Prices change; **verify current figures with each provider before deciding** (they are deliberately not quoted here).
| Option | Good | Watch for |
|---|---|---|
| **AWS S3** (Mumbai or Hyderabad region) | the standard S3 API; mature lifecycle, versioning, object lock, presigned URLs; MediaConvert for video; CloudFront CDN | egress charges; many billing dimensions |
| **Azure Blob** (Central India) | strong if the rest of the stack is Azure; lifecycle tiers | not S3 API natively; an adapter is needed |
| **Google Cloud Storage** (Mumbai, Delhi) | simple, S3-interoperable mode | interoperability mode has some gaps; CDN setup differs |
| **Cloudflare R2** | S3 API; **no egress fee** (check current terms); CDN and Stream integrated | Indian data location options limited (verify); fewer lifecycle and lock features |
| **MinIO (self-run)** | full control, fixed hardware cost, S3 API | you own durability, scaling, upgrades and backups; not advised before a team exists to run it |
| **Backblaze B2** | cheap storage, S3 API, free egress to partner CDNs (verify) | no Indian region (verify) |

**Proposed default:** S3-compatible storage in an Indian region (AWS S3 Mumbai if the owner has no existing provider), CDN in front of the public bucket. If the owner prefers a different provider the design holds, since only the S3 API is used. The decision is S-257.

## 4. Video options (only if upload is wanted)
| Approach | Notes |
|---|---|
| Keep links only | no storage, no transcode, no egress cost; depends on the host's availability and rules (current behaviour) |
| Managed transcode (MediaConvert, Cloudflare Stream, Mux or equivalent) | no servers to run; cost per minute of video plus delivery; quickest to a good result |
| Own ffmpeg worker on a small queue | cheapest at low volume; we own failures and scaling; uses the jobs and outbox of S-266 |

Recommendation: managed transcode first, since volume is low and staff time is dear; reconsider on measured cost. Output: HLS with 360p and 720p renditions, a poster frame, optional WebVTT captions. Cap on upload size and duration set by the owner; **every upload goes through the existing approval rule** (two-person approval before it is shown to members).

## 5. Rules by purpose
| purpose | who may upload | max size | types | scan | encryption | retention |
|---|---|---|---|---|---|---|
| `issue_photo` | signed-in member, own report | 8 MB in, re-encoded smaller | JPEG, PNG, WebP, HEIC (converted) | virus scan, image decode check, EXIF and GPS removed | app AES-GCM | follows the issue's retention; purged with the issue or on erasure |
| `consultation_audio` | member | 10 MB, 120 s | WebM, MP3, M4A | scan, duration check | app AES-GCM | existing consultation rule |
| `video` | admin, two-person approval to show | owner sets (proposal 500 MB) | MP4, WebM, MOV | scan, probe | SSE in private bucket; public HLS after approval | until taken down |
| `video_poster` | admin | 2 MB | JPEG, PNG, WebP | scan | none (public) | with the video |
| `source_logo` | admin | 500 KB | PNG, SVG sanitised, WebP | scan, SVG scripts stripped | none | with the source |
| `public_photo` | reviewer after approval | 3 MB | JPEG, WebP | scan, EXIF removed | none | until takedown |
Numbers marked proposal are for the owner (S-246, S-257).

## 6. Upload flow
```
client            API                      object storage        worker
  | POST /media/uploads  |                        |                 |
  |--------------------->| check role, caps,      |                 |
  |                      | create media_object    |                 |
  |<---------------------| (pending) + presigned URL                |
  | PUT file ----------------------------------->|                 |
  | POST /media/uploads/:id/complete              |                 |
  |--------------------->| verify size, sha256    |                 |
  |                      | state=uploaded, queue ------------------>| scan, strip EXIF,
  |<---------------------| {media_id, processing} |                 | make variants, encrypt
  | GET /media/:id (poll)|                        |<----------------| state=ready
```
- The presigned URL is single-use, short (10 minutes), bound to size and content type; large files use multipart.
- A file is **not readable** (not even by the uploader) until the state is `ready`.
- A sweeper deletes `pending` rows and their objects after 24 hours and any object without a row.

## 7. Lifecycle
- **Retention:** `retention_until` set from the owning record; a job purges the object, its variants and the row (soft delete first, hard delete after the recovery window).
- **Takedown and erasure:** deleting a report, an account (via the existing erasure outbox) or a moderated item purges its media in the same workflow; the audit log records the purge, not the content.
- **Versioning and backup:** bucket versioning on the private bucket with a short non-current expiry (for example 7 days) so an accidental delete can be undone; cross-region replication of the private bucket only if the owner requires it and residency allows.
- **Cost controls:** per-purpose caps, budget alerts, lifecycle rules moving old originals to a cheaper tier, CDN cache rules, and a monthly cost report (S-261).

## 8. Cost estimate method
Monthly cost is roughly `stored GB x storage price + requests x request price + egress GB x egress price (or CDN price) + transcode minutes x transcode price`. Inputs the owner can estimate: reports per day, share with photos, average photo size after resize, new videos per week, average video length, expected video views, and average bytes served per view (a 720p HLS stream is on the order of a few MB per minute). Prices come from the chosen provider's current list at decision time (S-257); this document does not quote them.

## 9. Migrating what exists (S-259)
Read each encrypted local file, verify it decrypts, write it to the private bucket with a `media_object` row (copying its hash and retention), point the owning row at `media_id`, then verify counts and checksums before removing the local copy. Run twice (a dry run first); keep the local copy for a rollback window.

## 10. Not decided here
Provider and region, whether video upload is in the first release, size caps, CDN vendor, the scanner (a managed scanning service or a self-run ClamAV worker), and cross-region replication. These are S-246, S-257, S-260 and S-261.
