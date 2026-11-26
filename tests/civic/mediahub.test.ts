import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { getDb, grantRole, migrate, resetDbForTests } from "../../server/civic/core";
import { mediaRouter, parseFeed, addSource, enableSource, disableSource, refreshSource, refreshDue, newsFor, checkStream, liveChannels, countClick, numbers, reportItem, resolveReport, checkUrl, MIN_COUNT_SHOWN, type Fetcher } from "../../server/civic/mediahub";
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
  it("a source starts switched off, needs the permission record, and a DIFFERENT admin must switch it on; any admin can switch it off", () => {
    const a = admin(), b = admin();
    const noPerm = addSource(a.id, { ...NEWS, permission_note: undefined, permission_date: undefined, contact: undefined }, NOW);
    expect(noPerm.enabled).toBe(0);
    expect(() => enableSource(b.id, noPerm.id, NOW)).toThrow(/record the permission/);
    const s = addSource(a.id, NEWS, NOW);
    expect(() => enableSource(a.id, s.id, NOW)).toThrow(/different admin/);
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

  it("addresses must be https with no login and a stream must be on the approved host list", () => {
    expect(() => checkUrl("x", "http://daily.example.net/feed")).toThrow(/https/);
    expect(() => checkUrl("x", "https://u:p@daily.example.net/feed")).toThrow(/login/);
    expect(() => checkUrl("x", "javascript:alert(1)")).toThrow();
    expect(checkUrl("x", "https://daily.example.net/feed")).toContain("https://");
    expect(() => checkUrl("stream", "https://elsewhere.example.net/live.m3u8", { allowedHostsOnly: true })).toThrow(/approved list/);
    expect(checkUrl("stream", "https://streams.example.org/live.m3u8", { allowedHostsOnly: true })).toContain("streams.example.org");
  });

  it("the feed reader takes RSS and Atom, keeps headline, link and time, skips broken items and never keeps the article", () => {
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
    expect(() => addSource(a.id, { kind: "live", name_en: "Other", site_url: "https://o.example.net/", stream_url: "https://not-listed.example.net/x.m3u8" }, NOW)).toThrow(/approved list/);
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
    expect(() => countClick("news", "nope", NOW)).toThrow();
    expect(() => countClick("other", id, NOW)).toThrow();
    disableSource(a.id, s.id);
    expect(() => countClick("news", id, NOW)).toThrow(); // switched off: not countable
    const cols = (getDb().prepare("PRAGMA table_info(mhub_counts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => /person|viewer|member|reader/i.test(c))).toEqual([]);
  });

  it("reports: one per person per item, plain reasons, no links; a takedown hides news, recalls a video or switches off a channel", async () => {
    const a = admin(), b = admin(), u1 = mkPerson(), u2 = mkPerson();
    const s = addSource(a.id, NEWS, NOW); enableSource(b.id, s.id, NOW);
    await refreshSource(s.id, feedOf(RSS([{ t: "Disputed story here", l: "https://daily.example.net/d", d: "Thu, 26 Nov 2026 08:00:00 GMT" }])), NOW);
    const nid = newsFor(undefined, NOW).items[0].id;
    reportItem(u1.id, { kind: "news", id: nid, reason: "wrong" }, NOW);
    expect(() => reportItem(u1.id, { kind: "news", id: nid, reason: "wrong" }, NOW)).toThrow(/already reported/);
    expect(() => reportItem(u2.id, { kind: "news", id: nid, reason: "nonsense" }, NOW)).toThrow(/reason/);
    expect(() => reportItem(u2.id, { kind: "news", id: nid, reason: "wrong", note: "see https://x.example" }, NOW)).toThrow(/note/);
    expect(() => reportItem(u2.id, { kind: "news", id: "missing", reason: "wrong" }, NOW)).toThrow(/no such item/);
    reportItem(u2.id, { kind: "news", id: nid, reason: "partisan" }, NOW);
    const open = (getDb().prepare("SELECT id FROM mhub_reports WHERE status = 'open'").all() as { id: string }[]);
    expect(open).toHaveLength(2);
    resolveReport(b.id, open[0].id, "takedown", NOW);
    expect(newsFor(undefined, NOW).items).toEqual([]); // hidden
    expect((getDb().prepare("SELECT COUNT(*) c FROM mhub_reports WHERE status = 'open'").get() as { c: number }).c).toBe(0); // both reports closed together
    const cols = (getDb().prepare("PRAGMA table_info(mhub_reports)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("person_id");
    // a video report takedown recalls the video
    const v = createVideo(a.id, { title_en: "Explainer on results", media_url: "https://media.example.org/e.mp4", credit: "Own work 2026", confirm_neutral: true, confirm_rights: true }, NOW);
    approveVideo(b.id, v.id, NOW);
    reportItem(u1.id, { kind: "video", id: v.id, reason: "broken" }, NOW);
    const vr = (getDb().prepare("SELECT id FROM mhub_reports WHERE kind = 'video'").get() as { id: string }).id;
    resolveReport(a.id, vr, "takedown", NOW);
    expect(liveFor(new Date(NOW.getTime() + 1000))).toEqual([]);
    // and a dismissal changes nothing
    const ch = addSource(a.id, { kind: "live", name_en: "Chan", site_url: "https://c.example.net/", permission_note: "Confirmed in writing by them", permission_date: "2026-11-21", contact: "x@c.example.net" }, NOW); enableSource(b.id, ch.id, NOW);
    reportItem(u1.id, { kind: "live", id: ch.id, reason: "other" }, NOW);
    resolveReport(a.id, (getDb().prepare("SELECT id FROM mhub_reports WHERE kind = 'live'").get() as { id: string }).id, "dismiss", NOW);
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
  it("an explainer can be kept in the Watch library with a transcript; links in a transcript are refused", () => {
    const a = admin(), b = admin();
    const v = createVideo(a.id, { ...V, library: true, transcript: "This explainer shows how a result sheet is read, row by row." }, NOW);
    approveVideo(b.id, v.id, NOW);
    const item = liveFor(new Date(NOW.getTime() + 1000))[0];
    expect(item).toMatchObject({ library: true });
    expect(item.transcript).toContain("result sheet");
    expect(() => createVideo(a.id, { ...V, transcript: "Read more at https://example.org/page about it all" }, NOW)).toThrow(/link/);
    const plain = createVideo(a.id, V, NOW); approveVideo(b.id, plain.id, NOW);
    expect(liveFor(new Date(NOW.getTime() + 1000)).find((x) => x.id === plain.id)).toMatchObject({ library: false, transcript: null });
  });

  it("a silence window holds anything approved inside it until the window ends, and chained windows hold until the last", () => {
    const a = admin(), b = admin();
    const w = addWindow(a.id, { label: "Polling day silence", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-28T09:00:00Z" }, NOW);
    const v = createVideo(a.id, V, NOW); approveVideo(b.id, v.id, NOW);
    expect(liveFor(new Date("2026-11-27T10:00:00Z"))).toEqual([]); // held
    expect(liveFor(new Date("2026-11-28T09:00:01Z"))).toHaveLength(1); // released at the end
    addWindow(a.id, { label: "Counting day", starts_at: "2026-11-28T09:00:00Z", ends_at: "2026-11-29T09:00:00Z" }, NOW);
    expect(afterSilence("2026-11-27T10:00:00Z")).toBe("2026-11-29T09:00:00.000Z");
    expect(w.label).toBe("Polling day silence");
  });

  it("adding a window also holds an item that is already live inside it; a bad window is refused", () => {
    const a = admin(), b = admin();
    const v = createVideo(a.id, V, NOW); approveVideo(b.id, v.id, NOW);
    expect(liveFor(new Date("2026-11-26T10:00:05Z"))).toHaveLength(1);
    addWindow(a.id, { label: "Sudden hold", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-27T09:00:00Z" }, NOW);
    expect(liveFor(new Date("2026-11-26T10:00:05Z"))).toEqual([]);
    expect(() => addWindow(a.id, { label: "Backwards", starts_at: "2026-11-30T00:00:00Z", ends_at: "2026-11-29T00:00:00Z" }, NOW)).toThrow(/end must be after/);
    expect(() => addWindow(a.id, { label: "Too long", starts_at: "2026-11-30T00:00:00Z", ends_at: "2026-12-30T00:00:00Z" }, NOW)).toThrow(/within 14 days/);
    expect(() => addWindow(a.id, { label: "Over", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-02T00:00:00Z" }, NOW)).toThrow(/already over/);
  });

  it("a running window can only be ended early by a different admin", () => {
    const a = admin(), b = admin();
    const w = addWindow(a.id, { label: "Hold for the day", starts_at: "2026-11-26T09:00:00Z", ends_at: "2026-11-27T09:00:00Z" }, NOW);
    expect(() => endWindow(a.id, w.id, NOW)).toThrow(/different admin/);
    endWindow(b.id, w.id, NOW);
    expect(() => endWindow(b.id, w.id, NOW)).toThrow(/no such active window/);
    expect(afterSilence("2026-11-26T12:00:00.000Z")).toBe("2026-11-26T12:00:00.000Z");
  });

  it("window routes are admin only, and a recalled item that members could see shows as a correction for a week", async () => {
    const a = admin(), b = admin(), u = mkPerson();
    expect((await call("POST", "/v/admin/windows", u.token, {})).status).toBe(403);
    const v = createVideo(a.id, V, NOW); approveVideo(b.id, v.id, NOW);
    recallVideo(a.id, v.id, "Wrong video, a corrected one follows", new Date(NOW.getTime() + 60_000));
    const c = correctionsFor(new Date(NOW.getTime() + 3_600_000));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ title_en: V.title_en, note: "Wrong video, a corrected one follows" });
    expect(correctionsFor(new Date(NOW.getTime() + 9 * 86_400_000))).toEqual([]); // gone after a week
    const never = createVideo(a.id, V, NOW); // a pending item that members never saw is not a correction
    expect(never.status).toBe("pending");
  });
});
