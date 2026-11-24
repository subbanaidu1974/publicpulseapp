import { useEffect, useState } from "react";
import { CivicApiError, issuesApi, tokenStore, type Issue, type IssueDetail as Detail, type MyReportDetail } from "../../api/civic";
import { useT } from "../../i18n";
import { useCivicT, type CivicKey } from "./civicText";
import { useCategories } from "./categories";
import { Btn, ErrorNote } from "./ui";

const stat = (c: (k: CivicKey) => string, s: string) => (c(`c.issue.s.${s}` as CivicKey) as string | undefined) ?? s;

/**
 * Issue detail (S-139): status, timeline, responsible units, me-too, confirm/reopen and appeal where the server allows. No reporter identity is ever shown.
 * `owner` (S-157) loads the caller's OWN report from GET /issues/mine/:id, which also works while the report is held or removed: the page then says why
 * (coarse reason classes only), shows the state of any appeal and offers the appeal form when the server says can_appeal.
 */
export default function IssueDetail({ id, fallback, onBack, owner = false, onChanged }: { id: string; fallback?: Issue; onBack: () => void; owner?: boolean; onChanged?: () => void }) {
  const c = useCivicT();
  const { lang } = useT();
  const { label } = useCategories();
  const [d, setD] = useState<(Detail & Partial<MyReportDetail>) | null | undefined>(undefined);
  const fetchDetail = (): Promise<(Detail & Partial<MyReportDetail>) | null> => (owner ? issuesApi.myDetail(id) : issuesApi.detail(id));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  // Media needs the bearer token (GET /issues/media/:id), so it is fetched and shown through object URLs.
  useEffect(() => {
    let live = true; const made: string[] = [];
    setPhotoUrl(null); setVoiceUrl(null);
    const get = async (mid: string | undefined, set: (u: string | null) => void) => { if (!mid) return; const u = await issuesApi.mediaObjectUrl(mid); if (u) { made.push(u); if (live) set(u); else URL.revokeObjectURL(u); } };
    void get(d?.photoMediaId, setPhotoUrl); void get(d?.voiceMediaId, setVoiceUrl);
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [d?.photoMediaId, d?.voiceMediaId]);

  useEffect(() => {
    let live = true;
    fetchDetail().then((r) => { if (live) setD(r); }).catch(() => { if (live) setD(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, owner]);

  const act = async (fn: () => Promise<unknown>, ok: CivicKey, fail: (e: CivicApiError) => CivicKey | null = () => null) => {
    setMsg(null); setErr(null);
    try { await fn(); setMsg(c(ok)); setD(await fetchDetail()); onChanged?.(); }
    catch (e) { const k = e instanceof CivicApiError ? fail(e) : null; setErr(k ? c(k) : c("c.error")); }
  };
  const lvl = (l: string): string => { const k = `c.issue.scope${l[0].toUpperCase()}${l.slice(1)}` as CivicKey; const t = c(k) as string | undefined; return t && t !== k ? t : l; };
  const uName = (u: { nameEn: string; nameTe?: string }) => (lang === "te" ? u.nameTe ?? u.nameEn : u.nameEn);
  const when = (s?: string) => (s ? new Date(s).toLocaleString(lang === "te" ? "te-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" }) : "");

  const moderation = d?.moderation ?? "ok";
  const apStatus = d?.appeal?.status;
  const category = d?.category ?? fallback?.category ?? "other";
  const status = d?.status ?? fallback?.status ?? "";
  return (
    <section data-testid="issue-detail" aria-labelledby="idt-h" className="space-y-3 max-w-md">
      <Btn secondary data-testid="issue-back" onClick={onBack}>{c("c.issue.back")}</Btn>
      <h2 id="idt-h" className="text-xl font-bold break-words">{label(category)}</h2>
      {d === undefined && <p role="status">{c("c.loading")}</p>}
      {d === null && <p data-testid="issue-no-detail" className="text-sm">{c("c.issue.noDetail")}</p>}
      <p className="text-sm"><strong>{c("c.issue.status")}:</strong> <span data-testid="detail-status">{stat(c, status)}</span></p>
      {d && moderation !== "ok" && (
        <div className="border-2 border-black p-3 space-y-1 text-sm" data-testid="owner-moderation" role="status">
          <p className="font-bold" data-testid="owner-moderation-state">{c(moderation === "held" ? "c.issue.heldTitle" : "c.issue.takenDownTitle")}</p>
          <p>{c(moderation === "held" ? "c.issue.heldBody" : "c.issue.takenDownBody")}</p>
          {(d.moderationClasses ?? []).length > 0 && (
            <div><p className="font-bold">{c("c.issue.heldWhy")}</p>
              <ul className="list-disc ml-5" data-testid="owner-moderation-classes">{(d.moderationClasses ?? []).map((k) => <li key={k}>{c(`c.issue.cls.${k}` as CivicKey)}</li>)}</ul>
            </div>
          )}
          {d.escalated && <p>{c("c.issue.escalatedNote")}</p>}
          {apStatus && (
            <p data-testid="owner-appeal-state">{c(apStatus === "pending" ? "c.issue.appealPending" : apStatus === "approved" ? "c.issue.appealApproved" : apStatus === "rejected" ? "c.issue.appealRejected" : "c.issue.appealUpheld")}</p>
          )}
        </div>
      )}
      {d && (
        <>
          {d.department && <p className="text-sm"><strong>{c("c.issue.department")}:</strong> {d.department}</p>}
          {(lang === "te" ? d.textTe ?? d.text : d.text ?? d.textTe) && <p className="text-sm break-words" data-testid="detail-text">{lang === "te" ? d.textTe ?? d.text : d.text ?? d.textTe}</p>}
          {photoUrl && <img data-testid="detail-photo" src={photoUrl} alt={`${c("c.issue.photoAlt")}: ${label(category)}`} className="max-w-full h-auto border border-black" />}
          {voiceUrl && <div className="text-sm"><p className="font-bold">{c("c.issue.voiceNote")}</p><audio data-testid="detail-voice" controls src={voiceUrl} aria-label={c("c.issue.voiceNote")} className="w-full" /></div>}
          {(d.hasPhoto || d.hasVoice) && !photoUrl && !voiceUrl && !tokenStore.get() && <p className="text-xs" data-testid="detail-media-signin">{c("c.issue.mediaSignIn")}</p>}
          {d.units.length > 0 && (
            <div className="text-sm"><strong>{c("c.issue.units")}:</strong>
              <ul data-testid="detail-units" className="list-disc ml-5">{d.units.map((u) => <li key={u.lgd}>{uName(u)} <span className="text-xs">({lvl(u.level)}{u.level === "constituency" && d.acNo ? ` ${c("c.issue.constituencyNo")} ${d.acNo}` : ""})</span></li>)}</ul>
            </div>
          )}
          <div className="text-sm">
            <p><strong>{c("c.issue.timeline")}</strong></p>
            <ol data-testid="detail-timeline" className="list-decimal ml-5 space-y-1">
              {d.timeline.map((e, i) => <li key={i}>{stat(c, ["rerouted", "taken_down", "merged"].includes(e.type) ? e.type : e.status ?? e.type)}{e.at ? <span className="text-xs"> - {when(e.at)}</span> : null}</li>)}
            </ol>
          </div>
          {d.slaDue && d.status !== "Resolved" && d.status !== "Confirmed" && <p className="text-sm"><strong>{c("c.issue.due")}:</strong> {when(d.slaDue)}</p>}
          {d.officerResponses.length > 0 && (
            <div className="text-sm"><strong>{c("c.issue.rebuttals")}</strong>
              <ul data-testid="detail-responses" className="space-y-1">{d.officerResponses.map((r, i) => <li key={i} className="border border-black p-2 break-words">{r.text}{r.officerTag ? <span className="block text-xs">{r.officerTag}{r.at ? " - " + when(r.at) : ""}</span> : null}</li>)}</ul>
            </div>
          )}
          {d.officialReply && (
            <section data-testid="official-reply" aria-labelledby="or-h" className="border-2 border-black p-3 space-y-2 text-sm">
              <p id="or-h" className="font-bold">{c("c.rep.label")} {lang === "te" ? d.officialReply.constituencyTe ?? d.officialReply.constituencyEn : d.officialReply.constituencyEn}</p>
              <p className="break-words whitespace-pre-line" data-testid="official-reply-text">{d.officialReply.text}</p>
              {d.officialReply.tags.length > 0 && (
                <ul data-testid="official-reply-tags" className="flex flex-wrap gap-1">{d.officialReply.tags.map((t) => <li key={t.id} className="border border-black px-2 py-1 text-xs">{lang === "te" ? t.labelTe : t.labelEn}</li>)}</ul>
              )}
              <p className="text-xs">{c("c.rep.posted")}: {when(d.officialReply.postedAt)}{d.officialReply.edited ? ` - ${c("c.rep.updated")}: ${when(d.officialReply.updatedAt)}` : ""}</p>
              {d.officialReply.history.length > 0 && (
                <details data-testid="official-reply-history" className="text-xs">
                  <summary>{c("c.rep.edited")} ({d.officialReply.history.length})</summary>
                  <ol className="space-y-1 mt-1">{d.officialReply.history.map((h) => <li key={h.version} className="border border-black p-2 break-words">{c("c.rep.version")} {h.version}{h.at ? ` - ${when(h.at)}` : ""}<br />{h.text}</li>)}</ol>
                </details>
              )}
              <p className="text-xs">{c("c.rep.note")}</p>
            </section>
          )}
          <div className="flex items-center gap-3 flex-wrap text-sm">
            {moderation === "ok" && <Btn data-testid="issue-metoo" onClick={() => void act(() => issuesApi.meToo(id), "c.issue.meTooDone", (e) => (e.status === 429 ? "c.issue.meTooLimit" : null))}>{c("c.issue.meToo")}</Btn>}
            <span data-testid="detail-metoo-count">{d.supportCount} {c("c.issue.meTooCount")}</span>
          </div>
          {d.canConfirm && status === "Resolved" && (
            <div className="space-y-2 text-sm" role="group" aria-label={c("c.issue.confirmAsk")}>
              <p className="font-bold">{c("c.issue.confirmAsk")}</p>
              <div className="flex gap-2 flex-wrap">
                <Btn data-testid="issue-confirm" onClick={() => void act(() => issuesApi.confirm(id, "confirm"), "c.issue.thanks", (e) => (e.status === 403 ? "c.issue.notSampled" : null))}>{c("c.issue.confirm")}</Btn>
                <Btn secondary data-testid="issue-reopen" onClick={() => void act(() => issuesApi.confirm(id, "reopen"), "c.issue.thanks", (e) => (e.status === 403 ? "c.issue.notSampled" : null))}>{c("c.issue.reopen")}</Btn>
              </div>
            </div>
          )}
          {/* The public route never sets can_appeal; the owner view (GET /issues/mine/:id) does, for a held or removed report with no appeal pending. */}
          {d.canAppeal && (
            <form className="space-y-2 text-sm" data-testid="issue-appeal" onSubmit={(e) => { e.preventDefault(); void act(() => issuesApi.appeal(id, reason).then(() => setReason("")), "c.issue.appealSent", () => "c.issue.appealFail"); }}>
              <label htmlFor="ia-reason" className="block font-bold">{c("c.issue.appealWhy")}</label>
              <textarea id="ia-reason" className="w-full border border-black p-2" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="submit" className="min-h-[44px] px-4 border border-black bg-black text-white font-bold" disabled={reason.trim().length < 3}>{c("c.issue.appeal")}</button>
            </form>
          )}
        </>
      )}
      {msg && <p role="status" data-testid="issue-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}
