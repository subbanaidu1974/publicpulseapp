import { analytics } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { useAT, type AKey } from "./analyticsText";
import { Wait, fnum } from "./common";

/**
 * Panchayat elections (S-203). No results are loaded yet, so the page says so and lists what it will hold once a source whose terms allow reuse is
 * approved. It never shows a number that is not in an approved file. See docs/PANCHAYAT_DATA.md.
 */
export default function PanchayatPage() {
  const { a, lang } = useAT();
  const { state, config } = useStateCtx();
  const s = useApi(() => analytics.panchayat(state), [state]);
  const levelName = (l: string) => a(`an2.pn.level.${l}` as AKey);
  return (
    <section data-testid="panchayat-page" className="space-y-4 font-sans">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.pn.title")} - {lang === "te" ? config.nameTe ?? config.name : config.name}</h2>
      <Wait s={s}>
        {s.data && (
          <>
            {!s.data.loaded && (
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
            )}
            <div>
              <h3 className="text-xs font-bold mb-1">{a("an2.pn.will")}</h3>
              <ul data-testid="panchayat-levels" className="grid gap-2 sm:grid-cols-3">
                {s.data.levels.map((l) => (
                  <li key={l} data-testid="panchayat-level" data-level={l} className="border border-black p-3 space-y-1 bg-white">
                    <strong className="block text-sm">{levelName(l)}</strong>
                    <span className="block text-[11px]">{a(`an2.pn.desc.${l}` as AKey)}</span>
                    <span className="block text-[11px] font-mono">
                      {s.data.elections.filter((e) => e.level === l).length === 0 ? a("an2.pn.none") : s.data.elections.filter((e) => e.level === l).map((e) => `${e.year}`).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {s.data.loaded && (
              <div className="overflow-x-auto">
                <table data-testid="panchayat-table" className="w-full text-left border-collapse text-xs">
                  <caption className="sr-only">{a("an2.pn.title")}</caption>
                  <thead><tr>{[a("an2.year"), a("an2.pn.level"), a("an2.pn.units"), a("an2.pn.posts"), a("an2.pn.unopposed")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
                  <tbody>
                    {s.data.elections.map((e) => (
                      <tr key={e.id} data-testid="panchayat-row">
                        <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{e.year}</th>
                        <td className="border-b border-black/10 py-1 pr-3">{levelName(e.level)}</td>
                        <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(e.units, a("an2.na"))}</td>
                        <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(e.posts, a("an2.na"))}</td>
                        <td className="border-b border-black/10 py-1 pr-3 font-mono">{e.unopposed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {s.data.source && <p data-testid="panchayat-source" className="text-[11px]">{s.data.source.publisher}, {s.data.source.licence}, {s.data.source.retrieved}</p>}
            <ul className="text-[11px] list-disc pl-5 space-y-1" data-testid="panchayat-notes">{s.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        )}
      </Wait>
    </section>
  );
}
