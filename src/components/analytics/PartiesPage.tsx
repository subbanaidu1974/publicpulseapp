import { analytics } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { partyColor } from "../../lib/parties";
import type { ElectionType } from "../../lib/states";
import { useAT } from "./analyticsText";
import { SourceBanner, Wait, fnum, fpct } from "./common";

/**
 * Parties (S-195): for each party that won a seat or took at least 1% of the vote, its seats, votes and vote share in every election in the
 * dataset, for the selected state. Built only from published results and the reviewed party registry. Descriptive; nothing is ranked as better.
 */
export default function PartiesPage() {
  const { a, lang } = useAT();
  const { state, config } = useStateCtx();
  const s = useApi(() => analytics.parties(state), [state]);
  const na = a("an2.na");
  const typeLabel = (t: ElectionType) => (t === "assembly" ? a("an2.assembly") : a("an2.ls"));
  return (
    <section data-testid="parties-page" className="space-y-4 font-sans">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.p.title")} - {lang === "te" ? config.nameTe ?? config.name : config.name}</h2>
      <Wait s={s}>
        {s.data && (
          <>
            <SourceBanner source={s.data.source} demo={s.data.demo} />
            <ul className="text-[11px] list-disc pl-5 space-y-1" data-testid="parties-notes">
              {s.data.notes.map((n) => <li key={n}>{n}</li>)}
              {s.data.omitted > 0 && <li>{a("an2.p.omitted").replace("{n}", String(s.data.omitted))}</li>}
            </ul>
            <div className="space-y-4">
              {s.data.parties.map((p) => (
                <article key={p.code} data-testid="party-card" data-party={p.code} className="border border-black p-3 space-y-2">
                  <header className="flex flex-wrap items-center gap-2">
                    <span aria-hidden="true" className="inline-block w-3 h-3 shrink-0" style={{ background: partyColor(p.code) }} />
                    <h3 className="font-bold text-sm">{p.code}</h3>
                    <span className="text-xs">{(lang === "te" && p.name.te) || p.name.en}</span>
                  </header>
                  <p className="text-[11px]" data-testid="party-facts">
                    {p.registered
                      ? <>{a("an2.p.founded")}: {p.foundedYear ?? na}{p.website && <> &middot; <a className="underline" href={p.website} target="_blank" rel="noopener noreferrer">{p.website.replace(/^https?:\/\//, "")}</a></>}</>
                      : a("an2.p.minor")}
                    {" "}&middot; {a("an2.p.total")}: <strong>{p.totalSeats}</strong>
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <caption className="sr-only">{p.code}</caption>
                      <thead><tr>{[a("an2.year"), a("an2.type"), a("an2.p.seats"), a("an2.p.contested"), a("an2.p.polled"), a("an2.p.share")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
                      <tbody>
                        {p.rows.map((r) => (
                          <tr key={`${r.year}-${r.type}`} data-testid="party-row">
                            <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{r.year}</th>
                            <td className="border-b border-black/10 py-1 pr-3">{typeLabel(r.type)}</td>
                            <td className="border-b border-black/10 py-1 pr-3 font-mono">{r.seats}</td>
                            <td className="border-b border-black/10 py-1 pr-3 font-mono">{r.contested}</td>
                            <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(r.votes, na)}</td>
                            <td className="border-b border-black/10 py-1 pr-3 font-mono">{fpct(r.sharePct, na)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Wait>
    </section>
  );
}
