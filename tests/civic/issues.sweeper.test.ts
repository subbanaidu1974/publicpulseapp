import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, grantRole as grantCoreRole, migrate, resetDbForTests, getStore } from "../../server/civic/core";
import { createPerson } from "../../server/civic/identity/service";
import { loadDemoGeo } from "../../server/civic/geo/service";
import { createCivicRouter } from "../../server/civic/index";
import {
  clock, escalationChain, grantRole, moderate, isIssueSweeperRunning, reportIssue, startIssueSweeper, stopIssueSweeper, sweep, transition,
} from "../../server/civic/issues/service";

const T0 = new Date("2026-03-01T10:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
const ENV = { NODE_ENV: process.env.NODE_ENV, CIVIC_SWEEP: process.env.CIVIC_SWEEP };

beforeEach(() => { resetDbForTests(); migrate(); loadDemoGeo(); clock.now = () => T0; });
afterEach(() => {
  stopIssueSweeper(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const [k, v] of Object.entries(ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  clock.now = () => new Date();
});

describe("scheduled sweep (S-25)", () => {
  it("is disabled under NODE_ENV=test and with CIVIC_SWEEP=0", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(startIssueSweeper(1000)).toBe(false);
    expect(isIssueSweeperRunning()).toBe(false);
    process.env.NODE_ENV = "development"; process.env.CIVIC_SWEEP = "0";
    expect(startIssueSweeper(1000)).toBe(false);
    expect(isIssueSweeperRunning()).toBe(false);
  });

  it("starts once (idempotent), runs sweep on the interval, survives errors, and stops", () => {
    process.env.NODE_ENV = "development"; delete process.env.CIVIC_SWEEP;
    vi.useFakeTimers();
    const id = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply" }, T0).id;
    expect(startIssueSweeper(60_000)).toBe(true);
    expect(startIssueSweeper(60_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    clock.now = () => at(10);
    vi.advanceTimersByTime(60_000);
    expect((getStore("issues").prepare("SELECT esc_level l FROM issue WHERE id=?").get(id) as any).l).toBe(0);
    clock.now = () => at(80); // past the 72 h SLA
    vi.advanceTimersByTime(60_000);
    expect((getStore("issues").prepare("SELECT esc_level l FROM issue WHERE id=?").get(id) as any).l).toBe(1);
    // a failing sweep is logged, not thrown, and the timer keeps running
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    clock.now = () => { throw new Error("boom"); };
    vi.advanceTimersByTime(60_000);
    expect(err).toHaveBeenCalled();
    expect(isIssueSweeperRunning()).toBe(true);
    stopIssueSweeper();
    expect(vi.getTimerCount()).toBe(0);
    expect(isIssueSweeperRunning()).toBe(false);
  });

  it("the timer is unref'd so it never keeps the process alive", () => {
    process.env.NODE_ENV = "development"; delete process.env.CIVIC_SWEEP;
    const unref = vi.fn();
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref, ref: vi.fn() } as any);
    expect(startIssueSweeper(60_000)).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("createCivicRouter starts the sweeper (outside test mode)", () => {
    process.env.NODE_ENV = "development"; delete process.env.CIVIC_SWEEP;
    vi.useFakeTimers();
    createCivicRouter();
    expect(isIssueSweeperRunning()).toBe(true);
  });
});

describe("escalation includes the constituency liaison (S-25)", () => {
  it("chain is village, mandal, district, constituency, state", () => {
    expect(escalationChain("DEMO-V-KLR").map((u) => u.level)).toEqual(["village", "mandal", "district", "constituency", "state"]);
    expect(escalationChain("DEMO-V-KLR").find((u) => u.level === "constituency")!.lgd).toBe("DEMO-C-TNL");
    // split village: the lowest LGD code is the liaison
    expect(escalationChain("DEMO-V-BPL").find((u) => u.level === "constituency")!.lgd).toBe("DEMO-C-PTR");
    // effective dating: Angalakuduru moved from Tenali to Ponnur on 2026-01-01
    expect(escalationChain("DEMO-V-ANM", new Date("2025-06-01")).find((u) => u.level === "constituency")!.lgd).toBe("DEMO-C-TNL");
    expect(escalationChain("DEMO-V-ANM", new Date("2026-06-01")).find((u) => u.level === "constituency")!.lgd).toBe("DEMO-C-PTR");
    // no constituency link: the step is skipped
    getStore("issues").prepare("DELETE FROM village_constituency WHERE village_lgd='DEMO-V-HNK'").run();
    expect(escalationChain("DEMO-V-HNK").map((u) => u.level)).toEqual(["village", "mandal", "district", "state"]);
  });

  it("escalates village -> mandal -> district -> constituency -> state, audited, re-arming at the top", () => {
    const id = reportIssue("rep", { category: "electricity", village_lgd: "DEMO-V-KLR", description_en: "Transformer burnt out" }, T0).id; // 48 h SLA
    const lvl = () => getStore("issues").prepare("SELECT jurisdiction_lgd j, esc_level l FROM issue WHERE id=?").get(id) as any;
    const steps = [[49, "DEMO-M-KLP", 1], [98, "DEMO-D-GNT", 2], [147, "DEMO-C-TNL", 3], [196, "DEMO-S-AP", 4], [245, "DEMO-S-AP", 4]] as const;
    for (const [h, j, l] of steps) { sweep(at(h)); expect(lvl()).toMatchObject({ j, l }); }
    const rows = getStore("audit").prepare("SELECT meta FROM audit_log WHERE action='issue.escalate' ORDER BY seq").all() as any[];
    expect(rows.map((r) => JSON.parse(r.meta).to_level)).toEqual(["mandal", "district", "constituency", "state"]);
  });

  it("a constituency-scoped officer covers villages in that constituency only", () => {
    grantRole("liaison", "officer", "Rural Water Supply", "DEMO-C-TNL", "Tenali liaison");
    const kl = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply" }, T0).id;
    const wg = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-HNK", description_en: "No drinking water supply" }, T0).id;
    expect(transition(kl, "liaison", { to: "Verified" }, T0)).toMatchObject({ status: "Verified" });
    expect(() => transition(wg, "liaison", { to: "Verified" }, T0)).toThrow(/jurisdiction/);
  });
});

describe("core roles are honoured alongside the local officer table", () => {
  it("a core-granted constituency officer and moderator work without a local claim", () => {
    const off = createPerson({ phone: "+919876500201", pin: "4821", consentVersion: "v1" }).id;
    const mod = createPerson({ phone: "+919876500202", pin: "4821", consentVersion: "v1" }).id;
    grantCoreRole("system", off, "officer", "DEMO-C-TNL");
    grantCoreRole("system", mod, "moderator");
    const kl = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "No drinking water supply" }, T0).id;
    const wg = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-HNK", description_en: "No drinking water supply" }, T0).id;
    expect(transition(kl, off, { to: "Verified" }, T0)).toMatchObject({ status: "Verified" });
    expect(() => transition(wg, off, { to: "Verified" }, T0)).toThrow(/jurisdiction/);
    const held = reportIssue("rep", { category: "water", village_lgd: "DEMO-V-KLR", description_en: "Ramesh garu is rude" }, T0).id;
    expect(moderate(held, mod, "release", T0)).toMatchObject({ decision: "release" });
    expect(() => moderate(held, off, "takedown", T0)).toThrow(/moderator/);
  });
});
