import { ReactNode, useState } from "react";
import type { PartyMedia, PartyRef, PhotoOut } from "../../api/people";
import { peopleApi } from "../../api/people";
import { ApiError } from "../../api/client";
import partyMedia from "../../../data/reference/people/party-media.json";
import { partyColor } from "../../lib/parties";
import { usePT } from "./peopleText";

/** Hash routes for the people pages: #/people, #/people/party/TDP, #/people/candidate/<id>, #/people/leaders, #/people/members/AP/assembly, #/people/process */
export const peopleHref = (...parts: (string | number)[]) => "#/people" + (parts.length ? "/" + parts.map(p => encodeURIComponent(String(p))).join("/") : "");

const MEDIA = (partyMedia as { entries: Record<string, PartyMedia> }).entries;
/** The shipped flag (preferred) or symbol for a party code, or null when no verified free file exists. */
export function mediaFor(code: string): PartyMedia | null {
  return MEDIA[`${code}-flag`] ?? MEDIA[`${code}-symbol`] ?? null;
}

/** Credit popover: author, licence and source, plus the identification-only caption. Native <details>, so it works without JS and by keyboard. */
export function CreditPopover({ author, licence, licenceUrl, source, caption, label, testId }: {
  author: string; licence: string; licenceUrl: string | null; source: string; caption?: string; label: string; testId?: string;
}) {
  const { p } = usePT();
  return (
    <details data-testid={testId} className="inline-block text-[10px] font-sans align-top">
      <summary className="cursor-pointer underline decoration-dotted select-none" aria-label={label}>{label}</summary>
      <div className="mt-1 border border-black bg-[#FAF8F5] text-[#121212] p-2 max-w-[18rem] space-y-1 normal-case tracking-normal">
        <p>{p("ppl.photo.by")} {author}</p>
        <p>{p("ppl.photo.licence")}: {licenceUrl ? <a className="underline" href={licenceUrl} target="_blank" rel="noopener noreferrer">{licence}</a> : licence}</p>
        <p><a className="underline" href={source} target="_blank" rel="noopener noreferrer">{p("ppl.photo.source")}</a></p>
        {caption && <p className="font-bold">{caption}</p>}
      </div>
    </details>
  );
}

/**
 * Party chip. A flag/symbol image appears only when party-media.json holds a licence-verified file for it
 * (and `media` is requested); otherwise the chip is text with the registry colour. The code/name is always shown (colour is never the only cue).
 */
export function PartyChip({ party, media = false, href = true, lang = "en" }: { party: PartyRef; media?: boolean; href?: boolean; lang?: "en" | "te" }) {
  const { p } = usePT();
  const m = media ? mediaFor(party.code) : null;
  const color = party.color || partyColor(party.code);
  const label = lang === "te" && party.nameTe ? party.nameTe : party.name;
  const inner = (
    <span data-testid={`party-chip-${party.code}`} className="inline-flex items-center gap-1.5 border-2 px-1.5 py-0.5 text-[11px] font-sans font-bold bg-white text-[#121212]" style={{ borderColor: color }}>
      {m && <img data-testid={`party-media-${party.code}`} src={m.path} alt="" width={18} height={18} className="h-[18px] w-auto object-contain" loading="lazy" />}
      <span>{party.code}{" "}</span>
      <span className="font-normal hidden sm:inline">{label}</span>
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {href && party.code !== "OTH" ? <a href={peopleHref("party", party.code)} aria-label={`${party.code} ${label}`}>{inner}</a> : inner}
      {m && (
        <CreditPopover testId={`party-credit-${party.code}`} label={p("ppl.party.credit")} author={m.author} licence={m.licence} licenceUrl={m.licenceUrl} source={m.source}
          caption={m.use === "identification-only" ? p("ppl.party.identonly") : undefined} />
      )}
    </span>
  );
}

/** Photo with credit, or the same neutral initials avatar for everyone else. */
export function PersonAvatar({ initials, photo, size = 64 }: { initials: string; photo: PhotoOut | null; size?: number }) {
  const { p } = usePT();
  return (
    <div className="inline-flex flex-col items-start gap-1">
      {photo ? (
        <img data-testid="person-photo" src={photo.src} alt="" width={size} height={size} style={{ width: size, height: size }} className="object-cover border border-black bg-white" loading="lazy" />
      ) : (
        <div data-testid="person-initials" aria-hidden="true" style={{ width: size, height: size }} className="border border-black bg-black/5 flex items-center justify-center font-sans font-black text-lg text-[#121212]">{initials}</div>
      )}
      {photo && <CreditPopover testId="photo-credit" label={p("ppl.photo.credit")} author={photo.author} licence={photo.licence} licenceUrl={photo.licenceUrl} source={photo.source} />}
    </div>
  );
}

export function BlackoutNotice({ notice }: { notice: { en: string; te: string } | null }) {
  const { p, lang } = usePT();
  if (!notice) return null;
  return (
    <div data-testid="blackout-notice" role="status" className="border border-black bg-black/5 p-3 text-xs font-sans">
      <strong className="block">{p("ppl.blackout.title")}</strong>
      {lang === "te" ? notice.te : notice.en}
    </div>
  );
}

/**
 * The shared page frame for candidate, party and leader pages. Section order is FIXED by the caller's `sections` list,
 * and every section renders even when empty, so no page can differ in layout from another (MCC neutrality; tested).
 */
export function ProfileShell({ kind, title, sub, sections, report, back }: {
  kind: "candidate" | "party" | "leaders" | "members"; title: ReactNode; sub?: ReactNode;
  sections: { id: string; heading: string; body: ReactNode }[]; report?: ReactNode; back?: boolean;
}) {
  const { p } = usePT();
  return (
    <article data-testid={`profile-${kind}`} data-layout={kind} className="space-y-6 font-sans">
      {back !== false && <a data-testid="people-back" href={peopleHref()} className="text-xs underline">{p("ppl.back")}</a>}
      <header className="border-b border-black pb-3 space-y-2">
        <h1 data-testid="profile-title" className="font-serif text-3xl sm:text-4xl break-words">{title}</h1>
        {sub && <div className="text-sm">{sub}</div>}
      </header>
      {sections.map(s => (
        <section key={s.id} data-testid={`section-${s.id}`} aria-labelledby={`h-${kind}-${s.id}`} className="space-y-2">
          <h2 id={`h-${kind}-${s.id}`} className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{s.heading}</h2>
          <div className="text-sm">{s.body}</div>
        </section>
      ))}
      {report}
    </article>
  );
}

/** "Report / correct this": no login, optional contact, honeypot, visible SLA. */
export function ReportControl({ page, photoKey }: { page: string; photoKey?: string }) {
  const { p } = usePT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("correction");
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [hide, setHide] = useState(true);
  const [trap, setTrap] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error" | "toomany" | "short">("idle");
  const [result, setResult] = useState<{ slaDays?: number; hidden?: boolean }>({});

  async function send() {
    if (reason.trim().length < 10) { setState("short"); return; }
    setState("sending");
    try {
      const wantsHide = kind === "takedown" && !!photoKey && hide;
      const r = await peopleApi.report({
        kind, page, reason, contact: contact || undefined, website: trap || undefined,
        ...(wantsHide ? { targetKind: "photo", targetKey: photoKey } : {}),
      });
      setResult({ slaDays: r.slaDays, hidden: r.hiddenPendingReview });
      setState("done");
    } catch (e) {
      setState(e instanceof ApiError && e.status === 429 ? "toomany" : "error");
    }
  }

  if (!open) {
    return (
      <div className="border-t border-black/20 pt-3">
        <button data-testid="report-open" type="button" onClick={() => setOpen(true)} className="border border-black px-3 py-1.5 text-[11px] font-black uppercase tracking-widest cursor-pointer">{p("ppl.report.open")}</button>
        {" "}<a href={peopleHref("process")} className="text-xs underline">{p("ppl.process")}</a>
      </div>
    );
  }
  if (state === "done") {
    return (
      <div data-testid="report-done" role="status" className="border border-black p-3 text-sm space-y-1">
        <p>{p("ppl.report.thanks")} {result.slaDays} {p("ppl.report.days")}.</p>
        {result.hidden && <p>{p("ppl.report.hidden")}</p>}
      </div>
    );
  }
  return (
    <form data-testid="report-form" className="border border-black p-3 space-y-3 text-sm max-w-xl" onSubmit={e => { e.preventDefault(); void send(); }}>
      <h3 className="font-black text-xs uppercase tracking-widest">{p("ppl.report.title")}</h3>
      <label className="block text-xs font-bold">{p("ppl.report.kind")}
        <select data-testid="report-kind" value={kind} onChange={e => setKind(e.target.value)} className="block mt-1 border border-black bg-white px-2 py-1 text-sm font-normal">
          <option value="correction">{p("ppl.report.kind.correction")}</option>
          <option value="takedown">{p("ppl.report.kind.takedown")}</option>
          <option value="other">{p("ppl.report.kind.other")}</option>
        </select>
      </label>
      <label className="block text-xs font-bold">{p("ppl.report.reason")}
        <textarea data-testid="report-reason" required minLength={10} maxLength={2000} rows={4} value={reason} onChange={e => setReason(e.target.value)} className="block mt-1 w-full border border-black bg-white px-2 py-1 text-sm font-normal" />
      </label>
      <label className="block text-xs font-bold">{p("ppl.report.contact")}
        <input data-testid="report-contact" maxLength={200} value={contact} onChange={e => setContact(e.target.value)} autoComplete="off" className="block mt-1 w-full border border-black bg-white px-2 py-1 text-sm font-normal" />
        <span className="block font-normal text-[11px] text-black/70">{p("ppl.report.contact.hint")}</span>
      </label>
      {kind === "takedown" && photoKey && (
        <label className="flex items-start gap-2 text-xs"><input data-testid="report-hide" type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} className="mt-0.5" />{p("ppl.report.hidephoto")}</label>
      )}
      {/* honeypot: hidden from people and assistive tech; bots fill it */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label>Website<input tabIndex={-1} autoComplete="off" name="website" value={trap} onChange={e => setTrap(e.target.value)} /></label>
      </div>
      {state === "short" && <p role="alert" className="text-xs text-red-800">{p("ppl.report.short")}</p>}
      {state === "error" && <p role="alert" className="text-xs text-red-800">{p("ppl.report.error")}</p>}
      {state === "toomany" && <p role="alert" className="text-xs text-red-800">{p("ppl.report.toomany")}</p>}
      <div className="flex gap-2">
        <button data-testid="report-send" disabled={state === "sending"} type="submit" className="border border-black bg-black text-[#FAF8F5] px-4 py-1.5 text-[11px] font-black uppercase tracking-widest cursor-pointer disabled:opacity-60">{p("ppl.report.send")}</button>
        <button type="button" onClick={() => setOpen(false)} className="border border-black px-4 py-1.5 text-[11px] font-black uppercase tracking-widest cursor-pointer">{p("ppl.report.cancel")}</button>
      </div>
    </form>
  );
}
