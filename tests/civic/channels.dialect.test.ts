import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../server/civic/core";
import { createChannelsRouter, type ChannelDeps } from "../../server/civic/channels/routes";
import { normalizeDialect, recordingMatrix, resolveAudio, setAudioManifestForTests, type AudioManifestLike } from "../../server/civic/channels/dialect";
import { missingReport } from "../../scripts/audio-missing";

const MAN: AudioManifestLike = { prompts: [
  { id: "welcome", file: "audio/te/welcome.wav", status: "placeholder", recordings: { coastal: { file: "audio/te/coastal/welcome.wav", status: "reviewed" }, telangana: { file: "audio/te/telangana/welcome.wav", status: "recorded" } } },
  { id: "goodbye", file: "audio/te/goodbye.wav", status: "reviewed" },
] };

describe("IVR dialect resolution (S-151, E2E-166)", () => {
  it("@E2E-166 reviewed dialect asset wins; unreviewed or missing falls back to standard; unrecorded standard is a TTS candidate", () => {
    expect(resolveAudio("welcome", "coastal", MAN)).toMatchObject({ audioKey: "audio/te/coastal/welcome.wav", dialect: "coastal", fallback: "none" });
    expect(resolveAudio("welcome", "telangana", MAN)).toMatchObject({ audioKey: "audio/te/welcome.wav", dialect: "standard", fallback: "standard", tts: true }); // recorded but not reviewed
    expect(resolveAudio("welcome", "rayalaseema", MAN)).toMatchObject({ fallback: "standard" });
    expect(resolveAudio("goodbye", "coastal", MAN)).toMatchObject({ audioKey: "audio/te/goodbye.wav", fallback: "standard", tts: false });
    expect(resolveAudio("nope", "standard", MAN)).toMatchObject({ audioKey: "audio/te/nope.wav", tts: true });
    expect(resolveAudio("welcome", "standard", null).fallback).toBe("none");
  });
  it("normalizes dialect names", () => {
    expect(normalizeDialect(" Coastal ")).toBe("coastal");
    expect(normalizeDialect("klingon")).toBeNull();
  });
  it("@E2E-166 the matrix and the real-repo report list missing recordings per prompt and dialect", () => {
    const rows = recordingMatrix(MAN);
    expect(rows.find((r) => r.id === "welcome" && r.dialect === "coastal")?.status).toBe("reviewed");
    expect(rows.find((r) => r.id === "welcome" && r.dialect === "telangana")?.status).toBe("recorded");
    expect(rows.find((r) => r.id === "welcome" && r.dialect === "rayalaseema")?.status).toBe("missing");
    const rep = missingReport(process.cwd());
    expect(rep.total).toBe(16 * 4); // 17 prompts minus the dynamic survey_q, times four dialects
    expect(rep.text).toContain("welcome:");
    expect(rep.text).not.toContain("survey_q:");
  });
});

describe("IVR dialect in the call flow", () => {
  let srv: Server, url = "";
  const deps: ChannelDeps = { now: () => Date.now(), sendSms: async () => undefined, createIssue: async () => ({ id: "ISS-1" }) };
  const post = async (p: string, body: unknown) => { const r = await fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
  beforeEach(async () => {
    resetDbForTests(); migrate(); setAudioManifestForTests(MAN);
    const app = express(); app.use("/c", createChannelsRouter(deps));
    srv = app.listen(0, "127.0.0.1"); await new Promise((r) => srv.once("listening", r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/c`;
  });
  afterEach(() => { srv.close(); setAudioManifestForTests(undefined); delete process.env.CIVIC_IVR_DEFAULT_DIALECT; delete process.env.CIVIC_IVR_TTS_FALLBACK; });

  it("@E2E-166 dialect given at missed call is remembered across turns and selects the audio key", async () => {
    const { body } = await post("/missed-call", { from: "9876544001", dialect: "coastal" });
    const r = await post("/ivr", { callId: body.callId });
    expect(r.body.prompts[0]).toMatchObject({ id: "welcome", audioKey: "audio/te/coastal/welcome.wav", dialect: "coastal" });
    expect(r.body.xml).toContain('src="audio/te/coastal/welcome.wav"');
    const bad = await post("/ivr", { callId: body.callId, digits: "7" }); // invalid choice replays welcome in the same dialect
    expect(bad.body.prompts.every((p: any) => p.id !== "invalid" || p.dialect === "standard")).toBe(true);
    expect(bad.body.prompts.find((p: any) => p.id === "welcome").audioKey).toBe("audio/te/coastal/welcome.wav");
  });
  it("@E2E-166 unknown dialect is refused; default comes from env; a turn may change it; unrecorded dialect falls back to the standard key", async () => {
    expect((await post("/missed-call", { from: "9876544002", dialect: "pirate" })).status).toBe(400);
    process.env.CIVIC_IVR_DEFAULT_DIALECT = "rayalaseema";
    const { body } = await post("/missed-call", { from: "9876544003" });
    const a = await post("/ivr", { callId: body.callId });
    expect(a.body.prompts[0]).toMatchObject({ audioKey: "audio/te/welcome.wav", fallback: "standard", dialect: "standard" });
    const b = await post("/ivr", { callId: body.callId, dialect: "coastal" });
    expect(b.body.prompts[0].audioKey).toBe("audio/te/coastal/welcome.wav");
    expect((await post("/ivr", { callId: body.callId, dialect: "nope" })).status).toBe(400);
  });
  it("@E2E-166 TTS fallback is opt-in and escapes text", async () => {
    const { body } = await post("/missed-call", { from: "9876544004" });
    expect((await post("/ivr", { callId: body.callId })).body.xml).toContain("<Play");
    process.env.CIVIC_IVR_TTS_FALLBACK = "1";
    const x = (await post("/ivr", { callId: body.callId })).body.xml as string;
    expect(x).toContain('<Say language="te-IN"');
  });
});
