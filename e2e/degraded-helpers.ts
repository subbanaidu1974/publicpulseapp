import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Extra real server instances for degraded-mode specs. The degraded state is process-wide and read from the environment, so the only honest
 * way to see it from a browser is a server started in that mode (CIVIC_DEGRADED=1). Nothing is faked: the sheds below are the server's own 503s.
 * Vite HMR is disabled so a second dev server does not fight over its websocket port.
 */
export interface Instance { url: string; stop: () => Promise<void> }

export async function startServer(port: number, extra: Record<string, string>): Promise<Instance> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), DISABLE_HMR: 'true',
    CIVIC_EXPOSE_DEV_OTP: '1', CIVIC_E2E_SEED: '1', CIVIC_OTP_IP_LIMIT: '1000', CIVIC_OTP_NET_LIMIT: '1000', RATE_LIMIT_BURST: '100000', RATE_LIMIT_PER_SEC: '100000',
    CIVIC_DB: path.join(os.tmpdir(), `civic-e2e-degraded-${port}-${process.pid}-${Date.now()}.db`),
    ...extra,
  };
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { env, cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server on ${port} exited early (${child.exitCode})`);
    try { if ((await fetch(`${url}/api/v1/degraded`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server on ${port} did not start`); }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, stop: async () => { if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); } } };
}
