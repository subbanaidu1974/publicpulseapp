/** Periodic jobs (registered through registerJob; no edit to the base job list). */
import { registerJob } from "../jobs";
import { processDeferred } from "./delivery";

let done = false;
export function registerJobs(): void {
  if (done) return;
  done = true;
  // Deliver messages held back by quiet hours once the window ends; expire the ones that outlived their message.
  registerJob({ name: "notifyDeferred", intervalMs: 60_000, run: (now) => { void processDeferred(now).catch(() => undefined); return { started: true }; } });
}
