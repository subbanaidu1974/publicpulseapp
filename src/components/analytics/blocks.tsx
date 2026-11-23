import { analytics } from "../../api/analytics";
import type { ByElection, PartySwitch } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import type { ElectionType, StateCode } from "../../lib/states";
import { useAT } from "./analyticsText";
import { fnum } from "./common";

/** One by-election row (shared by the constituency page block and the history page). Same layout for every seat. */
export function ByElectionItem({ r, showSeat = false }: { r: ByElection; showSeat?: boolean; key?: string }) {
  const { a } = useAT();
  return (
    <li data-testid="byelection-item" className="border border-black/30 p-2 text-xs space-y-0.5">
      <div className="font-bold">{r.date} &middot; {showSeat ? `${r.state} ${r.seat} (#${r.acNo}) ` : ""}{r.kind === "re-poll" ? "re-poll" : "by-election"}{r.type === "ls" ? " (Lok Sabha)" : ""}</div>
      <div>{a("an2.h.winner")}: {r.winner}, {r.party}{r.uncontested ? ` (${a("an2.h.uncontested")})` : `, +${fnum(r.margin, "")}`}</div>
      <div>{a("an2.h.cause")}: {r.cause ?? a("an2.h.causeNone")}</div>
      <div data-testid="byelection-verified">{r.verified ? a("an2.h.verified") : a("an2.h.unverified")}</div>
      <div className="break-words">{a("an2.h.sources")}: {r.sources.map((s, i) => /^https?:/.test(s) ? <span key={s}>{i > 0 && " | "}<a className="underline" href={s} target="_blank" rel="noopener noreferrer">{s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</a></span> : <span key={s}>{i > 0 && " | "}{s}</span>)}</div>
    </li>
  );
}

/** Constituency page block: by-elections and re-polls held in this seat since 2014 (S-115). Hook for ConstituencyProfile. */
export function ByElectionsBlock({ state, acNo, type = "assembly" }: { state: StateCode; acNo: number; type?: ElectionType }) {
  const { a } = useAT();
  const s = useApi(() => analytics.byelections({ state, type, acNo }), [state, acNo, type]);
  return (
    <section data-testid="profile-byelections" className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-widest font-black">{a("an2.h.by")}</h3>
      {s.loading ? <p className="text-xs">{a("an2.loading")}</p> : s.data && s.data.records.length ? (
        <ul className="space-y-1">{s.data.records.map(r => <ByElectionItem key={r.id} r={r} />)}</ul>
      ) : <p className="text-xs font-sans">{s.error ? a("an2.error") : a("an2.h.byNone")}</p>}
    </section>
  );
}

export function PartySwitchItem({ r }: { r: PartySwitch; key?: string }) {
  const { a } = useAT();
  return (
    <li data-testid="partychange-item" className="text-xs border border-black/30 p-2 space-y-0.5">
      <div><strong>{r.person}</strong> ({r.constituency.name}, {r.state})</div>
      <div>{a("an2.pc.from")} {r.from} {a("an2.pc.to")} {r.to}; {a("an2.pc.on")} {r.date} ({r.status === "confirmed" ? a("an2.pc.status.confirmed") : a("an2.pc.status.reported")})</div>
      <div className="break-words">{r.sources.map((s, i) => <span key={s.url}>{i > 0 && " | "}<a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.publisher}</a></span>)}</div>
    </li>
  );
}

/**
 * "Party changes (cited)" section. Identical markup for every person (MCC neutrality): a heading, a note, then either the cited
 * entries or the same "none recorded" sentence. Hidden (replaced by a neutral notice) during the code-of-conduct blackout.
 */
export function PartyChangesSection({ name, state, acNo, type }: { name: string; state: StateCode; acNo?: number; type?: ElectionType }) {
  const { a, lang } = useAT();
  const s = useApi(() => analytics.partySwitches({ state, name, acNo, type }), [name, state, acNo, type]);
  return (
    <section data-testid="partychanges-section" aria-labelledby="h-partychanges" className="space-y-2 font-sans">
      <h2 id="h-partychanges" className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.pc.title")}</h2>
      <div className="text-sm space-y-1">
        {s.loading ? <p className="text-xs">{a("an2.loading")}</p> : s.data?.blackout ? (
          <p data-testid="partychanges-paused" className="text-xs">{s.data.notice ? (lang === "te" ? s.data.notice.te : s.data.notice.en) : a("an2.pc.paused")}</p>
        ) : s.data && s.data.records.length ? (
          <ul className="space-y-1">{s.data.records.map(r => <PartySwitchItem key={r.id} r={r} />)}</ul>
        ) : <p data-testid="partychanges-none" className="text-xs">{s.error ? a("an2.error") : a("an2.pc.none")}</p>}
        <p className="text-[11px] text-slate-700">{a("an2.pc.note")}</p>
      </div>
    </section>
  );
}
