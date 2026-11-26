import { describe, it, expect } from "vitest";
import { pickSource, kindOf, clock, isSpeed } from "../../src/components/media/playerLogic";

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
