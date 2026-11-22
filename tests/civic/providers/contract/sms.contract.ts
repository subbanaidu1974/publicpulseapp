/**
 * SMS provider CONTRACT SUITE (S-63, E2E-78). A vendor adapter is certified when `runSmsProviderContract` passes against it.
 *
 *   import { runSmsProviderContract } from "./contract/sms.contract";
 *   runSmsProviderContract("acme-sms", async (opts) => { ...build ManagedSmsProvider(new AcmeTransport(...), opts) + a vendor simulator... });
 *
 * The factory receives the gateway options the suite needs (registry, short timeouts, requireTemplates...) and returns a harness that
 * lets the suite (a) see what the VENDOR received, (b) switch the vendor's behaviour, (c) deliver a receipt through the adapter's REAL
 * callback path and (d) read captured provider logs. See docs/PROVIDERS.md for how to build a harness for a new vendor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, resetDbForTests } from "../../../../server/civic/core";
import { SmsRejectedError, SmsTemplateError, SmsTemplateRegistry, smsSegments, type ManagedSmsProvider, type SmsGatewayOpts } from "../../../../server/civic/providers/sms";
import { setProviderLogger } from "../../../../server/civic/providers/util";

export type SmsVendorMode = "ok" | "error500" | "timeout" | "reject400";
export interface SmsHarness {
  provider: ManagedSmsProvider;
  setMode(m: SmsVendorMode): void;
  /** Distinct messages the vendor accepted. */
  received(): { to: string; text: string; idempotencyKey: string; templateId: string | null; dltTemplateId: string | null; senderId: string | null; messageId: string }[];
  /** Total HTTP/API calls the vendor saw (including failed ones). */
  requests(): number;
  /** Deliver a vendor receipt through the real callback path (authenticated). Resolves with the HTTP status (200 expected). */
  deliverReceipt(messageId: string, status: string, errorCode?: string): Promise<number>;
  /** Deliver a receipt WITHOUT valid authentication. Must be rejected (401). */
  deliverForgedReceipt(messageId: string, status: string): Promise<number>;
  /** Make the vendor report this per-segment price (INR) on accept; null = vendor reports no price. */
  setVendorPrice(p: number | null): void;
  close(): Promise<void>;
}
export type SmsHarnessFactory = (o: SmsGatewayOpts) => Promise<SmsHarness>;

const PHONE = "+919876501234";
export const contractTemplates = () => new SmsTemplateRegistry([
  { id: "otp", dltTemplateId: "DLT-OTP-1", category: "otp", language: "en", senderId: "PPULSE", body: "People Pulse code: {{code:8}}. Valid for 5 minutes. Do not share it." },
  { id: "te_notice", dltTemplateId: "DLT-TE-1", category: "service", language: "te", senderId: "PPULSE", body: "పీపుల్ పల్స్: మీ ఫిర్యాదు సంఖ్య {{ref:20}}." },
  { id: "draft", category: "service", language: "en", body: "People Pulse: draft notice {{n:10}}." }, // no DLT id: must never be sent in production
]);

export function runSmsProviderContract(name: string, factory: SmsHarnessFactory): void {
  describe(`SMS provider contract: ${name}`, () => {
    let h: SmsHarness; let logs: string[];
    const make = async (o: SmsGatewayOpts = {}) => {
      h = await factory({ registry: contractTemplates(), requireTemplates: true, timeoutMs: 200, maxAttempts: 3, backoffBaseMs: 10, backoffCapMs: 1000, unitCost: null, ...o });
      return h;
    };
    const later = () => Date.now() + 4 * 3_600_000;
    beforeEach(() => { resetDbForTests(); migrate(); logs = []; setProviderLogger((l) => logs.push(l)); });
    afterEach(async () => { await h?.close(); setProviderLogger(null); resetDbForTests(); });

    it("@E2E-78 an approved template reaches the vendor with its DLT template id, sender id and slot values", async () => {
      await make();
      const r = await h.provider.submit(PHONE, "People Pulse code: 482913. Valid for 5 minutes. Do not share it.");
      expect(r.state === "queued" || r.state === "sent" || r.state === "delivered").toBe(true);
      const got = h.received();
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ to: PHONE, templateId: "otp", dltTemplateId: "DLT-OTP-1", senderId: "PPULSE" });
      expect(got[0].text).toContain("482913");
    });

    it("@E2E-78 in production mode text that is not an approved, DLT-registered template is refused before any vendor call", async () => {
      await make();
      await expect(h.provider.submit(PHONE, "Buy cheap loans now!")).rejects.toBeInstanceOf(SmsTemplateError);
      await expect(h.provider.submit(PHONE, "People Pulse: draft notice 7.")).rejects.toBeInstanceOf(SmsTemplateError); // registered locally, no DLT id
      await expect(h.provider.send(PHONE, "People Pulse code: 123456. Valid for 5 minutes. Do not share it.\nExtra")).rejects.toBeInstanceOf(SmsTemplateError);
      expect(h.requests()).toBe(0);
    });

    it("@E2E-78 non-production mode may send free text (dev ergonomics) but still tags matched templates", async () => {
      await make({ requireTemplates: false });
      await h.provider.send(PHONE, "hello from a developer");
      expect(h.received()[0].templateId).toBeNull();
    });

    it("@E2E-78 sendTemplated renders a registered template and rejects missing variables / unknown ids", async () => {
      await make();
      await h.provider.sendTemplated(PHONE, "otp", { code: "111222" });
      expect(h.received()[0].text).toBe("People Pulse code: 111222. Valid for 5 minutes. Do not share it.");
      await expect(h.provider.sendTemplated(PHONE, "otp", {})).rejects.toBeInstanceOf(SmsTemplateError);
      await expect(h.provider.sendTemplated(PHONE, "nope", {})).rejects.toBeInstanceOf(SmsTemplateError);
    });

    it("@E2E-78 rejects malformed destinations and empty or oversized text", async () => {
      await make({ requireTemplates: false });
      await expect(h.provider.send("9876501234", "x")).rejects.toBeInstanceOf(SmsRejectedError);
      await expect(h.provider.send(PHONE, "   ")).rejects.toBeInstanceOf(SmsRejectedError);
      await expect(h.provider.send(PHONE, "x".repeat(1601))).rejects.toBeInstanceOf(SmsRejectedError);
      expect(h.requests()).toBe(0);
    });

    it("@E2E-78 idempotency: the same key (or identical text in the dedupe window) reaches the vendor once", async () => {
      await make();
      const a = await h.provider.submit(PHONE, "People Pulse code: 100001. Valid for 5 minutes. Do not share it.", { idempotencyKey: "k-1" });
      const b = await h.provider.submit(PHONE, "People Pulse code: 100001. Valid for 5 minutes. Do not share it.", { idempotencyKey: "k-1" });
      expect(b.deduped).toBe(true);
      expect(b.messageId).toBe(a.messageId);
      await h.provider.send(PHONE, "People Pulse code: 100002. Valid for 5 minutes. Do not share it.");
      await h.provider.send(PHONE, "People Pulse code: 100002. Valid for 5 minutes. Do not share it.");
      expect(h.received().map((m) => m.text.slice(19, 25))).toEqual(["100001", "100002"]);
      expect(new Set(h.received().map((m) => m.idempotencyKey)).size).toBe(2);
    });

    it("@E2E-78 delivery receipts map to queued/sent/delivered/failed per message id and never move a message backwards", async () => {
      await make();
      const r = await h.provider.submit(PHONE, "People Pulse code: 200001. Valid for 5 minutes. Do not share it.");
      const st = () => h.provider.status(r.idempotencyKey)!.state;
      expect(await h.deliverReceipt(r.messageId!, "sent")).toBe(200);
      expect(st()).toBe("sent");
      expect(await h.deliverReceipt(r.messageId!, "queued")).toBe(200); // late, lower: ignored
      expect(st()).toBe("sent");
      await h.deliverReceipt(r.messageId!, "delivered");
      expect(st()).toBe("delivered");
      await h.deliverReceipt(r.messageId!, "failed"); // terminal states stay
      expect(st()).toBe("delivered");
      const r2 = await h.provider.submit(PHONE, "People Pulse code: 200002. Valid for 5 minutes. Do not share it.");
      await h.deliverReceipt(r2.messageId!, "failed", "DND");
      expect(h.provider.status(r2.idempotencyKey)).toMatchObject({ state: "failed", error: "DND" });
      expect(await h.deliverReceipt("unknown-id", "delivered")).toBe(200); // unknown ids are accepted and ignored
    });

    it("@E2E-78 forged or unsigned receipts are rejected and change nothing", async () => {
      await make();
      const r = await h.provider.submit(PHONE, "People Pulse code: 300001. Valid for 5 minutes. Do not share it.");
      expect(await h.deliverForgedReceipt(r.messageId!, "delivered")).toBe(401);
      expect(h.provider.status(r.idempotencyKey)!.state).not.toBe("delivered");
    });

    it("@E2E-78 timeouts: a hanging vendor never blocks the caller beyond the deadline; the message is queued for retry and health degrades", async () => {
      await make();
      h.setMode("timeout");
      const t0 = Date.now();
      const r = await h.provider.submit(PHONE, "People Pulse code: 400001. Valid for 5 minutes. Do not share it.");
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(r).toMatchObject({ state: "retry", degraded: true });
      expect(h.provider.health().degraded).toBe(true);
    });

    it("@E2E-78 quiet failure policy: a vendor outage never throws to the caller, retries with backoff, then delivers once the vendor is back", async () => {
      await make();
      h.setMode("error500");
      await expect(h.provider.send(PHONE, "People Pulse code: 500001. Valid for 5 minutes. Do not share it.")).resolves.toBeUndefined();
      expect(h.received()).toHaveLength(0);
      h.setMode("ok");
      const run = await h.provider.runRetries(later());
      expect(run.processed).toBe(1);
      expect(h.received()).toHaveLength(1);
      expect(h.provider.health().retrying).toBe(0);
    });

    it("@E2E-78 retries are bounded: after maxAttempts the message is dead-lettered (audited, no payload leak) and can be requeued by an operator", async () => {
      await make({ maxAttempts: 2 });
      h.setMode("error500");
      const r = await h.provider.submit(PHONE, "People Pulse code: 600001. Valid for 5 minutes. Do not share it.");
      expect(r.state).toBe("retry");
      await h.provider.runRetries(later());
      expect(h.provider.status(r.idempotencyKey)).toMatchObject({ state: "dead", attempts: 2 });
      const dl = h.provider.deadLetters();
      expect(dl).toHaveLength(1);
      expect(JSON.stringify(dl)).not.toContain("600001");
      expect(dl[0]).toMatchObject({ templateId: "otp", attempts: 2 });
      h.setMode("ok");
      expect(h.provider.requeueDeadLetter(r.idempotencyKey)).toBe(true);
      await h.provider.runRetries(later());
      expect(h.provider.status(r.idempotencyKey)!.messageId).toBeTruthy();
    });

    it("@E2E-78 a permanent vendor rejection (HTTP 4xx) is dead-lettered at once, not retried", async () => {
      await make();
      h.setMode("reject400");
      const r = await h.provider.submit(PHONE, "People Pulse code: 700001. Valid for 5 minutes. Do not share it.");
      expect(r.state).toBe("dead");
      expect(h.requests()).toBe(1);
    });

    it("@E2E-78 cost accounting: configured unit cost x segments (Telugu is UCS-2); unknown price is flagged, never silently free", async () => {
      await make({ unitCost: 0.25 });
      await h.provider.send(PHONE, "People Pulse code: 800001. Valid for 5 minutes. Do not share it."); // 1 GSM segment
      await h.provider.send(PHONE, "పీపుల్ పల్స్: మీ ఫిర్యాదు సంఖ్య ISS-77."); // UCS-2
      const c = h.provider.costSummary(0, Date.now() + 1000);
      expect(c.messages).toBe(2);
      expect(c.segments).toBe(1 + smsSegments("పీపుల్ పల్స్: మీ ఫిర్యాదు సంఖ్య ISS-77."));
      expect(c.knownCost).toBeCloseTo(0.25 * c.segments, 5);
      expect(c.unknownCostMessages).toBe(0);
      await h.close();
      resetDbForTests(); migrate();
      await make({ unitCost: null });
      await h.provider.send(PHONE, "People Pulse code: 800002. Valid for 5 minutes. Do not share it.");
      const u = h.provider.costSummary(0, Date.now() + 1000);
      expect(u).toMatchObject({ messages: 1, knownCost: 0, unknownCostMessages: 1 });
    });

    it("@E2E-78 a price reported by the vendor wins over the configured one", async () => {
      await make({ unitCost: 0.25 });
      h.setVendorPrice(0.5);
      await h.provider.send(PHONE, "People Pulse code: 810001. Valid for 5 minutes. Do not share it.");
      expect(h.provider.costSummary(0, Date.now() + 1000).knownCost).toBeCloseTo(0.5, 5);
    });

    it("@E2E-78 a daily cost cap holds further sends with state budget_exhausted instead of spending", async () => {
      await make({ unitCost: 1, dailyCostCap: 2 });
      await h.provider.send(PHONE, "People Pulse code: 820001. Valid for 5 minutes. Do not share it.");
      await h.provider.send(PHONE, "People Pulse code: 820002. Valid for 5 minutes. Do not share it.");
      const r = await h.provider.submit(PHONE, "People Pulse code: 820003. Valid for 5 minutes. Do not share it.");
      expect(r).toMatchObject({ state: "budget_exhausted", degraded: true });
      expect(h.received()).toHaveLength(2);
    });

    it("@E2E-78 no PII in logs: neither the phone number nor the OTP appears in any provider log line, on success or failure paths", async () => {
      await make({ maxAttempts: 2 });
      await h.provider.send(PHONE, "People Pulse code: 987654. Valid for 5 minutes. Do not share it.");
      h.setMode("timeout");
      await h.provider.send(PHONE, "People Pulse code: 987655. Valid for 5 minutes. Do not share it.");
      h.setMode("error500");
      await h.provider.send(PHONE, "People Pulse code: 987656. Valid for 5 minutes. Do not share it.");
      await h.provider.runRetries(later());
      await expect(h.provider.send(PHONE, "unapproved 987657 text")).rejects.toBeInstanceOf(SmsTemplateError);
      const all = logs.join("\n");
      expect(all.length).toBeGreaterThan(0);
      for (const bad of [PHONE, PHONE.slice(3), "987654", "987655", "987656", "987657"]) expect(all).not.toContain(bad);
    });
  });
}
