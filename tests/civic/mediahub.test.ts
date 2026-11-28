import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { mediaRouter, parseFeed, addSource, enableSource, disableSource, refreshSource, refreshDue, newsFor, checkStream, liveChannels, countClick, numbers, reportItem, resolveReport, checkUrl, recordPermission, ensureDemoNews, demoVideos, applyPreviewSources, previewSourcesEnabled, PREVIEW_NOTE, MIN_COUNT_SHOWN, type Fetcher } from "../../server/civic/mediahub";
import { createVideo, approveVideo, addWindow, endWindow, liveFor, correctionsFor, recallVideo, afterSilence } from "../../server/civic/videocast";
import { videocastRouter } from "../../server/civic/videocast";
import { mkPerson } from "./notify/helpers";

process.env.MEDIA_VIDEO_HOSTS = "media.example.org,streams.example.org";
let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/m", mediaRouter);
  app.use("/v", videocastRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { resetDbForTests(); migrate(); });

async function call(method: string, p: string, token?: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : {} };
}
const admin = () => { const p = mkPerson(); grantRole("system", p.id, "admin"); return p; };
const NOW = new Date("2026-11-26T10:00:00Z");
const RSS = (items: { t: string; l: string; d: string; desc?: string }[]) => `<?xml version="1.0"?><rss><channel><title>Daily</title>${items.map((i) => `<item><title><![CDATA[${i.t}]]></title><link>${i.l}</link><pubDate>${i.d}</pubDate><description>${i.desc ?? ""}</description></item>`).join("")}</channel></rss>`;
const feedOf = (xml: string, ok = true, status = 200): Fetcher => async () => ({ ok, status, text: async () => xml });
const NEWS = { kind: "news", name_en: "Daily Telugu", site_url: "https://daily.example.net/", feed_url: "https://daily.example.net/feed.xml", allow: "headline", state: "AP", permission_note: "Written reuse permission from the editor, mail of 20 Nov 2026", permission_date: "2026-11-20", contact: "desk@daily.example.net" };

describe("media hub: sources, news, live, reports, counts (S-225, S-226, S-228, S-234, S-236) @E2E-223", () => {
  it("a source starts switched off, needs the permission record, and a DIFFERENT admin must switch it on; any admin can switch it off", async () => {
    const a = admin(), b = admin();
    const noPerm = addSource(a.id, { ...NEWS, permission_note: undefined, permission_date: undefined, contact: undefined }, NOW);
    expect(noPerm.enabled).toBe(0);
    await expect((async () => enableSource(b.id, noPerm.id, NOW))()).rejects.toThrow(/record the permission/);
    const s = addSource(a.id, NEWS, NOW);
    await expect((async () => enableSource(a.id, s.id, NOW))()).rejects.toThrow(/different admin/);
    expect(enableSource(b.id, s.id, NOW).enabled).toBe(1);
    expect(disableSource(a.id, s.id).enabled).toBe(0);
  });

  it("only an admin can use the admin routes; the public routes need no sign-in; report needs sign-in", async () => {
    const a = admin(), u = mkPerson();
    expect((await call("GET", "/m/admin/sources", u.token)).status).toBe(403);
    expect((await call("POST", "/m/admin/sources", undefined, NEWS)).status).toBe(401);
    expect((await call("POST", "/m/admin/sources", a.token, NEWS)).status).toBe(201);
    expect((await call("GET", "/m/news")).status).toBe(200);
    expect((await call("GET", "/m/live")).status).toBe(200);
    expect((await call("POST", "/m/report", undefined, { kind: "news", id: "x", reason: "wrong" })).status).toBe(401);
    expect((await call("GET", "/m/admin/numbers", u.token)).status).toBe(403);
  });

  it("addresses must be https with no login and a stream must be on the approved host list", async () => {
    await expect((async () => checkUrl("x", "http://daily.example.net/feed"))()).rejects.toThrow(/https/);
    await expect((async () => checkUrl("x", "https://u:p@daily.example.net/feed"))()).rejects.toThrow(/login/);
    await expect((async () => checkUrl("x", "javascript:alert(1)"))()).rejects.toThrow();
    expect(checkUrl("x", "https://daily.example.net/feed")).toContain("https://");
    await expect((async () => checkUrl("stream", "https://elsewhere.example.net/live.m3u8", { allowedHostsOnly: true }))()).rejects.toThrow(/approved list/);
    expect(checkUrl("stream", "https://streams.example.org/live.m3u8", { allowedHostsOnly: true })).toContain("streams.example.org");
  });

  it("the feed reader takes RSS and Atom, keeps headline, link and time, skips broken items and never keeps the article", async () => {
    const rss = RSS([
      { t: "Water scheme opens in <b>Guntur</b>", l: "https://daily.example.net/a", d: "Wed, 25 Nov 2026 08:00:00 GMT", desc: "<p>Long body &amp; more</p>" },
      { t: "x", l: "https://daily.example.net/short", d: "Wed, 25 Nov 2026 08:00:00 GMT" },
      { t: "Plain http link", l: "http://daily.example.net/insecure", d: "Wed, 25 Nov 2026 08:00:00 GMT" },
      { t: "From the far future", l: "https://daily.example.net/f", d: "Mon, 01 Jan 2040 08:00:00 GMT" },
    ]);
    const items = parseFeed(rss, NOW);
    expect(items.map((i) => i.title)).toEqual(["Water scheme opens in Guntur"]);
    expect(items[0].snippet).toBe("Long body & more");
    const atom = `<feed><entry><title>Atom story one</title><link href="https://daily.example.net/atom1"/><updated>2026-11-25T09:00:00Z</updated><summary>Short</summary></entry></feed>`;
    expect(parseFeed(atom, NOW)[0]).toMatchObject({ title: "Atom story one", link: "https://daily.example.net/atom1" });
  });

  it("a switched-off source is never fetched; an enabled one is read, de-duplicated, labelled, and the snippet is kept only where allowed", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, NEWS, NOW);
    let calls = 0;
    const xml = RSS([{ t: "Road repair begins", l: "https://daily.example.net/r1", d: "Thu, 26 Nov 2026 07:00:00 GMT", desc: "Short body" }]);
    const f: Fetcher = async () => { calls++; return { ok: true, status: 200, text: async () => xml }; };
    await expect(refreshSource(s.id, f, NOW)).rejects.toThrow(/switched off/);
    expect(calls).toBe(0);
    enableSource(b.id, s.id, NOW);
    expect((await refreshSource(s.id, f, NOW)).added).toBe(1);
    expect((await refreshSource(s.id, f, NOW)).added).toBe(0); // the same link is not added twice
    const n = newsFor("AP", NOW);
    expect(n.items).toHaveLength(1);
    expect(n.items[0]).toMatchObject({ title: "Road repair begins", outlet_en: "Daily Telugu", snippet: null }); // headline-only source: no snippet
    expect(n.label).toBe("publisher");
    expect(newsFor("TG", NOW).items).toHaveLength(0); // an AP source is not shown for TG
    const s2 = addSource(a.id, { ...NEWS, name_en: "Snippet Daily", feed_url: "https://snip.example.net/f.xml", allow: "snippet", state: "BOTH" }, NOW);
    enableSource(b.id, s2.id, NOW);
    await refreshSource(s2.id, f, NOW);
    expect(newsFor("TG", NOW).items.find((i) => i.outlet_en === "Snippet Daily")?.snippet).toBe("Short body");
  });

  it("switching a source off hides its news at once; old items drop off after 7 days; the digest is the last day only", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW);
    const xml = RSS([{ t: "Fresh story today", l: "https://daily.example.net/n1", d: "Thu, 26 Nov 2026 08:00:00 GMT" }, { t: "Four days old story", l: "https://daily.example.net/n2", d: "Sun, 22 Nov 2026 08:00:00 GMT" }, { t: "Ten days old story", l: "https://daily.example.net/n3", d: "Mon, 16 Nov 2026 08:00:00 GMT" }]);
    await refreshSource(s.id, feedOf(xml), NOW);
    const n = newsFor(undefined, NOW);
    expect(n.items.map((i) => i.title)).toEqual(["Fresh story today", "Four days old story"]); // the ten-day-old item is gone
    expect(n.digest.map((i) => i.title)).toEqual(["Fresh story today"]);
    disableSource(a.id, s.id);
    expect(newsFor(undefined, NOW).items).toEqual([]);
  });

  it("a failing feed is recorded and the source shows as stale; refreshDue honours the 15 minute rule", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW);
    await expect(refreshSource(s.id, feedOf("", false, 503), NOW)).rejects.toThrow(/503/);
    expect(newsFor(undefined, NOW).sources[0].stale).toBe(true);
    expect((getDb().prepare("SELECT last_error FROM mhub_sources WHERE id = ?").get(s.id) as { last_error: string }).last_error).toMatch(/503/);
    let calls = 0;
    const f: Fetcher = async () => { calls++; return { ok: true, status: 200, text: async () => RSS([{ t: "Back again story", l: "https://daily.example.net/b", d: "Thu, 26 Nov 2026 09:00:00 GMT" }]) }; };
    await refreshDue(f, new Date(NOW.getTime() + 5 * 60_000)); expect(calls).toBe(0); // fetched 5 minutes ago
    await refreshDue(f, new Date(NOW.getTime() + 20 * 60_000)); expect(calls).toBe(1);
    expect(newsFor(undefined, new Date(NOW.getTime() + 20 * 60_000)).sources[0].stale).toBe(false);
  });

  it("live channels: listed only when enabled, with the stream health check recorded", async () => {
    const a = admin(), b = admin();
    const ch = addSource(a.id, { kind: "live", name_en: "Channel One", site_url: "https://one.example.net/", stream_url: "https://streams.example.org/one.m3u8", permission_note: "Confirmed in writing by the channel, 21 Nov 2026", permission_date: "2026-11-21", contact: "tech@one.example.net" }, NOW);
    expect(liveChannels()).toEqual([]);
    enableSource(b.id, ch.id, NOW);
    expect(liveChannels()[0]).toMatchObject({ name_en: "Channel One", health_ok: null });
    expect(await checkStream(ch.id, feedOf("", true), NOW)).toBe(true);
    expect(liveChannels()[0].health_ok).toBe(true);
    expect(await checkStream(ch.id, async () => { throw new Error("down"); }, NOW)).toBe(false);
    expect(liveChannels()[0].health_ok).toBe(false);
    await expect((async () => addSource(a.id, { kind: "live", name_en: "Other", site_url: "https://o.example.net/", stream_url: "https://not-listed.example.net/x.m3u8" }, NOW))()).rejects.toThrow(/approved list/);
  });

  it("clicks are one counter per item per day with no person, hidden under the minimum, and only for items that are shown", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW);
    await refreshSource(s.id, feedOf(RSS([{ t: "Counted story here", l: "https://daily.example.net/c", d: "Thu, 26 Nov 2026 08:00:00 GMT" }])), NOW);
    const id = newsFor(undefined, NOW).items[0].id;
    for (let i = 0; i < MIN_COUNT_SHOWN - 1; i++) countClick("news", id, NOW);
    expect(numbers().items.find((x) => x.item_id === id)?.total).toBeNull();
    countClick("news", id, NOW);
    expect(numbers().items.find((x) => x.item_id === id)?.total).toBe(MIN_COUNT_SHOWN);
    await expect((async () => countClick("news", "nope", NOW))()).rejects.toThrow();
    await expect((async () => countClick("other", id, NOW))()).rejects.toThrow();
    disableSource(a.id, s.id);
    await expect((async () => countClick("news", id, NOW))()).rejects.toThrow(); // switched off: not countable
    const cols = (getDb().prepare("PRAGMA table_info(mhub_counts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => /person|viewer|member|reader/i.test(c))).toEqual([]);
  });

  it("reports: one per person per item, plain reasons, no links; a takedown hides news, recalls a video or switches off a channel", async () => {
    const a = admin(), b = admin(), u1 = mkPerson(), u2 = mkPerson();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW);
    await refreshSource(s.id, feedOf(RSS([{ t: "Disputed story here", l: "https://daily.example.net/d", d: "Thu, 26 Nov 2026 08:00:00 GMT" }])), NOW);
    const nid = newsFor(undefined, NOW).items[0].id;
    reportItem(u1.id, { kind: "news", id: nid, reason: "wrong" }, NOW);
    await expect((async () => reportItem(u1.id, { kind: "news", id: nid, reason: "wrong" }, NOW))()).rejects.toThrow(/already reported/);
    await expect((async () => reportItem(u2.id, { kind: "news", id: nid, reason: "nonsense" }, NOW))()).rejects.toThrow(/reason/);
    await expect((async () => reportItem(u2.id, { kind: "news", id: nid, reason: "wrong", note: "see https://x.example" }, NOW))()).rejects.toThrow(/note/);
    await expect((async () => reportItem(u2.id, { kind: "news", id: "missing", reason: "wrong" }, NOW))()).rejects.toThrow(/no such item/);
    reportItem(u2.id, { kind: "news", id: nid, reason: "partisan" }, NOW);
    const open = (getDb().prepare("SELECT id FROM mhub_reports WHERE status = 'open'").all() as { id: string }[]);
    expect(open).toHaveLength(2);
    await resolveReport(b.id, open[0].id, "takedown", NOW);
    expect(newsFor(undefined, NOW).items).toEqual([]); // hidden
    expect((getDb().prepare("SELECT COUNT(*) c FROM mhub_reports WHERE status = 'open'").get() as { c: number }).c).toBe(0); // both reports closed together
    const cols = (getDb().prepare("PRAGMA table_info(mhub_reports)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("person_id");
    // a video report takedown recalls the video
    const v = await createVideo(a.id, { title_en: "Explainer on results", media_url: "https://media.example.org/e.mp4", credit: "Own work 2026", confirm_neutral: true, confirm_rights: true }, NOW);
    await approveVideo(b.id, v.id, NOW);
    reportItem(u1.id, { kind: "video", id: v.id, reason: "broken" }, NOW);
    const vr = (getDb().prepare("SELECT id FROM mhub_reports WHERE kind = 'video'").get() as { id: string }).id;
    await resolveReport(a.id, vr, "takedown", NOW);
    expect(await liveFor(new Date(NOW.getTime() + 1000))).toEqual([]);
    // and a dismissal changes nothing
    const ch = addSource(a.id, { kind: "live", name_en: "Chan", site_url: "https://c.example.net/", permission_note: "Confirmed in writing by them", permission_date: "2026-11-21", contact: "x@c.example.net" }, NOW); enableSource(b.id, ch.id, NOW);
    reportItem(u1.id, { kind: "live", id: ch.id, reason: "other" }, NOW);
    await resolveReport(a.id, (getDb().prepare("SELECT id FROM mhub_reports WHERE kind = 'live'").get() as { id: string }).id, "dismiss", NOW);
    expect(liveChannels()).toHaveLength(1);
  });

  it("every step is audited", async () => {
    const { getStore } = await import("../../server/civic/core");
    const a = admin(), b = admin();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW); disableSource(a.id, s.id);
    const acts = (getStore("audit").prepare("SELECT action FROM audit_log WHERE action LIKE 'media.%'").all() as { action: string }[]).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["media.source.add", "media.source.enable", "media.source.disable"]));
  });
});

describe("video library, silence windows and corrections (S-229, S-231) @E2E-224", () => {
  const V = { title_en: "How to read your result", media_url: "https://media.example.org/e.mp4", credit: "People Pulse 2026", confirm_neutral: true, confirm_rights: true };
  it("an explainer can be kept in the Watch library with a transcript; links in a transcript are refused", async () => {
    const a = admin(), b = admin();
    const v = await createVideo(a.id, { ...V, library: true, transcript: "This explainer shows how a result sheet is read, row by row." }, NOW);
    await approveVideo(b.id, v.id, NOW);
    const item = (await liveFor(new Date(NOW.getTime() + 1000)))[0];
    expect(item).toMatchObject({ library: true });
    expect(item.transcript).toContain("result sheet");
    await expect((async () => await createVideo(a.id, { ...V, transcript: "Read more at https://example.org/page about it all" }, NOW))()).rejects.toThrow(/link/);
    const plain = await createVideo(a.id, V, NOW); await approveVideo(b.id, plain.id, NOW);
    expect((await liveFor(new Date(NOW.getTime() + 1000))).find((x) => x.id === plain.id)).toMatchObject({ library: false, transcript: null });
  });

  it("a silence window holds anything approved inside it until the window ends, and chained windows hold until the last", async () => {
    const a = admin(), b = admin();
    const w = await addWindow(a.id, { label: "Polling day silence", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-28T09:00:00Z" }, NOW);
    const v = await createVideo(a.id, V, NOW); await approveVideo(b.id, v.id, NOW);
    expect(await liveFor(new Date("2026-11-27T10:00:00Z"))).toEqual([]); // held
    expect(await liveFor(new Date("2026-11-28T09:00:01Z"))).toHaveLength(1); // released at the end
    await addWindow(a.id, { label: "Counting day", starts_at: "2026-11-28T09:00:00Z", ends_at: "2026-11-29T09:00:00Z" }, NOW);
    expect(await afterSilence("2026-11-27T10:00:00Z")).toBe("2026-11-29T09:00:00.000Z");
    expect(w.label).toBe("Polling day silence");
  });

  it("adding a window also holds an item that is already live inside it; a bad window is refused", async () => {
    const a = admin(), b = admin();
    const v = await createVideo(a.id, V, NOW); await approveVideo(b.id, v.id, NOW);
    expect(await liveFor(new Date("2026-11-26T10:00:05Z"))).toHaveLength(1);
    await addWindow(a.id, { label: "Sudden hold", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-27T09:00:00Z" }, NOW);
    expect(await liveFor(new Date("2026-11-26T10:00:05Z"))).toEqual([]);
    await expect((async () => await addWindow(a.id, { label: "Backwards", starts_at: "2026-11-30T00:00:00Z", ends_at: "2026-11-29T00:00:00Z" }, NOW))()).rejects.toThrow(/end must be after/);
    await expect((async () => await addWindow(a.id, { label: "Too long", starts_at: "2026-11-30T00:00:00Z", ends_at: "2026-12-30T00:00:00Z" }, NOW))()).rejects.toThrow(/within 14 days/);
    await expect((async () => await addWindow(a.id, { label: "Over", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-02T00:00:00Z" }, NOW))()).rejects.toThrow(/already over/);
  });

  it("a running window can only be ended early by a different admin", async () => {
    const a = admin(), b = admin();
    const w = await addWindow(a.id, { label: "Hold for the day", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-27T09:00:00Z" }, NOW);
    await expect((async () => await endWindow(a.id, w.id, NOW))()).rejects.toThrow(/different admin/);
    await endWindow(b.id, w.id, NOW);
    await expect((async () => await endWindow(b.id, w.id, NOW))()).rejects.toThrow(/no such active window/);
    expect(await afterSilence("2026-11-26T12:00:00.000Z")).toBe("2026-11-26T12:00:00.000Z");
  });

  it("window routes are admin only, and a recalled item that members could see shows as a correction for a week", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    expect((await call("POST", "/v/admin/windows", u.token, {})).status).toBe(403);
    const v = await createVideo(a.id, V, NOW); await approveVideo(b.id, v.id, NOW);
    await recallVideo(a.id, v.id, "Wrong video, a corrected one follows", new Date(NOW.getTime() + 60_000));
    const c = await correctionsFor(new Date(NOW.getTime() + 3_600_000));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ title_en: V.title_en, note: "Wrong video, a corrected one follows" });
    expect(await correctionsFor(new Date(NOW.getTime() + 9 * 86_400_000))).toEqual([]); // gone after a week
    const never = await createVideo(a.id, V, NOW); // a pending item that members never saw is not a correction
    expect(never.status).toBe("pending");
  });
});

describe("YouTube channel news: official feed, embed id only (S-238) @E2E-227", () => {
  const CH = "UC" + "a".repeat(22);
  const ATOM = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>Evening bulletin</title><link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/><published>2026-11-26T08:00:00+00:00</published><media:group><media:description>Long description that we never keep</media:description></media:group></entry></feed>`;
  it("youtubeId accepts watch, short and youtu.be links only, with an 11 character id", async () => {
    const { youtubeId } = await import("../../server/civic/mediahub");
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://evil.example.net/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E")).toBeNull();
  });
  it("a channel id builds the official feed address itself; a bad id or a live source is refused; it still needs permission and a second admin", async () => {
    const a = admin(), b = admin();
    await expect((async () => addSource(a.id, { ...NEWS, feed_url: undefined, site_url: undefined, youtube_channel_id: "UCshort" }, NOW))()).rejects.toThrow(/channel id/);
    await expect((async () => addSource(a.id, { ...NEWS, kind: "live", youtube_channel_id: CH }, NOW))()).rejects.toThrow(/channel id/);
    const s = addSource(a.id, { ...NEWS, feed_url: "https://evil.example.net/x", site_url: undefined, youtube_channel_id: CH }, NOW);
    expect(s.feed_url).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`);
    expect(s.enabled).toBe(0);
    await expect((async () => enableSource(a.id, s.id, NOW))()).rejects.toThrow(/different admin/);
    enableSource(b.id, s.id, NOW);
  });
  it("reading the channel feed keeps title, link and date; members get the embed id and no description", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, { ...NEWS, feed_url: undefined, site_url: undefined, youtube_channel_id: CH, allow: "headline" }, NOW);
    enableSource(b.id, s.id, NOW);
    expect((await refreshSource(s.id, feedOf(ATOM), NOW)).added).toBe(1);
    const n = newsFor(undefined, NOW).items[0];
    expect(n.title).toBe("Evening bulletin");
    expect(n.youtube).toBe("dQw4w9WgXcQ");
    expect(n.snippet).toBeNull();
  });
});

describe("paste-a-link: one YouTube video (S-239) @E2E-229", () => {
  const V = { link: "https://youtu.be/dQw4w9WgXcQ", title: "Flood relief update", channel_name: "Channel TV", state: "AP", permission_note: "Channel owner confirmed in writing, 24 Nov 2026", permission_date: "2026-11-24", contact: "tv@channel.example" };
  it("only a YouTube video link is accepted, and the headline is typed by the admin", async () => {
    const { addVideoLink } = await import("../../server/civic/mediahub");
    const a = admin();
    await expect((async () => addVideoLink(a.id, { ...V, link: "https://evil.example.net/watch?v=dQw4w9WgXcQ" }, NOW))()).rejects.toThrow(/YouTube video link/);
    await expect((async () => addVideoLink(a.id, { ...V, link: "https://www.youtube.com/@channel" }, NOW))()).rejects.toThrow(/YouTube video link/);
    await expect((async () => addVideoLink(a.id, { ...V, title: "" }, NOW))()).rejects.toThrow(/title/);
  });
  it("starts off, needs the permission record and a different admin, then members get the embed id; it is never fetched or called stale", async () => {
    const { addVideoLink } = await import("../../server/civic/mediahub");
    const a = admin(), b = admin();
    const s = addVideoLink(a.id, V, NOW);
    expect(s.enabled).toBe(0);
    expect(s.feed_url).toBeNull();
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
    await expect((async () => enableSource(a.id, s.id, NOW))()).rejects.toThrow(/different admin/);
    enableSource(b.id, s.id, NOW);
    const later = new Date(NOW.getTime() + 20 * 3_600_000);
    await refreshDue(async () => { throw new Error("must not fetch"); }, later);
    const n = newsFor(undefined, later);
    expect(n.items[0].youtube).toBe("dQw4w9WgXcQ");
    expect(n.items[0].title).toBe("Flood relief update");
    expect(n.sources[0].stale).toBe(false);
    expect(newsFor(undefined, new Date(NOW.getTime() + 8 * 86_400_000)).items).toHaveLength(0);
  });
  it("is admin-only", async () => {
    const u = mkPerson();
    expect((await call("POST", "/m/admin/videos", u.token, V)).status).toBe(403);
    expect((await call("POST", "/m/admin/videos", admin().token, V)).status).toBe(201);
  });
});

describe("live channel with a YouTube live link (S-241) @E2E-233", () => {
  const CH = { kind: "live", name_en: "Channel Live", site_url: "https://one.example.net/", stream_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", permission_note: "Confirmed in writing by the channel, 21 Nov 2026", permission_date: "2026-11-21", contact: "tech@one.example.net" };
  it("a YouTube live link is accepted as the stream without the host list, still needs a second admin, and cannot be health-checked by us", async () => {
    const a = admin(), b = admin();
    const s = addSource(a.id, CH, NOW);
    expect(s.stream_url).toContain("youtube.com/watch");
    await expect((async () => addSource(a.id, { ...CH, stream_url: "https://elsewhere.example.net/live.m3u8" }, NOW))()).rejects.toThrow(/approved list/);
    await expect((async () => enableSource(a.id, s.id, NOW))()).rejects.toThrow(/different admin/);
    enableSource(b.id, s.id, NOW);
    expect(liveChannels()).toHaveLength(1);
    await expect(checkStream(s.id, async () => { throw new Error("must not fetch"); }, NOW)).rejects.toThrow(/YouTube/);
  });
});

describe("candidate AP and Telangana news sources, loaded switched off (S-242) @E2E-235", () => {
  const PERM = { permission_note: "Written reuse permission from the editor, mail of 25 Nov 2026", permission_date: "2026-11-25", contact: "desk@thehindu.example" };
  it("two official state feeds exist, off, with no permission, and show nothing to members", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    const ap = getSource("cand-hindu-ap"), tg = getSource("cand-hindu-tg");
    expect(ap.feed_url).toBe("https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss");
    expect(tg.feed_url).toBe("https://www.thehindu.com/news/national/telangana/feeder/default.rss");
    expect([ap.enabled, tg.enabled]).toEqual([0, 0]);
    expect([ap.state, tg.state]).toEqual(["AP", "TG"]);
    expect(ap.permission_note).toBeNull();
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
    await expect((async () => enableSource(admin().id, "cand-hindu-ap", NOW))()).rejects.toThrow(/record the permission/);
    await expect(refreshSource("cand-hindu-ap", feedOf("<rss/>"), NOW)).rejects.toThrow(/switched off/);
  });
  it("the admin who records the permission cannot switch it on; a different admin can; then the feed is read for its state only", async () => {
    const a = admin(), b = admin();
    await expect((async () => recordPermission(a.id, "cand-hindu-ap", { ...PERM, permission_date: "2099-01-01" }, NOW))()).rejects.toThrow(/date/);
    recordPermission(a.id, "cand-hindu-ap", PERM, NOW);
    await expect((async () => enableSource(a.id, "cand-hindu-ap", NOW))()).rejects.toThrow(/different admin/);
    enableSource(b.id, "cand-hindu-ap", NOW);
    await refreshSource("cand-hindu-ap", feedOf(RSS([{ t: "Water scheme opens", l: "https://www.thehindu.com/x/1.ece", d: "Thu, 26 Nov 2026 08:00:00 GMT" }])), NOW);
    expect(newsFor("AP", NOW).items).toHaveLength(1);
    expect(newsFor("TG", NOW).items).toHaveLength(0); // an AP-only source is not shown to the Telangana view
  });
  it("recording a permission is admin-only and cannot change a source that is on", async () => {
    const u = mkPerson(), a = admin(), b = admin();
    expect((await call("POST", "/m/admin/sources/cand-hindu-tg/permission", u.token, PERM)).status).toBe(403);
    expect((await call("POST", "/m/admin/sources/cand-hindu-tg/permission", a.token, PERM)).status).toBe(200);
    enableSource(b.id, "cand-hindu-tg", NOW);
    expect((await call("POST", "/m/admin/sources/cand-hindu-tg/permission", a.token, PERM)).status).toBe(400);
  });
});

describe("candidate Telugu channel feeds, loaded switched off (S-244) @E2E-239", () => {
  it("NTV Telugu, TV9 Telugu, 10TV and Sakshi exist off with no permission and show nothing; enabling is refused until permission is recorded", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    for (const [id, feed] of [["cand-ntv", "https://ntvtelugu.com/feed"], ["cand-tv9", "https://tv9telugu.com/feed"], ["cand-10tv", "https://10tv.in/feed"], ["cand-sakshi", "https://www.sakshi.com/rss.xml"]] as const) {
      const c = getSource(id);
      expect(c.feed_url).toBe(feed);
      expect(c.enabled).toBe(0);
      expect(c.permission_note).toBeNull();
      expect(c.name_te).toBeTruthy();
      await expect((async () => enableSource(admin().id, id, NOW))()).rejects.toThrow(/record the permission/);
    }
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
  });
});

describe("demo news preview (S-245) @E2E-240", () => {
  afterEach(() => { delete process.env.CIVIC_DEMO_NEWS; });
  it("does nothing unless CIVIC_DEMO_NEWS=1, and never in production", async () => {
    ensureDemoNews(NOW);
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
    process.env.CIVIC_DEMO_NEWS = "1";
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { ensureDemoNews(NOW); expect(newsFor(undefined, NOW).items).toHaveLength(0); } finally { process.env.NODE_ENV = prev; }
  });
  it("offers three sample clips from our own server only when the demo is on", async () => {
    expect(demoVideos()).toEqual([]);
    process.env.CIVIC_DEMO_NEWS = "1";
    const v = demoVideos();
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.media_url.startsWith("/demo/") && /demo, not news/.test(x.title))).toBe(true);
  });
  it("adds one labelled sample source with five sample headlines, no real outlet, refreshed each call without duplicates", async () => {
    process.env.CIVIC_DEMO_NEWS = "1";
    ensureDemoNews(NOW); ensureDemoNews(new Date(NOW.getTime() + 3600_000));
    const n = newsFor(undefined, new Date(NOW.getTime() + 3600_000));
    expect(n.items).toHaveLength(5);
    expect(n.items.every((i) => i.title.startsWith("Sample headline") && i.link.startsWith("https://example.com/") && /DEMO/.test(i.outlet_en))).toBe(true);
    expect(n.sources[0].stale).toBe(false);
  });
  it("adds one labelled sample live channel that plays a sample clip from our own server, once, and none when the demo is off", async () => {
    ensureDemoNews(NOW);
    expect(liveChannels()).toEqual([]);
    process.env.CIVIC_DEMO_NEWS = "1";
    ensureDemoNews(NOW); ensureDemoNews(NOW);
    const l = liveChannels();
    expect(l).toHaveLength(1);
    expect(l[0].stream_url).toBe("/demo/sample-1.webm");
    expect(/DEMO/.test(l[0].name_en)).toBe(true);
  });
});

describe("candidate Google News topic feeds, loaded switched off (S-278) @E2E-241", () => {
  it("four Google News feeds (AP and Telangana, English and Telugu) exist off with no permission and show nothing; enabling is refused until permission is recorded", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    for (const [id, state, lang] of [["cand-gnews-ap-en", "AP", "en-IN"], ["cand-gnews-tg-en", "TG", "en-IN"], ["cand-gnews-ap-te", "AP", "te"], ["cand-gnews-tg-te", "TG", "te"]] as const) {
      const c = getSource(id);
      expect(c.feed_url?.startsWith("https://news.google.com/rss/search?q=")).toBe(true);
      expect(c.feed_url).toContain(`&hl=${lang}&gl=IN&ceid=IN:`);
      expect(c.state).toBe(state);
      expect(c.enabled).toBe(0);
      expect(c.permission_note).toBeNull();
      expect(c.name_te).toBeTruthy();
      await expect((async () => enableSource(admin().id, id, NOW))()).rejects.toThrow(/record the permission/);
    }
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
  });
});

describe("candidate Telugu news channels on YouTube, loaded switched off (S-279) @E2E-242", () => {
  it("ten channels exist off with a YouTube video feed and no permission, show nothing, and cannot be enabled until permission is recorded", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    for (const [id, ch] of [["cand-yt-ntv", "UCumtYpCY26F6Jr3satUgMvA"],["cand-yt-tv9", "UCPXTXMecYqnRKNdqdVOGSFg"],["cand-yt-10tv", "UCfymZbh17_3T_UhgjkQ9fRQ"],["cand-yt-sakshi", "UCZ9m4KOh8Ei60428xeGYDCQ"],["cand-yt-abn", "UC_2irx_BQR7RsBKmUV9fePQ"],["cand-yt-tv5", "UCAR3h_9fLV82N2FH4cE4RKw"],["cand-yt-v6", "UCDCMjD1XIAsCZsYHNMGVcog"],["cand-yt-tnews", "UCu6edg8_eu3-A8ylgaWereA"],["cand-yt-mahaa", "UCDKjhgRoPF1CQk7HluMz23A"],["cand-yt-etv", "UCJi8M0hRKjz8SLPvJKEVTOg"]] as const) {
      const c = getSource(id);
      expect(c.feed_url).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`);
      expect(c.enabled).toBe(0);
      expect(c.permission_note).toBeNull();
      expect(c.name_te).toBeTruthy();
      await expect((async () => enableSource(admin().id, id, NOW))()).rejects.toThrow(/record the permission/);
    }
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
  });
});

describe("harvested candidates: live channels, news feeds and video channels, all switched off (S-280 to S-282) @E2E-243", () => {
  const CH = /^UC[A-Za-z0-9_-]{22}$/;
  it("fifteen live channels exist off, each with a youtube.com/channel/UC.../live stream address and no permission, and none shows to members", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    const ids = ["ntv", "tv9", "sakshi", "10tv", "tv5", "abn", "v6", "tnews", "mahaa", "etv", "ddnews", "sansad", "ddsaptagiri", "aljazeera", "dw"];
    for (const k of ids) {
      const c = getSource(`cand-live-${k}`);
      expect(c.kind).toBe("live");
      expect(c.stream_url).toMatch(/^https:\/\/www\.youtube\.com\/channel\/UC[A-Za-z0-9_-]{22}\/live$/);
      expect(CH.test(c.stream_url!.split("/")[4])).toBe(true);
      expect([c.enabled, c.permission_note, c.name_te ? 1 : 0]).toEqual([0, null, 1]);
      await expect((async () => enableSource(admin().id, `cand-live-${k}`, NOW))()).rejects.toThrow(/record the permission/);
    }
    expect(liveChannels()).toEqual([]);
  });
  it("twenty-one news feeds and eight video channels exist off with no permission, and newsFor shows nothing", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    const feeds = ["bbc-te", "oneindia-te", "visalaandhra", "prabha", "andhrajyothy", "namasthe", "news18-ap", "news18-tg", "asianet-te", "abp-te", "telanganatoday", "hans-ap", "hans-tg", "hindu-hyd", "hindu-vja", "nie-ap", "toi-hyd", "ie-hyd", "tg-gov", "pib", "air"];
    for (const k of feeds) {
      const c = getSource(`cand-feed-${k}`);
      expect(c.feed_url).toMatch(/^https:\/\//);
      expect([c.kind, c.enabled, c.permission_note]).toEqual(["news", 0, null]);
      await expect((async () => enableSource(admin().id, `cand-feed-${k}`, NOW))()).rejects.toThrow(/record the permission/);
    }
    const vids = ["ddnews", "sansad", "pib", "bbc-te", "hans", "ddsaptagiri", "dw", "aljazeera"];
    for (const k of vids) {
      const c = getSource(`cand-ytv-${k}`);
      expect(c.feed_url).toMatch(/^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=UC[A-Za-z0-9_-]{22}$/);
      expect([c.enabled, c.permission_note]).toEqual([0, null]);
    }
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
  });
  it("an admin can add a live channel by its YouTube channel live address; the stream check does not try to fetch it", async () => {
    const { isYoutubeLiveChannel } = await import("../../server/civic/mediahub");
    expect(isYoutubeLiveChannel("https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live")).toBe(true);
    for (const u of ["https://www.youtube.com/channel/UCshort/live", "https://evil.example.net/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live", "http://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live"]) expect(isYoutubeLiveChannel(u)).toBe(false);
    const a = admin();
    const s = addSource(a.id, { kind: "live", name_en: "Live by channel", site_url: "https://channel-live.example.net/", stream_url: "https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live", permission_note: "Written permission by mail, 27 Nov 2026", permission_date: "2026-11-27", contact: "desk@channel-live.example" }, NOW);
    expect(s.stream_url).toBe("https://www.youtube.com/channel/UCKwucPzHZ7zCUIf7If-Wo1g/live");
  });
});

describe("preview of the loaded candidates, development only (S-283) @E2E-245", () => {
  afterEach(() => { delete process.env.CIVIC_PREVIEW_SOURCES; applyPreviewSources(NOW); });
  it("does nothing unless CIVIC_PREVIEW_SOURCES=1, and never in production", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    applyPreviewSources(NOW);
    expect(previewSourcesEnabled()).toBe(false);
    expect(getSource("cand-ntv").enabled).toBe(0);
    process.env.CIVIC_PREVIEW_SOURCES = "1";
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
    try { applyPreviewSources(NOW); expect(previewSourcesEnabled()).toBe(false); expect(getSource("cand-ntv").enabled).toBe(0); } finally { process.env.NODE_ENV = prev; }
  });
  it("switches only the loaded candidates on, with a plain preview note and no invented permission, and puts them back when the setting goes", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    process.env.CIVIC_PREVIEW_SOURCES = "1";
    applyPreviewSources(NOW);
    const c = getSource("cand-ntv");
    expect([c.enabled, c.enabled_by, c.permission_note]).toEqual([1, "preview-setting", PREVIEW_NOTE]);
    expect(liveChannels().length).toBeGreaterThanOrEqual(15);
    delete process.env.CIVIC_PREVIEW_SOURCES;
    applyPreviewSources(NOW);
    const off = getSource("cand-ntv");
    expect([off.enabled, off.enabled_by, off.permission_note]).toEqual([0, null, null]);
    expect(liveChannels()).toEqual([]);
  });
  it("leaves a source an admin switched on, or one with a real permission record, untouched", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    const a = admin(), b = admin();
    recordPermission(a.id, "cand-tv9", { permission_note: "Written permission from the channel, 27 Nov 2026", permission_date: "2026-11-27", contact: "desk@tv9.example" }, NOW);
    enableSource(b.id, "cand-tv9", NOW);
    process.env.CIVIC_PREVIEW_SOURCES = "1";
    applyPreviewSources(NOW);
    delete process.env.CIVIC_PREVIEW_SOURCES;
    applyPreviewSources(NOW);
    const c = getSource("cand-tv9");
    expect([c.enabled, c.permission_note]).toEqual([1, "Written permission from the channel, 27 Nov 2026"]);
    disableSource(a.id, "cand-tv9");
  });
});

describe("more harvested candidates, all switched off (S-284 to S-286) @E2E-246", () => {
  it("25 more news feeds, 16 more video channels and 14 more live channels exist off with no permission, and show nothing", async () => {
    const { getSource } = await import("../../server/civic/mediahub");
    const feeds = ["ht-india", "firstpost", "vaartha", "tnie-tg", "dc", "indiatoday-rss", "ndtv-rss", "news18-in", "hindu-natl", "hindu-tg-state", "ie-india", "ie-explained", "toi-top", "toi-india", "bbc-world", "bbc-india", "sky-world", "euronews-rss", "abc-au-rss", "npr", "cna-asia", "un-news", "nasa", "greatandhra", "bizstd"];
    for (const k of feeds) { const c = getSource(`cand-feed-${k}`); expect([c.kind, c.enabled, c.permission_note]).toEqual(["news", 0, null]); expect(c.feed_url).toMatch(/^https:\/\//); }
    const vids = ["prime9", "etv-tg", "cvr", "studion", "akashvani", "mygov", "ndtv", "indiatoday", "timesnow", "cnn18", "euronews", "france24", "sky", "abc-au", "nhk", "trt"];
    for (const k of vids) { const c = getSource(`cand-ytv-${k}`); expect([c.enabled, c.permission_note]).toEqual([0, null]); expect(c.feed_url).toMatch(/channel_id=UC[A-Za-z0-9_-]{22}$/); }
    const live = ["prime9", "etv-tg", "cvr", "akashvani", "ndtv", "indiatoday", "timesnow", "cnn18", "euronews", "france24", "sky", "abc-au", "nhk", "trt"];
    for (const k of live) { const c = getSource(`cand-live-${k}`); expect([c.kind, c.enabled, c.permission_note]).toEqual(["live", 0, null]); expect(c.stream_url).toMatch(/\/channel\/UC[A-Za-z0-9_-]{22}\/live$/); }
    expect(newsFor(undefined, NOW).items).toHaveLength(0);
    expect(liveChannels()).toEqual([]);
  });
});
