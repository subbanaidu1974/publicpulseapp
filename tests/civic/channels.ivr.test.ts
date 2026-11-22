import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaOwnerPseudonym, reporterPseudonym } from "../../server/civic/core/pseudonyms";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb, migrate, resetDbForTests, smsOutbox, getStore } from "../../server/civic/core";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { issuesRouter } from "../../server/civic/issues/routes";
import { createPerson, checkPin, getPerson, pinCeiling } from "../../server/civic/identity/service";
import { CATEGORY_LIST } from "../../server/civic/issues/categories";
import { getMedia, readMediaFile, setMediaScanner } from "../../server/civic/issues/media";
import {
  CATEGORIES, PROMPTS, allowedRecordingUrl, createChannelsRouter, setRecordingFetcher, type ChannelDeps,
} from "../../server/civic/channels/routes";
import { callTtlMs, sqliteCallStore } from "../../server/civic/channels/callstore";

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "civic-ivr-media-"));
process.env.CIVIC_MEDIA_DIR = mediaDir;
process.env.CIVIC_VOICE_MAX_BYTES = "3000";
process.env.CIVIC_IVR_RECORDING_HOSTS = "rec.aggregator.example,*.cdn.aggregator.example";

const PHONE = "+919876544000", LOCAL = "9876544000", PIN = "4821";
let issuesServer: Server, chanServer: Server, chan = "", person: { id: string };
let clock = 5_000_000;
const deps = (): ChannelDeps | undefined => undefined;
void deps;

const wav = (n = 200) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(n, 1)]);
const post = async (p: string, body: unknown) => {
  const r = await fetch(chan + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function serve(d?: ChannelDeps) {
  const c = express();
  c.use("/channels", createChannelsRouter(d));
  const s = c.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/channels` };
}
const clockDeps = (): ChannelDeps => ({
  now: () => clock,
  sendSms: async () => { /* not under test */ },
  createIssue: async () => ({ id: "ISS-1" }),
});
async function toCategory() {
  const { body } = await post("/missed-call", { from: LOCAL });
  const callId = body.callId as string;
  await post("/ivr", { callId });
  await post("/ivr", { callId, digits: "1" });
  await post("/ivr", { callId, digits: PIN });
  return callId;
}

beforeAll(async () => {
  resetDbForTests(); migrate(); loadDemoGeo();
  const app = express();
  app.use("/api/v1/civic/issues", express.json(), issuesRouter);
  issuesServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => issuesServer.once("listening", r));
  process.env.CIVIC_INTERNAL_BASE = `http://127.0.0.1:${(issuesServer.address() as AddressInfo).port}`;
});
afterAll(() => { issuesServer.close(); fs.rmSync(mediaDir, { recursive: true, force: true }); delete process.env.CIVIC_IVR_RECORDING_HOSTS; });
beforeEach(async () => {
  resetDbForTests(); migrate(); loadDemoGeo();
  setMediaScanner(null); smsOutbox.length = 0; clock = 5_000_000;
  const r = await serve();
  chanServer = r.s; chan = r.url;
  person = createPerson({ phone: PHONE, pin: PIN, label: "Amma", consentVersion: "v1" });
  getDb().prepare("UPDATE persons SET residence_unit=?, residence_declared_at=? WHERE id=?").run("DEMO-V-KLR", new Date().toISOString(), person.id);
});
afterEach(() => { chanServer.close(); setRecordingFetcher(null); vi.restoreAllMocks(); });

describe("IVR menu: all nine categories (S-146, S-148)", () => {
  it("@E2E-161 the spoken menu and the key map are generated from the nine web categories", async () => {
    expect(Object.values(CATEGORIES)).toEqual(CATEGORY_LIST.map((c) => c.id));
    expect(Object.keys(CATEGORIES)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const c of CATEGORY_LIST) { expect(PROMPTS.category.textTe).toContain(`${c.label_te} ${c.ivrDigit}`); expect(PROMPTS.category.textEn).toContain(`${c.label_en.toLowerCase()} ${c.ivrDigit}`); }
    const manifest = JSON.parse(fs.readFileSync("data/civic/audio-manifest.json", "utf8")) as { prompts: { id: string; textTe: string }[] };
    expect(manifest.prompts.find((p) => p.id === "category")!.textTe).toBe(PROMPTS.category.textTe); // the recording script matches
  });

  it("@E2E-161 every key 1-9 selects its category; 0 is invalid", async () => {
    for (const c of CATEGORY_LIST) {
      chanServer.close(); const fresh = await serve(); chanServer = fresh.s; chan = fresh.url; // the missed-call limiter is per router
      const callId = await toCategory();
      const rec = await post("/ivr", { callId, digits: c.ivrDigit });
      expect(rec.body.state).toBe("record");
      const done = await post("/ivr", { callId, recording: `voice/${c.id}.wav` });
      expect((getStore("issues").prepare("SELECT category FROM issue WHERE id=?").get(done.body.referenceId) as any).category).toBe(c.id);
      clock += 1;
    }
    chanServer.close(); const fresh = await serve(); chanServer = fresh.s; chan = fresh.url;
    const callId = await toCategory();
    expect((await post("/ivr", { callId, digits: "0" })).body.prompts[0].id).toBe("invalid");
  });
});

describe("persisted call state (S-146)", () => {
  it("@E2E-161 a call survives a router restart, and the caller's number is not stored in clear", async () => {
    const a = await serve(clockDeps());
    chan = a.url;
    const { body } = await post("/missed-call", { from: "9123400001" });
    await post("/ivr", { callId: body.callId });
    a.s.close(); // "restart": a brand-new router with empty memory over the same database
    const b = await serve(clockDeps());
    chan = b.url;
    try {
      const next = await post("/ivr", { callId: body.callId, digits: "3" });
      expect(next.status).toBe(200);
      expect(next.body.state).toBe("survey");
      const row = getStore("issues").prepare("SELECT * FROM ivr_call WHERE call_id=?").get(body.callId) as any;
      expect(row.state).toBe("survey");
      expect(JSON.stringify(row)).not.toContain("9123400001");
      expect(row.phone_enc).toMatch(/^v1\./);
    } finally { b.s.close(); }
  });

  it("@E2E-161 state expires after the TTL and is pruned", async () => {
    const a = await serve(clockDeps());
    chan = a.url;
    try {
      const { body } = await post("/missed-call", { from: "9123400002" });
      expect(callTtlMs()).toBe(15 * 60_000);
      clock += callTtlMs() - 1000;
      expect((await post("/ivr", { callId: body.callId })).status).toBe(200);
      clock += 2000;
      expect((await post("/ivr", { callId: body.callId })).status).toBe(404);
      expect(getStore("issues").prepare("SELECT COUNT(*) c FROM ivr_call").get()).toMatchObject({ c: 0 });
      const two = await post("/missed-call", { from: "9123400003" });
      expect(sqliteCallStore.prune(clock + callTtlMs() + 1)).toBe(1);
      expect((await post("/ivr", { callId: two.body.callId })).status).toBe(404);
    } finally { a.s.close(); }
  });

  it("@E2E-161 an ended call is not resurrected by the persistence step", async () => {
    const callId = await toCategory();
    // five wrong PINs on a fresh call end it
    const { body } = await post("/missed-call", { from: LOCAL });
    await post("/ivr", { callId: body.callId });
    await post("/ivr", { callId: body.callId, digits: "1" });
    let last: any;
    for (let i = 0; i < 5; i++) last = await post("/ivr", { callId: body.callId, digits: "9999" });
    expect(last.body.error).toBe("pin_locked");
    expect((await post("/ivr", { callId: body.callId, digits: "1" })).status).toBe(404);
    expect((await post("/ivr", { callId })).status).toBe(200); // the other call is untouched
  });
});

describe("aggregator recordings go through the media route (S-146)", () => {
  const goodUrl = "https://rec.aggregator.example/r/abc123.wav";
  const finishCall = async (recording: string) => {
    const callId = await toCategory();
    await post("/ivr", { callId, digits: "1" });
    return post("/ivr", { callId, recording });
  };

  it("@E2E-161 host allow-list: https only, no credentials or odd ports, exact or wildcard hosts, no look-alikes", () => {
    expect(allowedRecordingUrl(goodUrl)).toBe(goodUrl);
    expect(allowedRecordingUrl("https://eu.cdn.aggregator.example/x.wav")).toBeTruthy();
    for (const bad of ["http://rec.aggregator.example/a.wav", "https://evil.example/a.wav", "https://rec.aggregator.example.evil.example/a.wav", "https://xrec.aggregator.example/a.wav",
      "https://user:pw@rec.aggregator.example/a.wav", "https://rec.aggregator.example:8443/a.wav", "https://cdn.aggregator.example/a.wav", "https://127.0.0.1/a.wav", "ftp://rec.aggregator.example/a", "not a url"]) {
      expect(allowedRecordingUrl(bad), bad).toBeNull();
    }
  });

  it("@E2E-161 a recording URL is fetched, sniffed, stored encrypted as the caller's voice note and attached to the issue", async () => {
    const seen: { url: string; max: number }[] = [];
    setRecordingFetcher(async (url, max) => { seen.push({ url, max }); return wav(); });
    const done = await finishCall(goodUrl);
    expect(done.body.state).toBe("done");
    expect(seen).toEqual([{ url: goodUrl, max: 3000 }]);
    const issue = getStore("issues").prepare("SELECT voice_ref, photo_ref, reporter_id FROM issue WHERE id=?").get(done.body.referenceId) as any;
    expect(issue.reporter_id).toBe(reporterPseudonym(done.body.referenceId, person.id)); // the issues store holds a pseudonym, never the person id
    expect(issue.photo_ref).toBeNull();
    expect(issue.voice_ref).toMatch(/^media:[0-9a-f]{32}$/);
    const m = getMedia(issue.voice_ref.slice(6))!;
    expect(m).toMatchObject({ kind: "voice", mime: "audio/wav", owner_id: mediaOwnerPseudonym(m.id, person.id), issue_id: done.body.referenceId });
    expect(readMediaFile(m)!.subarray(0, 4).toString()).toBe("RIFF");
    expect(fs.readFileSync(path.join(mediaDir, m.file)).subarray(0, 4).toString()).toBe("PPM1"); // encrypted at rest
  });

  it("@E2E-161 a URL on a host outside the allow-list is refused before any fetch", async () => {
    const f = vi.fn(async () => wav());
    setRecordingFetcher(f);
    const callId = await toCategory();
    await post("/ivr", { callId, digits: "1" });
    const r = await post("/ivr", { callId, recording: "https://evil.example/a.wav" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_recording_host");
    expect(f).not.toHaveBeenCalled();
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue").get()).toMatchObject({ c: 0 });
  });

  it("@E2E-161 content that is not audio is rejected (no issue, SMS points to the app) and the oversize cap holds", async () => {
    setRecordingFetcher(async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 1)])); // a JPEG pretending to be a recording
    const notAudio = await finishCall(goodUrl);
    expect(notAudio.body).toMatchObject({ state: "goodbye", error: "recording_rejected" });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue").get()).toMatchObject({ c: 0 });
    expect(smsOutbox.at(-1)!.text).toMatch(/could not file/i);

    // the default fetcher streams with a hard cap (CIVIC_VOICE_MAX_BYTES = 3000)
    setRecordingFetcher(null);
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) =>
      String(input).startsWith("https://rec.aggregator.example") ? Promise.resolve(new Response(wav(6000))) : real(input, init)) as typeof fetch);
    const tooBig = await finishCall(goodUrl);
    expect(tooBig.body).toMatchObject({ state: "goodbye", error: "recording_rejected" });
    expect(getStore("issues").prepare("SELECT COUNT(*) c FROM issue_media").get()).toMatchObject({ c: 0 });
  });

  it("@E2E-161 the legacy opaque key still works", async () => {
    const done = await finishCall("voice/legacy-1.wav");
    expect(done.body.state).toBe("done");
    expect(getStore("issues").prepare("SELECT photo_ref, voice_ref FROM issue WHERE id=?").get(done.body.referenceId)).toMatchObject({ photo_ref: "voice/legacy-1.wav", voice_ref: null });
  });
});

describe("one lockout with the web sign-in (S-146)", () => {
  it("@E2E-161 IVR PIN checks use identity checkPin: web guesses from rotating sources hit the same per-person ceiling", async () => {
    const p = getPerson(person.id)!;
    for (let i = 0; i < pinCeiling(); i++) expect(await checkPin(p, "0001", new Date(), `web-ip-${i}|device`)).toBe("wrong");
    const { body } = await post("/missed-call", { from: LOCAL });
    await post("/ivr", { callId: body.callId });
    await post("/ivr", { callId: body.callId, digits: "1" });
    const r = await post("/ivr", { callId: body.callId, digits: PIN }); // even the right PIN: the shared ceiling rate-limits new sources
    expect(r.body).toMatchObject({ state: "goodbye", error: "pin_limited" });
  });

  it("@E2E-161 locking the phone source does not lock the owner's other sources (by design); the IVR lock is recorded in the same table", async () => {
    const { body } = await post("/missed-call", { from: LOCAL });
    await post("/ivr", { callId: body.callId });
    await post("/ivr", { callId: body.callId, digits: "1" });
    for (let i = 0; i < 5; i++) await post("/ivr", { callId: body.callId, digits: "9999" });
    const rows = getDb().prepare("SELECT failed, locked_until FROM pin_failures WHERE person_id=?").all(person.id) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].locked_until).toBeTruthy();
    const p = getPerson(person.id)!;
    expect(await checkPin(p, PIN, new Date(), "web-ip|device")).toBe("ok"); // owner on the web is not locked out by a stranger on the phone line
    // a second call from the same number is still locked for its source
    const again = await post("/missed-call", { from: LOCAL });
    await post("/ivr", { callId: again.body.callId });
    await post("/ivr", { callId: again.body.callId, digits: "1" });
    expect((await post("/ivr", { callId: again.body.callId, digits: PIN })).body.error).toBe("pin_locked");
  });
});
