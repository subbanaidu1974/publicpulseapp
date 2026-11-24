import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 'retired' = superseded or withdrawn; kept for history and excluded from the completion percentage. */
export type Status = 'todo' | 'in_progress' | 'done' | 'blocked' | 'retired';
export interface Story {
  id: string;
  epic: string;
  title: string;
  agent: string;
  status: Status;
  tests: string[];
  priority?: string;
  wave?: string;
  source?: string;
}
export interface Tracker {
  stories: Story[];
}

const STATUSES: Status[] = ['done', 'in_progress', 'todo', 'blocked', 'retired'];
const TAG_RE = /@?\b((?:E2E|UT)-[A-Za-z0-9-]+)/g;
const SPEC_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'playwright-report', 'test-results', '.git']);

export type Runner = 'playwright' | 'vitest';

/** Which runner owns a file: anything under an `e2e` directory is Playwright, everything else is Vitest. */
const runnerOf = (p: string): Runner => (p.split(path.sep).includes('e2e') ? 'playwright' : 'vitest');

/** Collect every `@E2E-xx` / `@UT-xx` tag (without the @) found in spec/test files under the given roots. */
export function findTags(roots: string[]): Set<string> {
  return new Set(findTagSources(roots).keys());
}

/** Like findTags, but also records which runner(s) the tag's files belong to (S-71). */
export function findTagSources(roots: string[]): Map<string, Set<Runner>> {
  const tags = new Map<string, Set<Runner>>();
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    } else if (SPEC_EXT.test(p)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(TAG_RE)) {
        const set = tags.get(m[1]) ?? new Set<Runner>();
        set.add(runnerOf(p));
        tags.set(m[1], set);
      }
    }
  };
  roots.forEach(walk);
  return tags;
}

export interface Row extends Story {
  missing: string[];
  found: boolean;
}

export function evaluate(tracker: Tracker, tags: Set<string>): Row[] {
  return tracker.stories.map((s) => {
    const missing = s.tests.filter((t) => !tags.has(t));
    return { ...s, missing, found: missing.length === 0 };
  });
}

/** Stories marked done whose referenced tags are not present in any spec. */
export function violations(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === 'done' && !r.found);
}

export type Outcome = 'passed' | 'failed' | 'skipped';
export interface Report { runner: Runner; results: { title: string; status: Outcome }[] }

/** Parse a Playwright (`--reporter=json`) or Vitest (`--reporter=json`) report. Throws on an unrecognised shape. */
export function parseReport(json: unknown): Report {
  const j = json as { suites?: unknown[]; testResults?: unknown[] };
  if (Array.isArray(j?.testResults)) {
    const results: Report['results'] = [];
    for (const f of j.testResults as { assertionResults?: { fullName?: string; title?: string; status?: string }[] }[]) {
      for (const a of f.assertionResults ?? []) {
        const status: Outcome = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'; // pending/todo/skipped
        results.push({ title: a.fullName ?? a.title ?? '', status });
      }
    }
    return { runner: 'vitest', results };
  }
  if (Array.isArray(j?.suites)) {
    const results: Report['results'] = [];
    type PSuite = { title?: string; suites?: PSuite[]; specs?: { title: string; tests?: { status?: string; results?: { status?: string }[] }[] }[] };
    const walk = (s: PSuite, trail: string[]) => {
      const t = s.title ? [...trail, s.title] : trail;
      for (const spec of s.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const rs = test.results ?? [];
          const allSkipped = rs.length === 0 || rs.every((r) => r.status === 'skipped');
          const status: Outcome =
            test.status === 'skipped' || allSkipped ? 'skipped' : test.status === 'expected' || test.status === 'flaky' ? 'passed' : 'failed';
          results.push({ title: [...t, spec.title].join(' '), status });
        }
      }
      for (const c of s.suites ?? []) walk(c, t);
    };
    for (const s of j.suites as PSuite[]) walk(s, []);
    return { runner: 'playwright', results };
  }
  throw new Error('unrecognised test report (expected Playwright or Vitest JSON)');
}

const tagInTitle = (title: string, tag: string) => new RegExp(`(^|[^A-Za-z0-9-])@?${tag}(?![A-Za-z0-9-])`).test(title);

/**
 * For every 'done' story: each tagged test must have actually run in the provided report(s) and passed, with no skip.
 * A tag is judged against a report only when the tag's files belong to that report's runner (e2e/ = Playwright, tests/ = Vitest),
 * so passing only vitest.json does not demand Playwright results.
 */
export function reportViolations(rows: Row[], sources: Map<string, Set<Runner>>, reports: Report[]): string[] {
  const msgs: string[] = [];
  const provided = new Set(reports.map((r) => r.runner));
  for (const r of rows) {
    if (r.status !== 'done') continue;
    for (const tag of r.tests) {
      const owners = sources.get(tag);
      if (!owners) continue; // already reported as missing
      for (const runner of owners) {
        if (!provided.has(runner)) continue;
        const hits = reports.filter((x) => x.runner === runner).flatMap((x) => x.results.filter((t) => tagInTitle(t.title, tag)));
        if (hits.length === 0) msgs.push(`${r.id} is 'done' but ${tag} did not run in the ${runner} report`);
        else if (hits.some((h) => h.status === 'failed')) msgs.push(`${r.id} is 'done' but a ${tag} test failed in the ${runner} report`);
        else if (hits.some((h) => h.status === 'skipped')) msgs.push(`${r.id} is 'done' but a ${tag} test was skipped in the ${runner} report`);
      }
    }
  }
  return msgs;
}

/** Progress by epic and by wave/priority (only when stories carry those fields). */
function breakdown(rows: Row[]): string[] {
  const out: string[] = [];
  const group = (key: (r: Row) => string | undefined, label: string) => {
    const m = new Map<string, Record<Status, number>>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      const c = m.get(k) ?? { done: 0, in_progress: 0, todo: 0, blocked: 0, retired: 0 };
      c[r.status]++;
      m.set(k, c);
    }
    if (!m.size) return;
    out.push(`| ${label} | Done | In progress | Todo | Blocked | Retired | Total (active) |`, "|---|---|---|---|---|---|---|");
    for (const [k, c] of [...m].sort()) out.push(`| ${k} | ${c.done} | ${c.in_progress} | ${c.todo} | ${c.blocked} | ${c.retired} | ${c.done + c.in_progress + c.todo + c.blocked} |`);
    out.push("");
  };
  group((r) => r.wave, "Wave");
  group((r) => r.priority, "Priority");
  group((r) => r.epic, "Epic");
  return out;
}

export function render(rows: Row[]): string {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  rows.forEach((r) => (counts[r.status] = (counts[r.status] ?? 0) + 1));
  const total = rows.length - counts.retired;
  const pct = total === 0 ? 0 : Math.round((counts.done / total) * 100);
  const lines: string[] = [
    '# Story Tracker',
    '',
    '<!-- Generated by scripts/gen-tracker.ts from docs/stories/tracker.json. Do not edit by hand. -->',
    '',
    `**${pct}% complete** (${counts.done}/${total} stories done)`,
    '',
    '| Status | Count |',
    '|---|---|',
    ...STATUSES.map((s) => `| ${s} | ${counts[s]} |`),
    '',
    ...breakdown(rows),
    '| Story | Epic | Title | Agent | Status | Tests | Tests found? |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.epic} | ${r.title} | ${r.agent} | ${r.status} | ${r.tests.join(', ')} | ${
          r.found ? 'yes' : `no (missing: ${r.missing.join(', ')})`
        } |`,
    ),
    '',
  ];
  return lines.join('\n');
}

const norm = (t: string) => t.split('\r\n').join('\n');

export function run(opts: { root: string; check: boolean; write?: boolean; reports?: string[] }): { code: number; output: string; messages: string[] } {
  const tracker = JSON.parse(fs.readFileSync(path.join(opts.root, 'docs/stories/tracker.json'), 'utf8')) as Tracker;
  const sources = findTagSources([path.join(opts.root, 'e2e'), path.join(opts.root, 'tests')]);
  const rows = evaluate(tracker, new Set(sources.keys()));
  const output = render(rows);
  const mdPath = path.join(opts.root, 'docs/STORY_TRACKER.md');
  const existing = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
  if (opts.write !== false) fs.writeFileSync(mdPath, output);
  const messages: string[] = [];
  let code = 0;
  if (opts.check) {
    for (const v of violations(rows)) {
      messages.push(`${v.id} is 'done' but no spec contains: ${v.missing.join(', ')}`);
      code = 1;
    }
    if (opts.reports?.length) {
      const reports = opts.reports.map((p) => parseReport(JSON.parse(fs.readFileSync(path.resolve(opts.root, p), 'utf8'))));
      for (const m of reportViolations(rows, sources, reports)) { messages.push(m); code = 1; }
    }
    // S-71: the committed markdown must equal a fresh render (a missing file is simply created)
    if (existing !== null && norm(existing) !== norm(output)) {
      messages.push('docs/STORY_TRACKER.md is stale: it was regenerated just now, commit the result (npm run tracker)');
      code = 1;
    }
  }
  return { code, output, messages };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const reports: string[] = [];
  process.argv.forEach((a, i) => { if (a === '--report' && process.argv[i + 1]) reports.push(process.argv[i + 1]); });
  const { code, messages } = run({ root, check: process.argv.includes('--check'), reports });
  messages.forEach((m) => console.error(`tracker: ${m}`));
  console.log(code === 0 ? 'tracker: docs/STORY_TRACKER.md regenerated' : 'tracker: FAILED');
  process.exit(code);
}
