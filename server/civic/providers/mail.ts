/**
 * Outbound e-mail contract (S-141 follow-up: proof that an applicant controls the official address).
 *
 * `MailProvider.send` is the whole contract: deliver one plain-text message, throw on failure. Rules every adapter must keep: never log the
 * body or the recipient (the body carries a one-time code), treat `idempotencyKey` as "send at most once per key", and give up after one
 * bounded attempt (the caller offers a resend). No real SMTP or vendor API adapter is built here; a vendor adapter calls `setMailProvider`
 * before `createCivicRouter()` runs, exactly like the SMS provider.
 *
 * `DevMailProvider` keeps messages in memory (`mailOutbox`, newest 200) for tests and local development. It refuses to run in production,
 * and `productionProblems()` (guards.ts) refuses to start a production server while it is the active mailer.
 * `CIVIC_EXPOSE_DEV_MAIL=1` lets the confirmation-request route echo the code outside production on a local host (like CIVIC_EXPOSE_DEV_OTP).
 */
export interface MailMessage { to: string; subject: string; text: string; idempotencyKey?: string }
export interface MailProvider { readonly name: string; send(msg: MailMessage): Promise<void> }

export const mailOutbox: (MailMessage & { ts: string })[] = [];

const isProd = (): boolean => process.env.NODE_ENV === "production" || process.env.CIVIC_ENV === "production";

export class DevMailProvider implements MailProvider {
  readonly name = "dev";
  private seen = new Set<string>();
  async send(msg: MailMessage): Promise<void> {
    if (isProd()) throw new Error("dev mail provider refuses to run in production; install a real provider with setMailProvider");
    if (msg.idempotencyKey) { if (this.seen.has(msg.idempotencyKey)) return; this.seen.add(msg.idempotencyKey); }
    mailOutbox.push({ ...msg, ts: new Date().toISOString() });
    if (mailOutbox.length > 200) mailOutbox.shift();
  }
}

let provider: MailProvider | null = null;
export function getMail(): MailProvider {
  if (isProd() && !provider) throw new Error("no mail provider configured for production");
  if (!provider) provider = new DevMailProvider();
  return provider;
}
export function setMailProvider(p: MailProvider | null): void { provider = p; }
/** True unless a real mail provider has been installed. */
export function isDevMailProvider(): boolean { return !provider || provider instanceof DevMailProvider; }
/** Latest message to an address (tests and dev tooling only; empty in production because the dev provider refuses to run there). */
export const lastMailTo = (to: string): (MailMessage & { ts: string }) | undefined => [...mailOutbox].reverse().find((m) => m.to === to);
