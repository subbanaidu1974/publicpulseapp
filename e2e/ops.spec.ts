import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E-84 (S-69): the PRODUCTION BUILD, not the dev server.
 *  - NODE_ENV=production must refuse to start on dev stand-ins (S-55 guards) with a clear message: asserted here.
 *  - The same bundle (dist/server.cjs) is smoke-tested with SERVE_BUILT=1 (static bundle, no Vite, non-production guards).
 * Both Playwright projects run this file in parallel, so the build is guarded by a cross-process lock.
 */
const root = process.cwd();
const lockDir = path.join(os.tmpdir(), 'pulse-e2e-build.lock');
const stamp = path.join(root, 'dist', '.ops-build-stamp');

async function ensureBuilt() {
  for (let i = 0; i < 240; i++) {
    try {
      fs.mkdirSync(lockDir);
    } catch {
      await new Promise((r) => setTimeout(r, 500)); // another worker is building
      continue;
    }
    try {
      const fresh = fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 5 * 60_000 && fs.existsSync(path.join(root, 'dist', 'server.cjs'));
      if (!fresh) {
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'pipe', shell: process.platform === 'win32', timeout: 180_000 });
        fs.writeFileSync(stamp, String(Date.now()));
      }
      return;
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error('timed out waiting for the production build lock');
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

function start(env: Record<string, string>): { child: ChildProcess; out: () => string } {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['NODE_ENV', 'CIVIC_ENV', 'CIVIC_EXPOSE_DEV_OTP', 'SERVE_BUILT', 'CIVIC_ALLOW_DEMO']) delete clean[k];
  const child = spawn(process.execPath, ['dist/server.cjs'], { cwd: root, env: { ...clean, CIVIC_JOBS: '0', CIVIC_SWEEP: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout?.on('data', (d) => (buf += d));
  child.stderr?.on('data', (d) => (buf += d));
  return { child, out: () => buf };
}

async function waitUp(base: string, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('server exited early with code ' + child.exitCode);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}

test.describe('production build', () => {
  test.describe.configure({ timeout: 240_000 });
  test.beforeAll(async () => { await ensureBuilt(); });

  test('@E2E-84 NODE_ENV=production refuses to start on dev stand-ins with the guard message', async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-prod-'));
    const { child, out } = start({ NODE_ENV: 'production', PORT: String(port), CIVIC_DB: path.join(dir, 'c.db'), CIVIC_ALLOW_DEMO: '1' });
    const code: number | null = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve(null); }, 30_000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).toBe(1);
    expect(out()).toContain('civic refuses to start in production');
    expect(out()).toContain('dev key provider');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('@E2E-84 built bundle serves /healthz, /readyz, the static page and an /api/v1 call', async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-built-'));
    const base = `http://127.0.0.1:${port}`;
    const { child, out } = start({ SERVE_BUILT: '1', PORT: String(port), CIVIC_DB: path.join(dir, 'c.db') });
    try {
      await waitUp(base, child);
      const h = await fetch(base + '/healthz', { headers: { 'x-request-id': 'e2e-ops-req-0001' } });
      expect(h.status).toBe(200);
      expect(h.headers.get('x-request-id')).toBe('e2e-ops-req-0001');
      expect(h.headers.get('x-powered-by')).toBeNull();
      const r = await fetch(base + '/readyz');
      expect(r.status).toBe(200);
      const rj = await r.json();
      expect(rj.checks.db.ok).toBe(true);
      expect(rj.checks.migrations.detail.pending).toEqual([]);
      const page = await fetch(base + '/');
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="root"');
      expect(html).toMatch(/\/assets\/index-.*\.js/); // hashed production bundle, not the Vite dev client
      expect(html).not.toContain('@vite/client');
      expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self'(;|$)/);
      const api = await fetch(base + '/api/v1/health', { headers: { 'x-request-id': 'e2e-ops-req-0002' } });
      expect(api.status).toBe(200);
      // access log lines are structured JSON carrying the request id
      await new Promise((r) => setTimeout(r, 200));
      const line = out().split('\n').find((l) => l.includes('e2e-ops-req-0002'));
      expect(line && JSON.parse(line).reqId).toBe('e2e-ops-req-0002');
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may hold the SQLite file briefly; temp dir cleanup is best effort */ }
    }
  });
});
