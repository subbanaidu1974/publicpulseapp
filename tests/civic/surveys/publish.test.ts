/** S-32 (@E2E-41) publishing rules: partition, k, complementary suppression (property-tested), minority merge, gates, wording. */
import { describe, expect, it } from "vitest";
import {
  BANNED_WORDING, DISCLAIMER_EN, accumulate, derivabilityProblems, findBannedWording, mergeMinority, partitionLevels, policyFromEnv, publishDueAt, publishGate,
  publishTree, roundTo, stableStringify, suppressTree, type PublishPolicy, type SizedNode,
} from "../../../server/civic/surveys/publish";
import type { Calendar } from "../../../server/window";

const POLICY: PublishPolicy = { k: 30, minOptionCount: 5, minOptionShare: 0.02, roundTo: 5, delayMs: 24 * 3_600_000, windowHourIst: null };

/** Small deterministic PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Random tree with consistent cumulative counts (parent n = own + sum of children). */
function randomTree(rand: () => number, maxDepth: number, maxKids: number, maxLeaf: number): SizedNode[] {
  const nodes: SizedNode[] = [];
  let seq = 0;
  const make = (parent: string | null, depth: number): number => {
    const id = `n${seq++}`;
    const node: SizedNode = { id, parent, n: 0 };
    nodes.push(node);
    const kids = depth >= maxDepth ? 0 : Math.floor(rand() * (maxKids + 1));
    let n = kids === 0 ? Math.floor(rand() * maxLeaf) : 0;
    for (let i = 0; i < kids; i++) n += make(id, depth + 1);
    node.n = n;
    return n;
  };
  make(null, 0);
  return nodes;
}

const tree = (rows: [string, string | null, number][]): SizedNode[] => rows.map(([id, parent, n]) => ({ id, parent, n }));

describe("partition (S-32 rule 1)", () => {
  it("@E2E-41 uses only the levels from the survey scope down to the chosen finest level", () => {
    expect(partitionLevels("state")).toEqual(["state", "district"]);
    expect(partitionLevels("state", "mandal")).toEqual(["state", "district", "mandal"]);
    expect(partitionLevels("district")).toEqual(["district", "mandal"]);
    expect(partitionLevels("village")).toEqual(["village"]);
    expect(() => partitionLevels("mandal", "district")).toThrow();
  });
});

describe("minimum cell size and complementary suppression (S-32 rules 1-2)", () => {
  it("@E2E-41 a cell below k is hidden and rolled up into its parent", () => {
    const t = tree([["s", null, 200], ["a", "s", 100], ["b", "s", 60], ["c", "s", 25], ["d", "s", 15]]);
    const r = suppressTree(t, 30);
    expect([...r.small].sort()).toEqual(["c", "d"]);
    expect(r.complementary.size).toBe(0); // two hidden cells totalling 40 >= k: not derivable individually
    expect(derivabilityProblems(t, r.hidden, 30)).toEqual([]);
  });

  it("@E2E-41 a single hidden cell is derivable from the parent, so the smallest sibling is also hidden", () => {
    const t = tree([["s", null, 190], ["a", "s", 100], ["b", "s", 70], ["c", "s", 20]]);
    const r = suppressTree(t, 30);
    expect(r.small.has("c")).toBe(true);
    expect(r.complementary.has("b")).toBe(true); // smallest published sibling joins
    expect(r.hidden.has("a")).toBe(false);
    expect(derivabilityProblems(t, r.hidden, 30)).toEqual([]);
  });

  it("@E2E-41 hidden cells totalling under k are padded with the smallest published sibling until the total reaches k", () => {
    const t = tree([["s", null, 285], ["a", "s", 200], ["b", "s", 60], ["c", "s", 20], ["d", "s", 5]]);
    const r = suppressTree(t, 30);
    expect([...r.small].sort()).toEqual(["c", "d"]); // 25 < 30: the pair is still too small an aggregate
    expect([...r.complementary]).toEqual(["b"]);
    expect(derivabilityProblems(t, r.hidden, 30)).toEqual([]);
  });

  it("@E2E-41 a hidden cell hides its whole subtree; a root below k hides everything", () => {
    const t = tree([["s", null, 200], ["a", "s", 100], ["b", "s", 70], ["c", "s", 20], ["b1", "b", 40], ["b2", "b", 30]]);
    const r = suppressTree(t, 30);
    expect(r.hidden.has("b")).toBe(true);
    expect(r.hidden.has("b1") && r.hidden.has("b2")).toBe(true);
    expect(suppressTree(tree([["s", null, 10], ["a", "s", 10]]), 30).rootPublishable).toBe(false);
  });

  it("@E2E-41 property: on 3000 random trees no hidden cell is derivable and every published cell has n >= k", () => {
    const rand = rng(41);
    let hiddenSeen = 0;
    for (let i = 0; i < 3000; i++) {
      const k = 2 + Math.floor(rand() * 40);
      const nodes = randomTree(rand, 3, 5, 80);
      const r = suppressTree(nodes, k);
      hiddenSeen += r.hidden.size;
      expect(derivabilityProblems(nodes, r.hidden, k), `case ${i} k=${k} ${JSON.stringify(nodes)}`).toEqual([]);
    }
    expect(hiddenSeen).toBeGreaterThan(1000); // the property was exercised, not vacuous
  });

  it("@E2E-41 property: the only thing an attacker can derive from published totals is a sum over at least two cells totalling at least k", () => {
    const rand = rng(7);
    for (let i = 0; i < 1500; i++) {
      const k = 5 + Math.floor(rand() * 30);
      const nodes = randomTree(rand, 2, 6, 60);
      const r = suppressTree(nodes, k);
      const kids = new Map<string, SizedNode[]>();
      for (const x of nodes) if (x.parent) (kids.get(x.parent) ?? kids.set(x.parent, []).get(x.parent)!).push(x);
      for (const x of nodes) {
        if (r.hidden.has(x.id)) continue;
        const hid = (kids.get(x.id) ?? []).filter((c) => r.hidden.has(c.id));
        if (hid.length) { expect(hid.length).toBeGreaterThanOrEqual(2); expect(hid.reduce((s, c) => s + c.n, 0)).toBeGreaterThanOrEqual(k); }
      }
    }
  });
});

describe("minority option rule and rounding (S-32 rule 3)", () => {
  it("@E2E-41 options below the minimum go to 'other'; a lone small option never sits alone in 'other'", () => {
    const order = ["a", "b", "c", "d"];
    const m = mergeMinority({ a: 60, b: 30, c: 7, d: 3 }, order, 100, POLICY);
    expect(m.merged.sort()).toEqual(["c", "d"]); // d alone is below the minimum, so the next smallest (c) joins it
    expect(m.kept).toEqual(["a", "b"]);
    const z = mergeMinority({ a: 60, b: 40, c: 0, d: 0 }, order, 100, POLICY);
    expect(z.kept).toEqual(["a", "b"]);
    expect(z.merged.sort()).toEqual(["c", "d"]);
  });

  it("@E2E-41 published cells list rounded counts, an 'other' bucket, and never an option under the minimum", () => {
    const recs = [] as Parameters<typeof accumulate>[0];
    const add = (opt: string, n: number) => { for (let i = 0; i < n; i++) recs.push({ path: [{ id: "root", level: "state" }], options: [opt], w: 1 }); };
    add("a", 60); add("b", 33); add("c", 3); add("d", 1);
    const t = publishTree(accumulate(recs), ["a", "b", "c", "d"], POLICY);
    expect(t.published).toBe(true);
    const c = t.cells[0];
    expect(c.n).toBe(roundTo(97, 5));
    expect(c.unweighted.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(c.unweighted.other?.count).toBe(roundTo(4, 5));
    for (const o of c.unweighted.options) expect(o.count % 5).toBe(0);
    expect(c.weighted.options.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("@E2E-41 hidden children are only counted, never named, and rolled up into the parent total", () => {
    const recs = [] as Parameters<typeof accumulate>[0];
    const add = (leaf: string, n: number) => { for (let i = 0; i < n; i++) recs.push({ path: [{ id: "s", level: "state" }, { id: leaf, level: "district" }], options: ["a"], w: 1 }); };
    add("big", 80); add("tiny1", 20); add("tiny2", 15);
    const t = publishTree(accumulate(recs), ["a"], POLICY);
    expect(t.cells.map((c) => c.id)).toEqual(["s", "s/big"]);
    expect(t.cells[0].hidden_children).toBe(2);
    expect(t.cells[0].n).toBe(roundTo(115, 5));
    expect(JSON.stringify(t)).not.toContain("tiny");
  });
});

describe("no live counts and election windows (S-32 rules 4 and 7)", () => {
  const closeAt = "2026-06-01T10:00:00Z";
  const cal = (): Calendar => ({ schema: 1, coveredFrom: "2026-01-01", coveredThrough: "2027-01-01", entries: [{ state: "AP", mccStart: "2026-06-01", end: "2026-08-01", source: "x", verified: true }] });
  const base = { status: "closed", closeAt, state: "AP", topic: "issue_service" };

  it("@E2E-41 nothing before close; nothing before close + delay; then open", () => {
    expect(publishGate({ ...base, status: "open", now: new Date("2026-06-01T09:00:00Z") }, { policy: POLICY })).toEqual({ ok: false, reason: "not_closed" });
    expect(publishGate({ ...base, now: new Date("2026-06-02T09:59:00Z") }, { policy: POLICY })).toMatchObject({ ok: false, reason: "too_early" });
    expect(publishGate({ ...base, now: new Date("2026-06-02T10:00:00Z") }, { policy: POLICY })).toEqual({ ok: true });
    expect(publishGate({ ...base, status: "cancelled", now: new Date("2027-01-01T00:00:00Z") }, { policy: POLICY })).toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("@E2E-41 the delay, k and fixed daily window come from env", () => {
    expect(policyFromEnv({ SURVEY_PUBLISH_DELAY_HOURS: "6", SURVEY_MIN_CELL: "50", SURVEY_PUBLISH_WINDOW_HOUR_IST: "10" } as NodeJS.ProcessEnv)).toMatchObject({ delayMs: 6 * 3_600_000, k: 50, windowHourIst: 10 });
    expect(policyFromEnv({} as NodeJS.ProcessEnv)).toMatchObject({ delayMs: 24 * 3_600_000, k: 30, windowHourIst: null });
    // close 10:00Z; +24h = 2026-06-02 10:00Z = 15:30 IST; window 10:00 IST -> next day 04:30Z
    const due = publishDueAt(Date.parse(closeAt), { delayMs: 24 * 3_600_000, windowHourIst: 10 });
    expect(new Date(due).toISOString()).toBe("2026-06-03T04:30:00.000Z");
  });

  it("@E2E-41 political topics are blocked in blackout and unknown windows, allowed only when open (fail closed)", () => {
    const pol = { ...base, topic: "election_choice", now: new Date("2026-09-01T00:00:00Z") };
    expect(publishGate(pol, { policy: POLICY, calendar: cal() })).toEqual({ ok: true }); // the MCC window ended 2026-08-01
    const during = { ...pol, now: new Date("2026-06-20T00:00:00Z"), closeAt: "2026-06-10T00:00:00Z" };
    expect(publishGate(during, { policy: POLICY, calendar: cal() })).toMatchObject({ ok: false, reason: "election_window" });
    expect(publishGate(pol, { policy: POLICY, calendar: null })).toMatchObject({ ok: false, reason: "election_window" });
    expect(publishGate({ ...pol, now: new Date("2028-01-01T00:00:00Z") }, { policy: POLICY, calendar: cal() })).toMatchObject({ ok: false, reason: "election_window" });
    expect(publishGate({ ...during, topic: "political" }, { policy: POLICY, calendar: cal() })).toMatchObject({ ok: false, reason: "election_window" });
    // an issue survey is not affected by the window
    expect(publishGate({ ...base, now: new Date("2026-06-20T00:00:00Z"), closeAt: "2026-06-10T00:00:00Z" }, { policy: POLICY, calendar: null })).toEqual({ ok: true });
  });
});

describe("wording (S-32 rule 7)", () => {
  it("@E2E-41 the disclaimer says not an election and not a forecast; the banned words are detected", () => {
    expect(DISCLAIMER_EN).toBe("Opinion survey, not an election and not a forecast.");
    expect(BANNED_WORDING.test("the vote total")).toBe(true);
    expect(findBannedWording({ a: "figures", b: { text_en: "Who won the vote?", c: "ballot box" } })).toHaveLength(1);
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
