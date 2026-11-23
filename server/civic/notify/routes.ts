/** Router for /api/v1/civic/notify. Shapes are documented in docs/NOTIFICATIONS.md. */
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { audit, auditPrivilegedRead, requireAuth, requireRole } from "../core";
import { rateAllow } from "../identity/service";
import { confirmMfaGuard } from "./mfa-guard";
import { mccTemplates, isCleared, notifyPolicy } from "./content";
import { PrefError, getAntiPhish, getPrefs, inbox, listDevices, markRead, registerDevice, removeDevices, setAntiPhish, unsubscribeAll, updatePrefs } from "./delivery";
import * as svc from "./service";
import { publishedKeys } from "./sign";
import { registerJobs } from "./jobs";

export const notifyRouter = Router();
notifyRouter.use(express.json({ limit: "20kb" }));
registerJobs();

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e) {
    if (res.headersSent) return;
    if (e instanceof svc.NotifyError) res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    else if (e instanceof PrefError) res.status(400).json({ error: e.message, code: e.code });
    else res.status(500).json({ error: "internal error" });
  }
};
const pub = (name: string, limit: number) => (req: Request, res: Response, next: NextFunction): void => {
  if (!rateAllow(`notifypub:${name}:${req.ip || "?"}`, limit, 60_000)) return void res.status(429).json({ error: "too many requests; wait and retry" });
  next();
};
const pid = (req: Request): string => req.person!.id;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---- public ----
notifyRouter.get("/keys", pub("keys", 120), wrap((_req, res) => { res.json({ keys: publishedKeys(), note: "Verify signed_payload with the key whose key_id matches. Pin the key; do not trust a key delivered inside a notification." }); }));
notifyRouter.get("/block-log", pub("blocklog", 60), wrap((req, res) => { res.json({ entries: svc.publicBlockLog(Number(req.query.limit) || 200, req.query.before ? Number(req.query.before) : undefined), note: "Time bucket, sender, category and reason code only. No message content." }); }));
notifyRouter.get("/policy", pub("policy", 60), wrap((_req, res) => {
  const p = notifyPolicy();
  res.json({ categories: p.categories, category_labels: p.category_labels, caps: p.caps, quiet_hours_default: { start: p.quiet_hours.default_start, end: p.quiet_hours.default_end, timezone: "IST", bypass: p.quiet_hours.bypass }, declaration: p.mcc.declaration, limits: p.limits, allowed_link_domains: p.allowed_link_domains, org_kinds: p.org_kinds });
}));
notifyRouter.get("/templates", pub("templates", 60), wrap((_req, res) => { res.json({ templates: mccTemplates().map((t) => ({ ...t, cleared: isCleared(t) })) }); }));
/** Public pre-flight: is sending suspended, and what does the election-window state mean for senders. No reason for a kill is shown. */
notifyRouter.get("/status", pub("status", 120), wrap((req, res) => {
  const state = (str(req.query.state) || "AP").toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(state)) return void res.status(400).json({ error: "state must be a state code, e.g. AP", code: "bad_state" });
  res.set("Cache-Control", "no-store");
  res.json(svc.publicStatus(state, str(req.query.district).slice(0, 40) || null, str(req.query.org_id).slice(0, 64) || null));
}));
notifyRouter.get("/senders", pub("senders", 60), wrap((_req, res) => { res.json({ senders: svc.publicOrgs() }); }));
notifyRouter.get("/senders/:org_id/log", pub("senderlog", 60), wrap((req, res) => {
  const r = svc.publicSenderLog(str(req.params.org_id));
  if (!r) return void res.status(404).json({ error: "sender not found" });
  res.json(r);
}));

// ---- recipient ----
notifyRouter.get("/prefs", requireAuth, wrap((req, res) => { res.json(getPrefs(pid(req))); }));
notifyRouter.put("/prefs", requireAuth, wrap((req, res) => { res.json(updatePrefs(pid(req), req.body ?? {})); }));
notifyRouter.post("/unsubscribe", requireAuth, wrap((req, res) => { res.json(unsubscribeAll(pid(req))); }));
notifyRouter.put("/antiphish", requireAuth, wrap((req, res) => { setAntiPhish(pid(req), req.body?.word); res.json({ ok: true }); }));
notifyRouter.get("/antiphish", requireAuth, wrap((req, res) => { res.json({ word: getAntiPhish(pid(req)) }); }));
notifyRouter.get("/devices", requireAuth, wrap((req, res) => { res.set("Cache-Control", "private, no-store"); const devices = listDevices(pid(req)); res.json({ devices, count: devices.length }); }));
notifyRouter.post("/devices", requireAuth, wrap((req, res) => { registerDevice(pid(req), req.body?.token, req.body?.platform); res.status(201).json({ ok: true }); }));
notifyRouter.delete("/devices", requireAuth, wrap((req, res) => { removeDevices(pid(req)); res.json({ ok: true }); }));
notifyRouter.get("/inbox", requireAuth, wrap((req, res) => { const items = inbox(pid(req), Number(req.query.limit) || 50); res.json({ items, unread: items.filter((i) => !i.read).length }); }));
notifyRouter.post("/inbox/:id/read", requireAuth, wrap((req, res) => {
  if (!markRead(pid(req), str(req.params.id))) return void res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

// ---- sender ----
const chal = (req: Request, res: Response, next: NextFunction): void => {
  if (!rateAllow("notifychal:" + pid(req), notifyPolicy().webauthn.challenge_rate_per_10min, 10 * 60_000)) return void res.status(429).json({ error: "too many security key challenges; wait and retry" });
  next();
};
notifyRouter.get("/sender/me", requireAuth, wrap((req, res) => { res.json(svc.senderMe(pid(req))); }));
notifyRouter.post("/webauthn/register/options", requireAuth, chal, wrap((req, res) => { res.json(svc.registrationOptions(pid(req))); }));
notifyRouter.post("/webauthn/register/verify", requireAuth, wrap((req, res) => { res.status(201).json(svc.finishRegistration(pid(req), req.body)); }));
notifyRouter.get("/messages", requireAuth, wrap((req, res) => { res.json({ messages: svc.listMessages(pid(req)) }); }));
notifyRouter.post("/messages/lint", requireAuth, wrap((req, res) => {
  if (!rateAllow("notifylint:" + pid(req), 120, 60_000)) return void res.status(429).json({ error: "too many checks; wait and retry", code: "rate_limited" });
  res.json(svc.lintMessage(pid(req), req.body ?? {}));
}));
notifyRouter.post("/messages", requireAuth, wrap((req, res) => { res.status(201).json(svc.createMessage(pid(req), req.body ?? {})); }));
notifyRouter.get("/messages/:id", requireAuth, wrap((req, res) => { res.json(svc.getMessage(pid(req), str(req.params.id))); }));
notifyRouter.post("/messages/:id/challenge", requireAuth, chal, wrap((req, res) => { res.json(svc.assertionOptions(pid(req), str(req.params.id), str(req.body?.purpose))); }));
notifyRouter.post("/messages/:id/approve", requireAuth, wrap((req, res) => { res.json(svc.approveMessage(pid(req), str(req.params.id), req.body?.assertion)); }));
notifyRouter.post("/messages/:id/send", requireAuth, wrap(async (req, res) => { res.json(await svc.sendMessage(pid(req), str(req.params.id), req.body?.assertion)); }));
notifyRouter.post("/messages/:id/cancel", requireAuth, wrap((req, res) => { res.json(svc.cancelMessage(pid(req), str(req.params.id))); }));

// ---- admin (admin role + TOTP; dual control where marked) ----
const mfa = confirmMfaGuard;
notifyRouter.get("/admin/orgs", requireRole("admin"), wrap((req, res) => { auditPrivilegedRead(pid(req), "notify_orgs", "admin lists sender organisations"); res.json({ orgs: svc.listOrgs(str(req.query.status) || undefined) }); }));
notifyRouter.get("/admin/people", requireRole("admin"), wrap((req, res) => {
  if (!rateAllow("notifypeople:" + pid(req), 30, 60_000)) return void res.status(429).json({ error: "too many lookups; wait and retry", code: "rate_limited" });
  const out = svc.lookupPeople(str(req.query.q));
  auditPrivilegedRead(pid(req), "notify_people_lookup", "admin resolves a sender candidate (" + (out.people as unknown[]).length + " matches; no phone or name returned)");
  res.set("Cache-Control", "private, no-store");
  res.json(out);
}));
notifyRouter.get("/admin/credentials", requireRole("admin"), wrap((req, res) => {
  const sender = str(req.query.sender).slice(0, 64);
  if (!sender) return void res.status(400).json({ error: "sender is required", code: "sender_required" });
  const out = svc.senderCredentials(sender);
  auditPrivilegedRead(pid(req), "notify_credentials:" + (out.sender as { id: string }).id, "admin lists a sender's security keys");
  res.set("Cache-Control", "private, no-store");
  res.json(out);
}));
notifyRouter.post("/admin/orgs", requireRole("admin"), mfa, wrap((req, res) => { res.status(201).json(svc.requestOrg(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/orgs/:id/verify", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.decideOrg(pid(req), str(req.params.id), true)); }));
notifyRouter.post("/admin/orgs/:id/reject", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.decideOrg(pid(req), str(req.params.id), false)); }));
notifyRouter.get("/admin/senders", requireRole("admin"), wrap((req, res) => { auditPrivilegedRead(pid(req), "notify_senders", "admin lists senders"); res.json({ senders: svc.listSenders(str(req.query.status) || undefined) }); }));
notifyRouter.post("/admin/senders", requireRole("admin"), mfa, wrap((req, res) => { res.status(201).json(svc.requestSender(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/senders/:id/approve", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.decideSender(pid(req), str(req.params.id), true)); }));
notifyRouter.post("/admin/senders/:id/reject", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.decideSender(pid(req), str(req.params.id), false)); }));
notifyRouter.post("/admin/senders/:id/revoke", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.revokeSender(pid(req), str(req.params.id))); }));
notifyRouter.post("/admin/credentials/:id/revoke", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.revokeCredential(pid(req), str(req.params.id))); }));
notifyRouter.get("/admin/kill", requireRole("admin"), wrap((req, res) => { audit(pid(req), "notify.kill.list", "notify_kill", {}); res.json({ kills: svc.listKills() }); }));
notifyRouter.post("/admin/kill", requireRole("admin"), mfa, wrap((req, res) => { res.status(201).json(svc.engageKill(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/kill/:id/release-request", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.requestRelease(pid(req), str(req.params.id))); }));
notifyRouter.post("/admin/kill/:id/release-approve", requireRole("admin"), mfa, wrap((req, res) => { res.json(svc.approveRelease(pid(req), str(req.params.id))); }));
