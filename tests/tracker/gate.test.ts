import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReport, reportViolations, findTagSources, evaluate, run } from '../../scripts/gen-tracker';

const pw = (specs: { title: string; status: string; results?: string[] }[]) => ({
  suites: [{ title: 'a.spec.ts', specs: specs.map((s) => ({ title: s.title, tests: [{ status: s.status, results: (s.results ?? [s.status === 'skipped' ? 'skipped' : 'passed']).map((x) => ({ status: x })) }] })) }],
});
const vt = (rows: { fullName: string; status: string }[]) => ({ testResults: [{ assertionResults: rows }] });

describe('UT-tracker-gate report parsing and checks', () => {
  let root: string;
  const write = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const story = (tests: string[], status = 'done') => ({ id: 'S-1', epic: 'e', title: 't', agent: 'A', status, tests });

  it('@E2E-86 parses Playwright and Vitest JSON and rejects anything else', () => {
    expect(parseReport(pw([{ title: '@E2E-01 x', status: 'expected' }])).results).toEqual([{ title: 'a.spec.ts @E2E-01 x', status: 'passed' }]);
    expect(parseReport(pw([{ title: '@E2E-01 x', status: 'skipped' }])).results[0].status).toBe('skipped');
    expect(parseReport(pw([{ title: '@E2E-01 x', status: 'unexpected', results: ['failed'] }])).results[0].status).toBe('failed');
    expect(parseReport(vt([{ fullName: 'UT-x does it', status: 'todo' }])).results[0].status).toBe('skipped');
    expect(() => parseReport({ nope: 1 })).toThrow(/unrecognised/);
  });

  it('@E2E-86 a done story needs its tagged tests to have run and passed, with no skip', () => {
    write('e2e/a.spec.ts', "test('@E2E-01 x', () => {})");
    write('tests/b.test.ts', "describe('@UT-b', () => { it('y', () => {}) })");
    const sources = findTagSources([path.join(root, 'e2e'), path.join(root, 'tests')]);
    const rows = evaluate({ stories: [story(['E2E-01', 'UT-b']) as never] }, new Set(sources.keys()));
    const good = [parseReport(pw([{ title: '@E2E-01 x', status: 'expected' }])), parseReport(vt([{ fullName: '@UT-b y', status: 'passed' }]))];
    expect(reportViolations(rows, sources, good)).toEqual([]);
    const skipped = [parseReport(pw([{ title: '@E2E-01 x', status: 'skipped' }])), good[1]];
    expect(reportViolations(rows, sources, skipped)[0]).toContain('skipped');
    const failed = [good[0], parseReport(vt([{ fullName: '@UT-b y', status: 'failed' }]))];
    expect(reportViolations(rows, sources, failed)[0]).toContain('failed');
    const absent = [parseReport(pw([{ title: '@E2E-02 other', status: 'expected' }])), good[1]];
    expect(reportViolations(rows, sources, absent)[0]).toContain('did not run');
  });

  it('@E2E-86 only judges a tag against the runner that owns its files, and ignores non-done stories', () => {
    write('e2e/a.spec.ts', "test('@E2E-01 x', () => {})");
    const sources = findTagSources([path.join(root, 'e2e')]);
    const rows = evaluate({ stories: [story(['E2E-01']) as never] }, new Set(sources.keys()));
    expect(reportViolations(rows, sources, [parseReport(vt([]))])).toEqual([]); // only vitest.json provided
    const todo = evaluate({ stories: [story(['E2E-01'], 'todo') as never] }, new Set(sources.keys()));
    expect(reportViolations(todo, sources, [parseReport(pw([]))])).toEqual([]);
  });

  it('@E2E-86 tag matching is exact: E2E-8 does not match E2E-82', () => {
    write('tests/b.test.ts', "describe('@E2E-8', () => {})");
    const sources = findTagSources([path.join(root, 'tests')]);
    const rows = evaluate({ stories: [story(['E2E-8']) as never] }, new Set(sources.keys()));
    expect(reportViolations(rows, sources, [parseReport(vt([{ fullName: '@E2E-82 something', status: 'passed' }]))])[0]).toContain('did not run');
  });

  it('@E2E-86 run --check --report fails on a skipped tagged test and passes when it ran', () => {
    write('e2e/a.spec.ts', "test('@E2E-01 x', () => {})");
    write('docs/stories/tracker.json', JSON.stringify({ stories: [story(['E2E-01'])] }));
    write('pw.json', JSON.stringify(pw([{ title: '@E2E-01 x', status: 'skipped' }])));
    const res = run({ root, check: true, reports: ['pw.json'] });
    expect(res.code).toBe(1);
    expect(res.messages.join('\n')).toContain('skipped');
    write('pw.json', JSON.stringify(pw([{ title: '@E2E-01 x', status: 'expected' }])));
    expect(run({ root, check: true, reports: ['pw.json'] }).code).toBe(0);
  });

  it('@E2E-86 --check fails when docs/STORY_TRACKER.md is stale and passes when it is current', () => {
    write('e2e/a.spec.ts', "test('@E2E-01 x', () => {})");
    write('docs/stories/tracker.json', JSON.stringify({ stories: [story(['E2E-01'])] }));
    run({ root, check: false }); // fresh render written
    expect(run({ root, check: true }).code).toBe(0);
    write('docs/STORY_TRACKER.md', 'hand-edited, out of date\n');
    const res = run({ root, check: true });
    expect(res.code).toBe(1);
    expect(res.messages.join('\n')).toContain('stale');
    expect(run({ root, check: true }).code).toBe(0); // the failed run regenerated it
    // CRLF checkouts (Windows autocrlf) are not "stale"
    write('docs/STORY_TRACKER.md', fs.readFileSync(path.join(root, 'docs/STORY_TRACKER.md'), 'utf8').split('\n').join('\r\n'));
    expect(run({ root, check: true }).code).toBe(0);
  });
});
