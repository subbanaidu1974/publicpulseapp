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
notifyRouter.get("/keys", pub("keys", 120), wrap(async (_req, res) => { res.json({ keys: publishedKeys(), note: "Verify signed_payload with the key whose key_id matches. Pin the key; do not trust a key delivered inside a notification." }); }));
notifyRouter.get("/block-log", pub("blocklog", 60), wrap(async (req, res) => { res.json({ entries: await svc.publicBlockLog(Number(req.query.limit) || 200, req.query.before ? Number(req.query.before) : undefined), note: "Time bucket, sender, category and reason code only. No message content." }); }));
notifyRouter.get("/policy", pub("policy", 60), wrap(async (_req, res) => {
  const p = notifyPolicy();
  res.json({ categories: p.categories, category_labels: p.category_labels, caps: p.caps, quiet_hours_default: { start: p.quiet_hours.default_start, end: p.quiet_hours.default_end, timezone: "IST", bypass: p.quiet_hours.bypass }, declaration: p.mcc.declaration, limits: p.limits, allowed_link_domains: p.allowed_link_domains, org_kinds: p.org_kinds });
}));
notifyRouter.get("/templates", pub("templates", 60), wrap(async (_req, res) => { res.json({ templates: mccTemplates().map((t) => ({ ...t, cleared: isCleared(t) })) }); }));
/** Public pre-flight: is sending suspended, and what does the election-window state mean for senders. No reason for a kill is shown. */
notifyRouter.get("/status", pub("status", 120), wrap(async (req, res) => {
  const state = (str(req.query.state) || "AP").toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(state)) return void res.status(400).json({ error: "state must be a state code, e.g. AP", code: "bad_state" });
  res.set("Cache-Control", "no-store");
  res.json(await svc.publicStatus(state, str(req.query.district).slice(0, 40) || null, str(req.query.org_id).slice(0, 64) || null));
}));
notifyRouter.get("/senders", pub("senders", 60), wrap(async (_req, res) => { res.json({ senders: await svc.publicOrgs() }); }));
notifyRouter.get("/senders/:org_id/log", pub("senderlog", 60), wrap(async (req, res) => {
  const r = await svc.publicSenderLog(str(req.params.org_id));
  if (!r) return void res.status(404).json({ error: "sender not found" });
  res.json(r);
}));

// ---- recipient ----
notifyRouter.get("/prefs", requireAuth, wrap(async (req, res) => { res.json(await getPrefs(pid(req))); }));
notifyRouter.put("/prefs", requireAuth, wrap(async (req, res) => { res.json(await updatePrefs(pid(req), req.body ?? {})); }));
notifyRouter.post("/unsubscribe", requireAuth, wrap(async (req, res) => { res.json(await unsubscribeAll(pid(req))); }));
notifyRouter.put("/antiphish", requireAuth, wrap(async (req, res) => { await setAntiPhish(pid(req), req.body?.word); res.json({ ok: true }); }));
notifyRouter.get("/antiphish", requireAuth, wrap(async (req, res) => { res.json({ word: await getAntiPhish(pid(req)) }); }));
notifyRouter.get("/devices", requireAuth, wrap(async (req, res) => { res.set("Cache-Control", "private, no-store"); const devices = await listDevices(pid(req)); res.json({ devices, count: devices.length }); }));
notifyRouter.post("/devices", requireAuth, wrap(async (req, res) => { await registerDevice(pid(req), req.body?.token, req.body?.platform); res.status(201).json({ ok: true }); }));
notifyRouter.delete("/devices", requireAuth, wrap(async (req, res) => { await removeDevices(pid(req)); res.json({ ok: true }); }));
notifyRouter.get("/inbox", requireAuth, wrap(async (req, res) => { const items = await inbox(pid(req), Number(req.query.limit) || 50); res.json({ items, unread: items.filter((i) => !i.read).length }); }));
notifyRouter.post("/inbox/:id/read", requireAuth, wrap(async (req, res) => {
  if (!await markRead(pid(req), str(req.params.id))) return void res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

// ---- sender ----
const chal = (req: Request, res: Response, next: NextFunction): void => {
  if (!rateAllow("notifychal:" + pid(req), notifyPolicy().webauthn.challenge_rate_per_10min, 10 * 60_000)) return void res.status(429).json({ error: "too many security key challenges; wait and retry" });
  next();
};
notifyRouter.get("/sender/me", requireAuth, wrap(async (req, res) => { res.json(await svc.senderMe(pid(req))); }));
notifyRouter.post("/webauthn/register/options", requireAuth, chal, wrap(async (req, res) => { res.json(await svc.registrationOptions(pid(req))); }));
notifyRouter.post("/webauthn/register/verify", requireAuth, wrap(async (req, res) => { res.status(201).json(await svc.finishRegistration(pid(req), req.body)); }));
notifyRouter.get("/messages", requireAuth, wrap(async (req, res) => { res.json({ messages: await svc.listMessages(pid(req)) }); }));
notifyRouter.post("/messages/lint", requireAuth, wrap(async (req, res) => {
  if (!rateAllow("notifylint:" + pid(req), 120, 60_000)) return void res.status(429).json({ error: "too many checks; wait and retry", code: "rate_limited" });
  res.json(await svc.lintMessage(pid(req), req.body ?? {}));
}));
notifyRouter.post("/messages", requireAuth, wrap(async (req, res) => { res.status(201).json(await svc.createMessage(pid(req), req.body ?? {})); }));
notifyRouter.get("/messages/:id", requireAuth, wrap(async (req, res) => { res.json(await svc.getMessage(pid(req), str(req.params.id))); }));
notifyRouter.post("/messages/:id/challenge", requireAuth, chal, wrap(async (req, res) => { res.json(await svc.assertionOptions(pid(req), str(req.params.id), str(req.body?.purpose))); }));
notifyRouter.post("/messages/:id/approve", requireAuth, wrap(async (req, res) => { res.json(await svc.approveMessage(pid(req), str(req.params.id), req.body?.assertion)); }));
notifyRouter.post("/messages/:id/send", requireAuth, wrap(async (req, res) => { res.json(await svc.sendMessage(pid(req), str(req.params.id), req.body?.assertion)); }));
notifyRouter.post("/messages/:id/cancel", requireAuth, wrap(async (req, res) => { res.json(await svc.cancelMessage(pid(req), str(req.params.id))); }));

// ---- admin (admin role + TOTP; dual control where marked) ----
const mfa = confirmMfaGuard;
notifyRouter.get("/admin/orgs", requireRole("admin"), wrap(async (req, res) => { auditPrivilegedRead(pid(req), "notify_orgs", "admin lists sender organisations"); res.json({ orgs: await svc.listOrgs(str(req.query.status) || undefined) }); }));
notifyRouter.get("/admin/people", requireRole("admin"), wrap(async (req, res) => {
  if (!rateAllow("notifypeople:" + pid(req), 30, 60_000)) return void res.status(429).json({ error: "too many lookups; wait and retry", code: "rate_limited" });
  const out = await svc.lookupPeople(str(req.query.q));
  auditPrivilegedRead(pid(req), "notify_people_lookup", "admin resolves a sender candidate (" + (out.people as unknown[]).length + " matches; no phone or name returned)");
  res.set("Cache-Control", "private, no-store");
  res.json(out);
}));
notifyRouter.get("/admin/credentials", requireRole("admin"), wrap(async (req, res) => {
  const sender = str(req.query.sender).slice(0, 64);
  if (!sender) return void res.status(400).json({ error: "sender is required", code: "sender_required" });
  const out = await svc.senderCredentials(sender);
  auditPrivilegedRead(pid(req), "notify_credentials:" + (out.sender as { id: string }).id, "admin lists a sender's security keys");
  res.set("Cache-Control", "private, no-store");
  res.json(out);
}));
notifyRouter.post("/admin/orgs", requireRole("admin"), mfa, wrap(async (req, res) => { res.status(201).json(await svc.requestOrg(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/orgs/:id/verify", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.decideOrg(pid(req), str(req.params.id), true)); }));
notifyRouter.post("/admin/orgs/:id/reject", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.decideOrg(pid(req), str(req.params.id), false)); }));
notifyRouter.get("/admin/senders", requireRole("admin"), wrap(async (req, res) => { auditPrivilegedRead(pid(req), "notify_senders", "admin lists senders"); res.json({ senders: await svc.listSenders(str(req.query.status) || undefined) }); }));
notifyRouter.post("/admin/senders", requireRole("admin"), mfa, wrap(async (req, res) => { res.status(201).json(await svc.requestSender(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/senders/:id/approve", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.decideSender(pid(req), str(req.params.id), true)); }));
notifyRouter.post("/admin/senders/:id/reject", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.decideSender(pid(req), str(req.params.id), false)); }));
notifyRouter.post("/admin/senders/:id/revoke", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.revokeSender(pid(req), str(req.params.id))); }));
notifyRouter.post("/admin/credentials/:id/revoke", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.revokeCredential(pid(req), str(req.params.id))); }));
notifyRouter.get("/admin/kill", requireRole("admin"), wrap(async (req, res) => { audit(pid(req), "notify.kill.list", "notify_kill", {}); res.json({ kills: await svc.listKills() }); }));
notifyRouter.post("/admin/kill", requireRole("admin"), mfa, wrap(async (req, res) => { res.status(201).json(await svc.engageKill(pid(req), req.body ?? {})); }));
notifyRouter.post("/admin/kill/:id/release-request", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.requestRelease(pid(req), str(req.params.id))); }));
notifyRouter.post("/admin/kill/:id/release-approve", requireRole("admin"), mfa, wrap(async (req, res) => { res.json(await svc.approveRelease(pid(req), str(req.params.id))); }));
