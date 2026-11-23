import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../../../server/civic/core";
import { parseRange, sniffAudio } from "../../../server/civic/consultations/staff";
import { admin, call, callRaw, citizen, draft, endWorld, freshWorld, officer, openConsultation, person, startServer, stopServer } from "./helpers";

let dir = "";
beforeAll(startServer);
afterAll(stopServer);
beforeEach(() => { freshWorld(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-audio-")); process.env.CONSULT_AUDIO_DIR = dir; delete process.env.CONSULT_AUDIO_MAX_BYTES; });
afterEach(() => { endWorld(); delete process.env.CONSULT_AUDIO_DIR; delete process.env.CONSULT_AUDIO_MAX_BYTES; fs.rmSync(dir, { recursive: true, force: true }); });

/** A tiny Ogg-looking buffer: enough for the byte sniff. */
const ogg = (n = 4000) => { const b = Buffer.alloc(n, 7); b.write("OggS", 0, "latin1"); return b; };
const withAudio = () => {
  const d = draft();
  (d.clauses[0] as any).audio = [{ group: "farmers", file_id: "aud-001", duration_s: 42, status: "recorded" }];
  return d;
};

describe("consultation list items (S-154)", () => {
  it("@E2E-169 list items carry affected groups and the clause count; state is a server-side filter", async () => {
    const { id } = await openConsultation();
    const tg = await call(officer("Revenue"), "POST", "", draft({ scope: { state: "TG", units: {} } }));
    expect(tg.status).toBe(201);
    const list = await call(null, "GET", "");
    const item = list.body.consultations.find((x: any) => x.id === id);
    expect(item.affected_groups).toEqual(["farmers", "women", "students"]);
    expect(item.clause_count).toBe(2);
    const ap = await call(null, "GET", "?state=AP");
    expect(ap.body.consultations.every((x: any) => x.scope.state === "AP")).toBe(true);
    expect(ap.body.consultations.map((x: any) => x.id)).toContain(id);
    expect((await call(null, "GET", "?state=tg")).body.consultations).toHaveLength(0);
    expect((await call(null, "GET", "?state=ZZ")).body.consultations).toHaveLength(0);
    expect((await call(null, "GET", "?state=not-a-state")).body.code).toBe("state_invalid");
  });
});

describe("reviewed audio (S-154)", () => {
  it("@E2E-169 upload is role-gated and sniffed; playback only after a panel review, with ranges", async () => {
    const { id, creator } = await openConsultation(withAudio() as any);
    const url = `/${id}/audio/upload?clause=1&group=farmers`;
    const play = `/${id}/clauses/1/audio/farmers`;
    expect((await callRaw(citizen(), "POST", url, ogg(), { "content-type": "audio/ogg" })).status).toBe(403);
    expect((await callRaw(null, "POST", url, ogg(), { "content-type": "audio/ogg" })).status).toBe(401);
    expect((await callRaw(creator, "POST", url, Buffer.from("{\"not\":\"audio\"} padding padding"), { "content-type": "audio/ogg" })).json().code).toBe("audio_type_unsupported");
    expect((await callRaw(creator, "POST", url, ogg(), { "content-type": "text/html" })).json().code).toBe("audio_type_unsupported");
    expect((await callRaw(creator, "POST", `/${id}/audio/upload?clause=1&group=women`, ogg(), { "content-type": "audio/ogg" })).json().code).toBe("audio_not_found");
    process.env.CONSULT_AUDIO_MAX_BYTES = "2048";
    expect((await callRaw(creator, "POST", url, ogg(5000), { "content-type": "audio/ogg" })).status).toBe(413);
    delete process.env.CONSULT_AUDIO_MAX_BYTES;
    expect((await callRaw(null, "GET", play)).status).toBe(409);
    const up = await callRaw(creator, "POST", url, ogg(), { "content-type": "audio/ogg" });
    expect(up.status).toBe(201);
    expect(up.json()).toMatchObject({ mime: "audio/ogg", bytes: 4000, reviewed: false, file_id: "aud-001" });
    expect(up.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getStore("survey").prepare("SELECT sha256 FROM consultation_audio_files WHERE consultation_id = ?").get(id)).toMatchObject({ sha256: up.json().sha256 });
    expect(fs.readdirSync(path.join(dir, id))).toHaveLength(1);
    const early = await callRaw(null, "GET", play);
    expect(early.status).toBe(409);
    expect(early.json().code).toBe("audio_not_reviewed");
    expect(early.headers.get("cache-control")).toBe("no-store");
    expect((await call(creator, "POST", `/${id}/audio/review`, { clause: 1, group: "farmers" })).status).toBe(403);
    expect((await call(admin(), "POST", `/${id}/audio/review`, { clause: 1, group: "farmers" })).status).toBe(200);
    const ok = await callRaw(null, "GET", play);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/ogg");
    expect(ok.headers.get("accept-ranges")).toBe("bytes");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.bytes.equals(ogg())).toBe(true);
    const part = await callRaw(null, "GET", play, undefined, { range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/4000");
    expect(part.bytes).toHaveLength(10);
    expect((await callRaw(null, "GET", play, undefined, { range: "bytes=9000-" })).status).toBe(416);
    expect((await callRaw(null, "GET", play, undefined, { range: "bytes=-100" })).bytes).toHaveLength(100);
    expect((await callRaw(null, "GET", play, undefined, { "if-none-match": ok.headers.get("etag")! })).status).toBe(304);
    expect((await callRaw(creator, "POST", url, ogg(), { "content-type": "audio/ogg" })).json().code).toBe("audio_already_reviewed");
    expect((await callRaw(null, "GET", `/${id}/clauses/2/audio/farmers`)).status).toBe(404);
    expect((await callRaw(null, "GET", `/${id}/clauses/1/audio/women`)).status).toBe(404);
  });

  it("@E2E-169 sniffing and range parsing are strict", () => {
    expect(sniffAudio(Buffer.concat([Buffer.from("RIFF1234WAVE"), Buffer.alloc(8)]))?.mime).toBe("audio/wav");
    expect(sniffAudio(Buffer.from("<html><body>x</body></html>"))).toBeNull();
    expect(sniffAudio(Buffer.from("MZ" + "x".repeat(40)))).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual([0, 9]);
    expect(parseRange("bytes=90-", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=0-999", 100)).toEqual([0, 99]);
    expect(parseRange("bytes=100-", 100)).toBe("bad");
    expect(parseRange("bytes=9-3", 100)).toBe("bad");
    expect(parseRange("items=1-2", 100)).toBeNull();
  });
});

describe("staff views (S-154)", () => {
  it("@E2E-169 pending corrections are listed to staff with ids and per-clause diffs", async () => {
    const { id, creator } = await openConsultation();
    const fix = { reason_en: "Corrected the payment period in clause 2", clauses: [{ n: 2, summary_en: "Traders must pay farmers within five days of a sale.", summary_te: "అమ్మకం జరిగిన ఐదు రోజుల్లోగా వ్యాపారులు రైతులకు చెల్లించాలి." }] };
    const corr = await call(creator, "POST", `/${id}/corrections`, fix);
    expect((await call(null, "GET", `/${id}/corrections`)).status).toBe(401);
    expect((await call(citizen(), "GET", `/${id}/corrections`)).status).toBe(403);
    expect((await call(officer("Revenue"), "GET", `/${id}/corrections`)).status).toBe(403);
    for (const who of [creator, admin(), person({ role: "survey_panel" })]) {
      const r = await call(who, "GET", `/${id}/corrections?status=pending`);
      expect(r.status).toBe(200);
      expect(r.body.corrections).toHaveLength(1);
      expect(r.body.corrections[0]).toMatchObject({ id: corr.body.id, status: "pending", from_version: 1, to_version: 2, approvals: 0 });
      expect(r.body.corrections[0].diff).toEqual(expect.arrayContaining([expect.objectContaining({ clause: 2, field: "summary_en", before: expect.stringContaining("seven days"), after: expect.stringContaining("five days") })]));
      expect(r.body.corrections[0].diff.every((d: any) => d.clause === 2)).toBe(true);
    }
    await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    expect((await call(creator, "GET", `/${id}/corrections`)).body.corrections[0]).toMatchObject({ status: "pending", approvals: 1 });
    await call(admin(), "POST", `/${id}/panel/review`, { decision: "approve", correction_id: corr.body.id });
    expect((await call(creator, "GET", `/${id}/corrections?status=pending`)).body.corrections).toHaveLength(0);
    expect((await call(creator, "GET", `/${id}/corrections`)).body.corrections[0]).toMatchObject({ status: "applied" });
  });

  it("@E2E-169 held comments are listed to moderators with feedback ids; release or reject through the moderate route", async () => {
    const { id } = await openConsultation();
    const p = citizen();
    const held = await call(p, "POST", `/${id}/feedback`, { clause: 2, stance: "oppose", comment: "call me on 9876543210 about this", public_ok: true });
    expect(held.body.comment_status).toBe("held");
    await call(citizen(), "POST", `/${id}/feedback`, { clause: 1, stance: "support", comment: "fine as written", public_ok: true });
    expect((await call(null, "GET", `/${id}/comments/held`)).status).toBe(401);
    expect((await call(citizen(), "GET", `/${id}/comments/held`)).status).toBe(403);
    expect((await call(officer("Agriculture"), "GET", `/${id}/comments/held`)).status).toBe(403);
    const mod = person({ role: "moderator" });
    const q = await call(mod, "GET", `/${id}/comments/held`);
    expect(q.status).toBe(200);
    expect(q.body.comments).toHaveLength(1);
    expect(q.body.comments[0]).toMatchObject({ clause: 2, stance: "oppose", feedback_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(Object.keys(q.body.comments[0]).join()).not.toMatch(/person|account|phone/);
    const fid = q.body.comments[0].feedback_id as string;
    expect((await call(mod, "POST", `/${id}/comments/${fid}/moderate`, { decision: "bogus" })).body.code).toBe("decision_invalid");
    expect((await call(mod, "POST", `/${id}/comments/${fid}/moderate`, { decision: "reject" })).status).toBe(200);
    expect((await call(mod, "GET", `/${id}/comments/held`)).body.comments).toHaveLength(0);
    expect((await call(mod, "GET", `/${id}/comments/held?status=rejected`)).body.comments).toHaveLength(1);
    expect(getStore("survey").prepare("SELECT mod_verdict FROM consultation_feedback WHERE id = ?").get(fid)).toMatchObject({ mod_verdict: "hold" });
    await call(p, "POST", `/${id}/feedback`, { clause: 2, stance: "oppose", comment: "also reach me at 9876543210", public_ok: true });
    expect((await call(mod, "GET", `/${id}/comments/held`)).body.comments).toHaveLength(1);
    expect((await call(mod, "POST", `/${id}/comments/${fid}/moderate`, { decision: "release" })).status).toBe(200);
    expect((await call(mod, "GET", `/${id}/comments/held`)).body.comments).toHaveLength(0);
    expect(getStore("survey").prepare("SELECT mod_verdict FROM consultation_feedback WHERE id = ?").get(fid)).toMatchObject({ mod_verdict: "released" });
  });
});
