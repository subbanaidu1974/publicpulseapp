import { useMemo, useState } from "react";
import { analytics } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { partyColor } from "../../lib/parties";
import { fetchLeaderPhotos } from "../../api/geo";
import type { ElectionType } from "../../lib/states";
import { useAT } from "./analyticsText";
import { SourceBanner, Wait, fnum, fpct } from "./common";
import { CreditPopover, mediaFor } from "../people/common";
import { usePT } from "../people/peopleText";

type Sort = "seats" | "share" | "name";
type TypeFilter = "all" | ElectionType;

/**
 * Parties (S-195, redesigned in S-202): for each party that won a seat or took at least 1% of the vote, its seats, votes and vote share in every
 * election in the dataset, for the selected state. Built only from published results and the reviewed party registry. Descriptive; the sort
 * options are plain orderings (seats, vote share, name) and nothing is ranked as better.
 */
export default function PartiesPage() {
  const { a, lang } = useAT();
  const { p: pt } = usePT();
  const { state, config } = useStateCtx();
  const leaders = useApi(() => fetchLeaderPhotos().catch(() => []), []);
  const s = useApi(() => analytics.parties(state), [state]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("seats");
  const [type, setType] = useState<TypeFilter>("all");
  const na = a("an2.na");
  const typeLabel = (t: ElectionType) => (t === "assembly" ? a("an2.assembly") : a("an2.ls"));

  const view = useMemo(() => {
    const all = s.data?.parties ?? [];
    const needle = q.trim().toLowerCase();
    const shown = all
      .map((p) => {
        const rows = p.rows.filter((r) => type === "all" || r.type === type);
        const latest = rows.reduce<(typeof rows)[number] | null>((m, r) => (!m || r.year > m.year || (r.year === m.year && r.type < m.type) ? r : m), null);
        return { p, rows, latest, seats: rows.reduce((n, r) => n + r.seats, 0) };
      })
      .filter((x) => x.rows.length > 0)
      .filter((x) => !needle || x.p.code.toLowerCase().includes(needle) || x.p.name.en.toLowerCase().includes(needle) || (x.p.name.te ?? "").includes(q.trim()));
    shown.sort((x, y) => sort === "name" ? x.p.code.localeCompare(y.p.code)
      : sort === "share" ? (y.latest?.sharePct ?? -1) - (x.latest?.sharePct ?? -1) || y.seats - x.seats
      : y.seats - x.seats || x.p.code.localeCompare(y.p.code));
    return { all, shown };
  }, [s.data, q, sort, type]);

  const years = useMemo(() => {
    const ys = new Set<number>();
    (s.data?.parties ?? []).forEach((p) => p.rows.forEach((r) => ys.add(r.year)));
    return [...ys].sort((x, y) => x - y);
  }, [s.data]);

  const chip = (on: boolean) => `px-2 py-1 text-xs border border-black min-h-[32px] ${on ? "bg-black text-white" : "bg-white"}`;

  return (
    <section data-testid="parties-page" className="space-y-4 font-sans">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.p.title")} - {lang === "te" ? config.nameTe ?? config.name : config.name}</h2>
      <Wait s={s}>
        {s.data && (
          <>
            <SourceBanner source={s.data.source} demo={s.data.demo} />

            <p data-testid="parties-summary" className="text-sm">
              <strong>{view.all.length}</strong> {a("an2.p.sumParties")}
              {years.length > 0 && <> &middot; {a("an2.p.sumYears").replace("{a}", String(years[0])).replace("{b}", String(years[years.length - 1]))}</>}
            </p>

            <div data-testid="parties-toolbar" className="flex flex-wrap items-end gap-3 border border-black/30 p-2 bg-slate-50 sticky top-0 z-10">
              <label className="text-xs space-y-1 grow min-w-[10rem]">
                <span className="block font-bold">{a("an2.p.search")}</span>
                <input data-testid="parties-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={a("an2.p.searchPh")}
                  className="w-full border border-black px-2 py-1 text-sm min-h-[32px] bg-white" />
              </label>
              <label className="text-xs space-y-1">
                <span className="block font-bold">{a("an2.p.sort")}</span>
                <select data-testid="parties-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="border border-black px-2 py-1 text-sm min-h-[32px] bg-white">
                  <option value="seats">{a("an2.p.sortSeats")}</option>
                  <option value="share">{a("an2.p.sortShare")}</option>
                  <option value="name">{a("an2.p.sortName")}</option>
                </select>
              </label>
              <div role="group" aria-label={a("an2.type")} className="flex">
                {(["all", "assembly", "ls"] as const).map((t) => (
                  <button key={t} type="button" data-testid={`parties-type-${t}`} aria-pressed={type === t} onClick={() => setType(t)} className={chip(type === t)}>
                    {t === "all" ? a("an2.p.typeAll") : typeLabel(t)}
                  </button>
                ))}
              </div>
              <p className="text-xs" role="status" data-testid="parties-count">{a("an2.p.showing").replace("{n}", String(view.shown.length)).replace("{m}", String(view.all.length))}</p>
            </div>

            <details className="text-[11px]" data-testid="parties-notes-box">
              <summary className="cursor-pointer font-bold">{a("an2.p.notes")}</summary>
              <ul className="list-disc pl-5 space-y-1 mt-1" data-testid="parties-notes">
                {s.data.notes.map((n) => <li key={n}>{n}</li>)}
                {s.data.omitted > 0 && <li>{a("an2.p.omitted").replace("{n}", String(s.data.omitted))}</li>}
              </ul>
            </details>

            {view.shown.length === 0 && <p data-testid="parties-empty" className="text-sm border border-dashed border-black/40 p-3">{a("an2.p.empty")}</p>}

            <div className="grid gap-4 lg:grid-cols-2">
              {view.shown.map(({ p, rows, latest, seats }) => {
                const m = mediaFor(p.code);
                const l = (leaders.data ?? []).find((x) => x.party === p.code);
                const colour = partyColor(p.code);
                const maxShare = Math.max(1, ...rows.map((r) => r.sharePct ?? 0));
                return (
                  <article key={p.code} data-testid="party-card" data-party={p.code} className="border border-black bg-white" style={{ borderTop: `6px solid ${colour}` }}>
                    <header className="flex items-start gap-3 p-3">
                      {m ? (
                        <div data-testid="party-flag" className="shrink-0 space-y-1">
                          <img src={m.path} alt={`${p.name.en}, ${m.use === "identification-only" ? pt("ppl.party.identonly") : ""}`.replace(/, $/, "")} height={48} className="h-12 w-auto max-w-[6rem] object-contain border border-black/30 bg-white" loading="lazy" />
                          <CreditPopover testId={`party-flag-credit-${p.code}`} label={pt("ppl.party.credit")} author={m.author} licence={m.licence} licenceUrl={m.licenceUrl} source={m.source}
                            caption={m.use === "identification-only" ? pt("ppl.party.identonly") : undefined} />
                        </div>
                      ) : (
                        <span aria-hidden="true" className="shrink-0 w-12 h-12 grid place-items-center text-xs font-black text-white" style={{ background: colour }}>{p.code.slice(0, 3)}</span>
                      )}
                      <div className="min-w-0 grow">
                        <h3 className="font-black text-lg leading-tight">{p.code}</h3>
                        <p className="text-xs">{(lang === "te" && p.name.te) || p.name.en}</p>
                        <p className="text-[11px] mt-1" data-testid="party-facts">
                          {p.registered
                            ? <>{a("an2.p.founded")}: {p.foundedYear ?? na}{p.website && <> &middot; <a className="underline" href={p.website} target="_blank" rel="noopener noreferrer">{p.website.replace(/^https?:\/\//, "")}</a></>}</>
                            : a("an2.p.minor")}
                          {" "}&middot; {a("an2.p.total")}: <strong>{p.totalSeats}</strong>
                        </p>
                      </div>
                      {l && (
                        <figure data-testid="party-leader" className="shrink-0 w-24 text-center">
                          <img src={`/api/v1/photos/${l.file}`} alt={`${l.name}, ${l.role}`} width={64} height={80} loading="lazy" className="w-16 h-auto mx-auto border border-black object-cover" />
                          <figcaption className="text-[10px] text-slate-600 text-left mt-1">
                            <strong className="block text-black">{l.name}</strong>{l.role}
                            <details className="mt-1">
                              <summary className="cursor-pointer underline">{a("an2.p.photoCredit")}</summary>
                              {a("an2.p.photoBy")} {l.author ?? a("an2.p.photoUnknown")}, <a className="underline" href={l.licenceUrl ?? l.source} rel="noopener noreferrer" target="_blank">{l.licence}</a>, <a className="underline" href={l.source} rel="noopener noreferrer" target="_blank">Wikimedia Commons</a>. {a("an2.p.leaderNote")}
                            </details>
                          </figcaption>
                        </figure>
                      )}
                    </header>

                    <dl data-testid="party-stats" className="grid grid-cols-3 border-y border-black/20 text-center">
                      <div className="p-2"><dt className="text-[10px] uppercase tracking-wide">{a("an2.p.latest")}{latest ? ` (${latest.year})` : ""}</dt><dd className="font-black text-lg">{latest ? latest.seats : na}</dd></div>
                      <div className="p-2 border-x border-black/20"><dt className="text-[10px] uppercase tracking-wide">{a("an2.p.share")}</dt><dd className="font-black text-lg">{latest ? fpct(latest.sharePct, na) : na}</dd></div>
                      <div className="p-2"><dt className="text-[10px] uppercase tracking-wide">{a("an2.p.seatsShown")}</dt><dd className="font-black text-lg">{seats}</dd></div>
                    </dl>

                    <div className="overflow-x-auto p-3">
                      <table className="w-full text-left border-collapse text-xs">
                        <caption className="sr-only">{p.code}</caption>
                        <thead><tr>{[a("an2.year"), a("an2.type"), a("an2.p.seats"), a("an2.p.contested"), a("an2.p.polled"), a("an2.p.share")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={`${r.year}-${r.type}`} data-testid="party-row">
                              <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{r.year}</th>
                              <td className="border-b border-black/10 py-1 pr-3">{typeLabel(r.type)}</td>
                              <td className="border-b border-black/10 py-1 pr-3 font-mono">{r.seats}</td>
                              <td className="border-b border-black/10 py-1 pr-3 font-mono">{r.contested}</td>
                              <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(r.votes, na)}</td>
                              <td className="border-b border-black/10 py-1 pr-3 font-mono min-w-[7rem]">
                                <span>{fpct(r.sharePct, na)}</span>
                                {r.sharePct != null && <span aria-hidden="true" data-testid="party-bar" className="block h-1.5 mt-0.5" style={{ width: `${Math.max(2, (r.sharePct / maxShare) * 100)}%`, background: colour }} />}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </Wait>
    </section>
  );
}
