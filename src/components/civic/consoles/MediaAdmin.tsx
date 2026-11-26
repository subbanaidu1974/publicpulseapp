import { useState } from "react";
import { mediaApi } from "../../../api/mediahub";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";
import { Gate, useGuarded } from "./shared";

const say = (e: unknown): string => (e as { body?: { message?: string } }).body?.message ?? (e as Error).message;
const blankVid = { link: "", title: "", channel_name: "", state: "BOTH", permission_note: "", permission_date: "", contact: "" };
const blankSrc = { kind: "news", name_en: "", name_te: "", site_url: "", feed_url: "", youtube_channel_id: "", stream_url: "", allow: "headline", state: "BOTH", permission_note: "", permission_date: "", contact: "" };

/**
 * Admin screen for the Media tab (S-225, S-226, S-228, S-231, S-234, S-236): sources and their permission record, member reports, silence windows and counts.
 * English only (operator tool). Nothing is shown to members from a source until its permission is recorded and a different admin switches it on.
 */
function PermissionForm({ id, onDone, say: sayIt }: { id: string; onDone: (m: string) => void; say: (e: unknown) => string }) {
  const [p, setP] = useState({ permission_note: "", permission_date: "", contact: "" });
  const [e, setE] = useState<string | null>(null);
  return (
    <div className="space-y-1 border-t border-black/30 pt-2" data-testid="ma-perm-form">
      <p className="text-xs font-bold">No permission recorded yet. Record it here; a different admin then switches the source on.</p>
      {e && <p role="alert" className="text-sm font-bold">{e}</p>}
      <Field id={`ma-pn-${id}`} label="Why we may show it (the permission, in writing, with where it is kept)"><TextInput id={`ma-pn-${id}`} data-testid="ma-pnote" value={p.permission_note} maxLength={500} onChange={(x) => setP({ ...p, permission_note: x.target.value })} /></Field>
      <Field id={`ma-pd-${id}`} label="Date the permission was given"><input id={`ma-pd-${id}`} data-testid="ma-pdate2" type="date" className={inputCls} value={p.permission_date} onChange={(x) => setP({ ...p, permission_date: x.target.value })} /></Field>
      <Field id={`ma-pc-${id}`} label="A contact at the source for takedowns"><TextInput id={`ma-pc-${id}`} data-testid="ma-pcontact" value={p.contact} maxLength={160} onChange={(x) => setP({ ...p, contact: x.target.value })} /></Field>
      <Btn data-testid="ma-psave" onClick={async () => { setE(null); try { await mediaApi.adminPermission(id, p); onDone("Permission recorded. A different admin can now switch it on."); } catch (x) { setE(sayIt(x)); } }}>Record permission</Btn>
    </div>
  );
}

export default function MediaAdmin() {
  const src = useGuarded(() => mediaApi.adminSources());
  const rep = useGuarded(() => mediaApi.adminReports());
  const win = useGuarded(() => mediaApi.windows());
  const num = useGuarded(() => mediaApi.adminNumbers());
  const [f, setF] = useState(blankSrc);
  const [v, setV] = useState(blankVid);
  const [w, setW] = useState({ label: "", starts_at: "", ends_at: "" });
  const [err, setErr] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof blankSrc, v: string) => setF((c) => ({ ...c, [k]: v }));
  const act = async (fn: () => Promise<unknown>, done: string | ((r: any) => string), reload: () => void) => { setErr(null); setMsg(null); try { const r = await fn(); setMsg(typeof done === "function" ? done(r) : done); reload(); } catch (e) { setErr(say(e)); } };

  const add = () => act(() => mediaApi.adminAddSource({ ...f, feed_url: f.kind === "news" && !f.youtube_channel_id ? f.feed_url : undefined, youtube_channel_id: f.kind === "news" && f.youtube_channel_id ? f.youtube_channel_id : undefined, site_url: f.site_url || undefined, stream_url: f.kind === "live" && f.stream_url ? f.stream_url : undefined }),
    "Source added, switched off. Record the permission, then a different admin switches it on.", () => { setF(blankSrc); src.reload(); });

  return (
    <section data-testid="media-admin" aria-labelledby="ma-h" className="space-y-6">
      <h4 id="ma-h" className="font-bold text-lg">Media admin</h4>
      <p><a href="#/" data-testid="ma-back" className="underline text-sm">Back to the app</a></p>
      <ErrorNote msg={err} />
      {msg && <p role="status" data-testid="ma-msg" className="text-sm font-bold">{msg}</p>}

      <div className="space-y-2 max-w-xl" data-testid="ma-source-form">
        <h5 className="font-bold">Add a source</h5>
        <p className="text-sm">A news outlet (we read its official feed and link to it) or a live channel (we link to its own site, and to its official stream if it gave one). It starts switched off.</p>
        <Field id="ma-kind" label="Type"><select id="ma-kind" data-testid="ma-kind" className={inputCls} value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="news">News outlet</option><option value="live">Live channel</option></select></Field>
        <Field id="ma-name" label="Name (English)"><TextInput id="ma-name" data-testid="ma-name" value={f.name_en} maxLength={80} onChange={(e) => set("name_en", e.target.value)} /></Field>
        <Field id="ma-name-te" label="Name (Telugu, optional)"><TextInput id="ma-name-te" data-testid="ma-name-te" value={f.name_te} maxLength={120} onChange={(e) => set("name_te", e.target.value)} /></Field>
        <Field id="ma-site" label="Its own website (https)"><TextInput id="ma-site" data-testid="ma-site" inputMode="url" value={f.site_url} onChange={(e) => set("site_url", e.target.value)} /></Field>
        {f.kind === "news" ? (
          <>
            <Field id="ma-feed" label="Its official feed address (RSS or Atom, https)"><TextInput id="ma-feed" data-testid="ma-feed" inputMode="url" value={f.feed_url} onChange={(e) => set("feed_url", e.target.value)} /></Field>
            <Field id="ma-yt" label="Or a YouTube channel id (starts with UC; we use YouTube's official channel feed and its own embed player. To find it: on the channel's About tab choose Share channel, then Copy channel ID)"><TextInput id="ma-yt" data-testid="ma-yt" value={f.youtube_channel_id} maxLength={24} onChange={(e) => set("youtube_channel_id", e.target.value)} /></Field>
            <Field id="ma-allow" label="What the permission allows"><select id="ma-allow" data-testid="ma-allow" className={inputCls} value={f.allow} onChange={(e) => set("allow", e.target.value)}><option value="headline">Headline and link only</option><option value="snippet">Headline, link and a short snippet</option></select></Field>
          </>
        ) : (
          <Field id="ma-stream" label={`Its official stream address (optional, https: a YouTube live link, or a file on an approved host${src.data?.hosts.length ? `: ${src.data.hosts.join(", ")}` : ""})`}><TextInput id="ma-stream" data-testid="ma-stream" inputMode="url" value={f.stream_url} onChange={(e) => set("stream_url", e.target.value)} /></Field>
        )}
        <Field id="ma-state" label="Shown for"><select id="ma-state" data-testid="ma-state" className={inputCls} value={f.state} onChange={(e) => set("state", e.target.value)}><option value="BOTH">Both states</option><option value="AP">Andhra Pradesh</option><option value="TG">Telangana</option></select></Field>
        <Field id="ma-perm" label="Why we may show it (the permission, in writing, with where it is kept)"><TextInput id="ma-perm" data-testid="ma-perm" value={f.permission_note} maxLength={500} onChange={(e) => set("permission_note", e.target.value)} /></Field>
        <Field id="ma-pdate" label="Date the permission was given"><input id="ma-pdate" data-testid="ma-pdate" type="date" className={inputCls} value={f.permission_date} onChange={(e) => set("permission_date", e.target.value)} /></Field>
        <Field id="ma-contact" label="A contact at the source for takedowns"><TextInput id="ma-contact" data-testid="ma-contact" value={f.contact} maxLength={160} onChange={(e) => set("contact", e.target.value)} /></Field>
        <Btn data-testid="ma-add" onClick={add}>Add source</Btn>
      </div>

      <div className="space-y-2 max-w-xl" data-testid="ma-video-form">
        <h5 className="font-bold">Add one YouTube video by link</h5>
        <p className="text-sm">For a single news video from a channel that gave us permission. It starts switched off; a different admin switches it on. It plays inside the Media tab, in YouTube's own player, only when a member taps Play, and is shown for 7 days.</p>
        <Field id="ma-vlink" label="YouTube video link (https)"><TextInput id="ma-vlink" data-testid="ma-vlink" inputMode="url" value={v.link} onChange={(e) => setV({ ...v, link: e.target.value })} /></Field>
        <Field id="ma-vtitle" label="Headline (type it; we do not copy it from the page)"><TextInput id="ma-vtitle" data-testid="ma-vtitle" value={v.title} maxLength={200} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field id="ma-vchan" label="Channel name (shown as the publisher)"><TextInput id="ma-vchan" data-testid="ma-vchan" value={v.channel_name} maxLength={80} onChange={(e) => setV({ ...v, channel_name: e.target.value })} /></Field>
        <Field id="ma-vperm" label="Why we may show it (the permission, in writing, with where it is kept)"><TextInput id="ma-vperm" data-testid="ma-vperm" value={v.permission_note} maxLength={500} onChange={(e) => setV({ ...v, permission_note: e.target.value })} /></Field>
        <Field id="ma-vpdate" label="Date the permission was given"><input id="ma-vpdate" data-testid="ma-vpdate" type="date" className={inputCls} value={v.permission_date} onChange={(e) => setV({ ...v, permission_date: e.target.value })} /></Field>
        <Field id="ma-vcontact" label="A contact at the channel for takedowns"><TextInput id="ma-vcontact" data-testid="ma-vcontact" value={v.contact} maxLength={160} onChange={(e) => setV({ ...v, contact: e.target.value })} /></Field>
        <Btn data-testid="ma-vadd" onClick={() => act(() => mediaApi.adminAddVideoLink({ ...v, permission_date: v.permission_date || undefined }), "Video added, switched off. A different admin switches it on.", () => { setV(blankVid); src.reload(); })}>Add video</Btn>
      </div>

      <Gate state={src.state} onRetry={src.reload}>
        <h5 className="font-bold">Sources</h5>
        <ul className="space-y-1 text-sm" data-testid="ma-sources">
          {(src.data?.sources ?? []).map((s) => (
            <li key={s.id} data-testid="ma-source" data-enabled={s.enabled ? "1" : "0"} className="border border-black/40 p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{s.name_en}</span><span>{s.kind === "news" ? "news" : "live channel"}</span><span data-testid="ma-state-label">{s.enabled ? "on" : "off"}</span>
                {s.kind === "news" && s.feed_url && <span>{s.last_error ? `last fetch failed: ${s.last_error}` : s.last_ok_at ? `last read ${new Date(s.last_ok_at).toLocaleString()}` : "not read yet"}</span>}
                {s.kind === "live" && <span>{s.health_ok === null ? "stream not checked" : s.health_ok ? "stream ok" : "stream down"}</span>}
              </div>
              {!s.enabled && !s.permission_note && <PermissionForm id={s.id} say={say} onDone={(m) => { setMsg(m); src.reload(); }} />}
              <div className="flex flex-wrap items-center gap-2">
                {!s.enabled && <Btn data-testid="ma-enable" disabled={s.mine} title={s.mine ? "A different admin must switch a source on" : undefined} onClick={() => act(() => mediaApi.adminEnable(s.id), "Switched on.", src.reload)}>Switch on</Btn>}
                {!s.enabled && s.mine && <span className="text-xs">You added this; another admin must switch it on.</span>}
                {s.enabled && <Btn secondary data-testid="ma-disable" onClick={() => act(() => mediaApi.adminDisable(s.id), "Switched off. Members no longer see it.", src.reload)}>Switch off</Btn>}
                {s.enabled && s.kind === "news" && s.feed_url && <Btn secondary data-testid="ma-refresh" onClick={() => act(() => mediaApi.adminRefresh(s.id), (r) => `Read the feed: ${r.added} new.`, src.reload)}>Read feed now</Btn>}
                {s.enabled && s.kind === "live" && s.stream_url && !/youtu/.test(s.stream_url) && <Btn secondary data-testid="ma-check" onClick={() => act(() => mediaApi.adminCheck(s.id), "Stream checked.", src.reload)}>Check stream</Btn>}
              </div>
            </li>
          ))}
        </ul>
      </Gate>

      <Gate state={rep.state} onRetry={rep.reload}>
        <h5 className="font-bold">Member reports</h5>
        <ul className="space-y-1 text-sm" data-testid="ma-reports">
          {(rep.data?.reports ?? []).map((r) => (
            <li key={r.id} data-testid="ma-report" data-status={r.status} className="border border-black/40 p-2 flex flex-wrap items-center gap-2">
              <span className="font-bold">{r.kind}</span><span>{r.reason}</span>{r.note && <span>"{r.note}"</span>}<span>{r.status === "open" ? "open" : `closed: ${r.resolution}`}</span>
              {r.status === "open" && (<>
                <Btn secondary data-testid="ma-dismiss" onClick={() => act(() => mediaApi.adminResolve(r.id, "dismiss"), "Report dismissed.", rep.reload)}>Dismiss</Btn>
                <Btn data-testid="ma-takedown" onClick={() => act(() => mediaApi.adminResolve(r.id, "takedown"), "Taken down.", () => { rep.reload(); src.reload(); })}>Take down</Btn>
              </>)}
            </li>
          ))}
        </ul>
        {!(rep.data?.reports ?? []).length && <p className="text-sm">No reports.</p>}
      </Gate>

      <Gate state={win.state} onRetry={win.reload}>
        <div className="space-y-2 max-w-xl" data-testid="ma-windows">
          <h5 className="font-bold">Silence windows</h5>
          <p className="text-sm">While a window runs, nothing new goes live in the Media tab: an approved video waits until the window ends. Use it for an election silence period or any Model Code restriction. A running window can only be ended early by a different admin.</p>
          <Field id="ma-wl" label="Label (for example: Polling silence period)"><TextInput id="ma-wl" data-testid="ma-wlabel" value={w.label} maxLength={120} onChange={(e) => setW({ ...w, label: e.target.value })} /></Field>
          <Field id="ma-ws" label="Starts"><input id="ma-ws" data-testid="ma-wstart" type="datetime-local" className={inputCls} value={w.starts_at} onChange={(e) => setW({ ...w, starts_at: e.target.value })} /></Field>
          <Field id="ma-we" label="Ends (within 14 days of the start)"><input id="ma-we" data-testid="ma-wend" type="datetime-local" className={inputCls} value={w.ends_at} onChange={(e) => setW({ ...w, ends_at: e.target.value })} /></Field>
          <Btn data-testid="ma-wadd" onClick={() => act(() => mediaApi.addWindow({ label: w.label, starts_at: w.starts_at ? new Date(w.starts_at).toISOString() : "", ends_at: w.ends_at ? new Date(w.ends_at).toISOString() : "" }), "Window added.", () => { setW({ label: "", starts_at: "", ends_at: "" }); win.reload(); })}>Add window</Btn>
          <ul className="space-y-1 text-sm">
            {(win.data?.windows ?? []).map((x) => (
              <li key={x.id} data-testid="ma-window" className="border border-black/40 p-2 flex flex-wrap items-center gap-2">
                <span className="font-bold">{x.label}</span><span>{new Date(x.starts_at).toLocaleString()} to {new Date(x.ends_at).toLocaleString()}</span>
                <Btn secondary data-testid="ma-wend-btn" onClick={() => act(() => mediaApi.endWindow(x.id), "Window ended.", win.reload)}>End window</Btn>
              </li>
            ))}
          </ul>
        </div>
      </Gate>

      <Gate state={num.state} onRetry={num.reload}>
        <h5 className="font-bold">Numbers</h5>
        <p className="text-sm">Counts of opens and plays, not people. Hidden until {num.data?.min_shown ?? 10}.</p>
        <ul className="space-y-1 text-sm" data-testid="ma-numbers">
          {(num.data?.items ?? []).map((n) => <li key={`${n.kind}-${n.item_id}`} data-testid="ma-number" className="border border-black/40 p-2"><span className="font-bold">{n.name}</span> · {n.kind} · {n.total === null ? `hidden under ${num.data?.min_shown}` : n.total}</li>)}
        </ul>
      </Gate>
    </section>
  );
}
