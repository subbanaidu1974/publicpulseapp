import { describe, it, expect } from "vitest";
import { pickSource, kindOf, clock, isSpeed, youtubeIdOf, buildPlaylist, stepEntry } from "../../src/components/media/playerLogic";

describe("free media player logic (S-227)", () => {
  const S = [{ url: "a", label: "720p", height: 720 }, { url: "b", label: "360p", height: 360 }, { url: "c", label: "1080p", height: 1080 }];
  it("@E2E-220 low data picks the smallest picture, otherwise the largest", () => {
    expect(pickSource(S, true)?.url).toBe("b");
    expect(pickSource(S, false)?.url).toBe("c");
    expect(pickSource([], true)).toBeNull();
  });
  it("@E2E-220 does not change the list it is given", () => {
    const copy = [...S]; pickSource(S, true); expect(S).toEqual(copy);
  });
  it("@E2E-220 kindOf reads the type first, then the file name, and refuses anything else", () => {
    expect(kindOf("x.bin", "audio/mpeg")).toBe("audio");
    expect(kindOf("x.bin", "video/mp4")).toBe("video");
    expect(kindOf("Talk.MP3", "")).toBe("audio");
    expect(kindOf("clip.webm", "")).toBe("video");
    expect(kindOf("notes.pdf", "application/pdf")).toBeNull();
    expect(kindOf("script.exe", "")).toBeNull();
    expect(kindOf("noext", "")).toBeNull();
  });
  it("@E2E-220 clock formats minutes and hours, and survives bad numbers", () => {
    expect(clock(0)).toBe("0:00"); expect(clock(65)).toBe("1:05"); expect(clock(3725)).toBe("1:02:05");
    expect(clock(NaN)).toBe("0:00"); expect(clock(-3)).toBe("0:00"); expect(clock(Infinity)).toBe("0:00");
  });
  it("@E2E-220 only the listed speeds are accepted", () => {
    expect(isSpeed(1.25)).toBe(true); expect(isSpeed(3)).toBe(false); expect(isSpeed(0)).toBe(false);
  });
});

describe("YouTube link player logic (S-240)", () => {
  it("@E2E-231 accepts watch, short, embed, live and youtu.be links; refuses everything else", () => {
    const id = "dQw4w9WgXcQ";
    for (const u of [`https://www.youtube.com/watch?v=${id}&t=10`, `https://youtu.be/${id}?si=x`, `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}`, ` https://www.youtube.com/watch?v=${id} `]) expect(youtubeIdOf(u)).toBe(id);
    for (const u of ["http://www.youtube.com/watch?v=" + id, "https://evil.example.net/watch?v=" + id, "https://www.youtube.com/@channel", "https://www.youtube.com/watch?v=short", "javascript:alert(1)", "not a link", ""]) expect(youtubeIdOf(u)).toBeNull();
  });
});

describe("watch playlist logic (S-243)", () => {
  const e = (key: string, kind: "own" | "youtube" = "own") => ({ key, kind, title: key, by: "x", src: key });
  it("@E2E-237 own videos first, a repeated video listed once, stepping wraps and starts at the ends", () => {
    const list = buildPlaylist([e("own:1"), e("own:2")], [e("yt:a", "youtube"), e("yt:a", "youtube"), e("own:1")]);
    expect(list.map((x) => x.key)).toEqual(["own:1", "own:2", "yt:a"]);
    expect(stepEntry(list, null, 1)?.key).toBe("own:1");
    expect(stepEntry(list, null, -1)?.key).toBe("yt:a");
    expect(stepEntry(list, "yt:a", 1)?.key).toBe("own:1");
    expect(stepEntry(list, "own:1", -1)?.key).toBe("yt:a");
    expect(stepEntry([], null, 1)).toBeNull();
  });
});
