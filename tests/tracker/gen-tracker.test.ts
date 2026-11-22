import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTags, evaluate, violations, render, run } from '../../scripts/gen-tracker';

describe('UT-tracker gen-tracker', () => {
  let root: string;
  const write = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const tracker = (stories: unknown[]) => write('docs/stories/tracker.json', JSON.stringify({ stories }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds E2E and UT tags in e2e and tests dirs, ignoring node_modules', () => {
    write('e2e/a.spec.ts', "test('@E2E-01 x', () => {})");
    write('tests/b.test.ts', "describe('UT-foo @UT-foo', () => {})");
    write('e2e/node_modules/c.ts', '@E2E-99');
    const tags = findTags([path.join(root, 'e2e'), path.join(root, 'tests')]);
    expect([...tags].sort()).toEqual(['E2E-01', 'UT-foo']);
  });

  it('flags only done stories with missing tags', () => {
    const rows = evaluate(
      {
        stories: [
          { id: 'S-1', epic: 'e', title: 't', agent: 'A', status: 'done', tests: ['E2E-01'] },
          { id: 'S-2', epic: 'e', title: 't', agent: 'A', status: 'done', tests: ['E2E-02'] },
          { id: 'S-3', epic: 'e', title: 't', agent: 'A', status: 'todo', tests: ['E2E-03'] },
        ],
      },
      new Set(['E2E-01']),
    );
    expect(violations(rows).map((r) => r.id)).toEqual(['S-2']);
  });

  it('renders counts, percent complete and tests-found column', () => {
    const rows = evaluate(
      {
        stories: [
          { id: 'S-1', epic: 'Epic', title: 'One', agent: 'A', status: 'done', tests: ['E2E-01'] },
          { id: 'S-2', epic: 'Epic', title: 'Two', agent: 'B', status: 'todo', tests: ['E2E-02'] },
        ],
      },
      new Set(['E2E-01']),
    );
    const md = render(rows);
    expect(md).toContain('50% complete');
    expect(md).toContain('| done | 1 |');
    expect(md).toContain('| todo | 1 |');
    expect(md).toContain('| S-1 | Epic | One | A | done | E2E-01 | yes |');
    expect(md).toContain('no (missing: E2E-02)');
  });

  it('run --check exits non-zero for a done story with a missing tag and writes the markdown', () => {
    write('e2e/a.spec.ts', "test('@E2E-01', () => {})");
    tracker([{ id: 'S-1', epic: 'e', title: 't', agent: 'A', status: 'done', tests: ['E2E-01', 'E2E-02'] }]);
    const res = run({ root, check: true });
    expect(res.code).toBe(1);
    expect(res.messages[0]).toContain('E2E-02');
    expect(fs.existsSync(path.join(root, 'docs/STORY_TRACKER.md'))).toBe(true);
  });

  it('run --check passes when all done stories are covered', () => {
    write('tests/x.test.ts', "describe('@UT-x', () => {})");
    tracker([{ id: 'S-1', epic: 'e', title: 't', agent: 'A', status: 'done', tests: ['UT-x'] }]);
    expect(run({ root, check: true }).code).toBe(0);
  });
});
