import { useMemo, useState } from "react";
import { analytics } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { partyColor } from "../../lib/parties";
import type { PanchayatLevel } from "../../lib/panchayat";
import { useAT, type AKey } from "./analyticsText";
import { Wait, fnum } from "./common";

/**
 * Panchayat elections (S-203, S-219). Party totals per election from the secondary source named on the page (English Wikipedia, CC BY-SA 4.0);
 * no commission data and no unit-level results are loaded yet. Every card shows its caveats and the page and revision it came from.
 * See docs/PANCHAYAT_DATA.md.
 */
const CODE: Record<string, string> = { BRS: "BRS", TRS: "BRS", INC: "INC", BJP: "BJP", TDP: "TDP", YSRCP: "YSRCP", JSP: "JSP" };
const colourFor = (party: string) => (CODE[party.split(" ")[0]] ? partyColor(CODE[party.split(" ")[0]]) : "#6b7280");

export default function PanchayatPage() {
  const { a, lang } = useAT();
  const { state, config } = useStateCtx();
  const s = useApi(() => analytics.panchayat(state), [state]);
  const [level, setLevel] = useState<"all" | PanchayatLevel>("all");
  const levelName = (l: string) => a(`an2.pn.level.${l}` as AKey);
  const shown = useMemo(() => (s.data?.elections ?? []).filter((e) => level === "all" || e.level === level), [s.data, level]);
  const chip = (on: boolean) => `px-2 py-1 text-xs border border-black min-h-[32px] ${on ? "bg-black text-white" : "bg-white"}`;
  return (
    <section data-testid="panchayat-page" className="space-y-4 font-sans">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.pn.title")} - {lang === "te" ? config.nameTe ?? config.name : config.name}</h2>
      <Wait s={s}>
        {s.data && (
          <>
            {!s.data.loaded ? (
              <div data-testid="panchayat-empty" role="status" className="border border-dashed border-black p-4 space-y-2">
                <p className="font-bold">{a("an2.pn.empty")}</p>
                <p className="text-sm">{a("an2.pn.emptyWhy")}</p>
                {s.data.problems.length > 0 && (
                  <div data-testid="panchayat-problems" className="text-xs border border-black p-2">
                    <p className="font-bold">{a("an2.pn.problems")}</p>
                    <ul className="list-disc pl-5">{s.data.problems.slice(0, 10).map((x) => <li key={x}>{x}</li>)}</ul>
                  </div>
                )}
              </div>
            ) : (
              <div data-testid="panchayat-banner" role="note" className="border border-black bg-amber-50 p-3 text-sm space-y-1">
                <p className="font-bold">{a("an2.pn.banner")}</p>
                <p className="text-xs">{a("an2.pn.bannerWhy")}</p>
                <p data-testid="panchayat-source" className="text-[11px]">
                  {a("an2.pn.source")}: {[s.data.source, ...s.data.otherSources].filter((x): x is NonNullable<typeof x> => !!x).map((x, i) => (
                    <span key={x.publisher}>{i > 0 ? "; " : ""}<a className="underline" href={x.url} target="_blank" rel="noopener noreferrer">{x.publisher.split(" (")[0].split(",")[0]}</a>, {x.licence.split(":")[0]}</span>
                  ))}, {s.data.source?.retrieved}
                </p>
              </div>
            )}

            <div role="group" aria-label={a("an2.pn.level")} className="flex flex-wrap">
              <button type="button" data-testid="panchayat-filter-all" aria-pressed={level === "all"} onClick={() => setLevel("all")} className={chip(level === "all")}>{a("an2.pn.all")}</button>
              {s.data.levels.map((l) => (
                <button key={l} type="button" data-testid={`panchayat-filter-${l}`} aria-pressed={level === l} onClick={() => setLevel(l)} className={chip(level === l)}>{levelName(l)}</button>
              ))}
            </div>

            <ul data-testid="panchayat-levels" className="grid gap-2 sm:grid-cols-3">
              {s.data.levels.map((l) => {
                const yrs = s.data!.elections.filter((e) => e.level === l).map((e) => e.year);
                return (
                  <li key={l} data-testid="panchayat-level" data-level={l} className="border border-black p-3 space-y-1 bg-white">
                    <strong className="block text-sm">{levelName(l)}</strong>
                    <span className="block text-[11px]">{a(`an2.pn.desc.${l}` as AKey)}</span>
                    <span className="block text-[11px] font-mono">{yrs.length === 0 ? a("an2.pn.none") : [...new Set(yrs)].join(", ")}</span>
                  </li>
                );
              })}
            </ul>

            {s.data.loaded && shown.length === 0 && <p className="text-sm border border-dashed border-black/40 p-3">{a("an2.pn.noneLevel")}</p>}

            <div className="grid gap-4 lg:grid-cols-2">
              {shown.map((e) => {
                const top = Math.max(1, ...e.tallies.map((t) => t.wonMax ?? t.won));
                return (
                  <article key={e.id} data-testid="panchayat-card" data-election={e.id} className="border border-black bg-white p-3 space-y-2 min-w-0">
                    <header>
                      <h3 className="font-black text-base">{levelName(e.level)} {e.year}</h3>
                      <p className="text-[11px]">
                        {e.period}{e.scope ? <> &middot; {e.scope}</> : null}
                        {e.posts != null && <> &middot; {a("an2.pn.posts")}: <strong>{fnum(e.posts, a("an2.na"))}</strong></>}
                        {e.unopposed != null && <> &middot; {a("an2.pn.unopp")}: <strong>{fnum(e.unopposed, a("an2.na"))}</strong></>}
                      </p>
                    </header>
                    {e.tallies.length > 0 && (
                      <table data-testid="panchayat-tally" className="w-full text-left border-collapse text-xs">
                        <caption className="sr-only">{levelName(e.level)} {e.year}</caption>
                        <thead><tr><th scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{a("an2.pn.party")}</th><th scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{a("an2.pn.won")}</th></tr></thead>
                        <tbody>
                          {e.tallies.map((t) => (
                            <tr key={t.party} data-testid="panchayat-tally-row">
                              <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{t.party}</th>
                              <td className="border-b border-black/10 py-1 pr-3 font-mono w-full">
                                <span>{fnum(t.won, a("an2.na"))}{t.wonMax != null && t.wonMax !== t.won ? ` ${a("an2.pn.to")} ${fnum(t.wonMax, a("an2.na"))}` : ""}</span>
                                <span aria-hidden="true" className="block h-1.5 mt-0.5" style={{ width: `${Math.max(1, ((t.wonMax ?? t.won) / top) * 100)}%`, background: colourFor(t.party) }} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {e.phases.length > 0 && (
                      <p data-testid="panchayat-phases" className="text-[11px]">
                        {a("an2.pn.phases")}: {e.phases.map((p, i) => `${i + 1}) ${p.date}${p.turnoutPct != null ? `, ${a("an2.pn.turnout")} ${p.turnoutPct}%` : ""}`).join("; ")}
                      </p>
                    )}
                    {e.caveats.length > 0 && (
                      <details open data-testid="panchayat-caveats" className="text-[11px]">
                        <summary className="cursor-pointer font-bold">{a("an2.pn.caveats")}</summary>
                        <ul className="list-disc pl-5 space-y-1 mt-1">{e.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
                      </details>
                    )}
                    {e.evidence && (
                      <div className="text-[11px] space-y-1" data-testid="panchayat-evidence">
                        {e.evidence.kind === "wikipedia" ? (
                          <p>{a("an2.pn.evidence")}: <a className="underline" href={e.evidence.url} target="_blank" rel="noopener noreferrer">{e.evidence.url.replace(/^https?:\/\/en\.wikipedia\.org\/wiki\//, "").replace(/_/g, " ")}</a> ({a("an2.pn.revision")} {e.evidence.revision}). {e.evidence.cites}.</p>
                        ) : (
                          <>
                            <p data-testid="panchayat-news">{a("an2.pn.newsRead")}: {e.evidence.cites}.</p>
                            <ul className="list-disc pl-5">
                              <li><a className="underline" href={e.evidence.url} target="_blank" rel="noopener noreferrer">{e.evidence.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</a></li>
                              {(e.evidence.also ?? []).map((x) => <li key={x.url}><a className="underline" href={x.url} target="_blank" rel="noopener noreferrer">{x.publisher}</a>, {x.date}</li>)}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            <ul className="text-[11px] list-disc pl-5 space-y-1" data-testid="panchayat-notes">{s.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        )}
      </Wait>
    </section>
  );
}
