import { useMemo, useState } from "react";
import { analytics } from "../../api/analytics";
import type { ElectorsItem } from "../../api/analytics";
import { useApi } from "../../api/useApi";
import { useStateCtx } from "../../state/StateContext";
import { useAT } from "./analyticsText";
import { SourceBanner, Wait, fnum, fpct } from "./common";

type Sort = "no" | "femaleHigh" | "femaleLow" | "total";
const gendered = (x: { male: number; female: number; thirdGender: number }) => x.male + x.female + x.thirdGender;
const femaleShare = (x: ElectorsItem) => (gendered(x) ? (x.female / gendered(x)) * 100 : 0);
const perThousand = (x: { male: number; female: number }) => (x.male ? Math.round((x.female / x.male) * 1000) : null);

/**
 * Electors (S-197): electors by assembly constituency and gender from the rolls used for the 2024 general election (Election Commission
 * statistical report, counts only). Age bands are NOT shown: no constituency-wise age table has been sourced, and none is estimated.
 */
export default function ElectorsPage() {
  const { a } = useAT();
  const { state, config } = useStateCtx();
  const [sort, setSort] = useState<Sort>("no");
  const s = useApi(() => analytics.electors(state), [state]);
  const na = a("an2.na");
  const items = useMemo(() => {
    const list = [...(s.data?.items ?? [])];
    const by: Record<Sort, (x: ElectorsItem, y: ElectorsItem) => number> = {
      no: (x, y) => x.acNo - y.acNo, femaleHigh: (x, y) => femaleShare(y) - femaleShare(x), femaleLow: (x, y) => femaleShare(x) - femaleShare(y), total: (x, y) => y.total - x.total,
    };
    return list.sort(by[sort]);
  }, [s.data, sort]);
  const sum = useMemo(() => {
    const t = { male: 0, female: 0, thirdGender: 0, total: 0 };
    for (const x of s.data?.items ?? []) { t.male += x.male; t.female += x.female; t.thirdGender += x.thirdGender; t.total += x.total; }
    return t;
  }, [s.data]);
  return (
    <section data-testid="electors-page" className="space-y-4 font-sans">
      <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{a("an2.e.title")} - {config.name}</h2>
      <Wait s={s}>
        {s.data && (!s.data.available ? <p data-testid="electors-unavailable" className="text-xs">{na}</p> : (
          <>
            <SourceBanner source={s.data.source} asOf={s.data.rollYear ? String(s.data.rollYear) : null} />
            <p className="text-[11px]" data-testid="electors-note">{s.data.note}</p>
            <dl data-testid="electors-totals" className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs border border-black p-3">
              <div><dt>{a("an2.e.total")}</dt><dd className="font-mono font-bold" data-testid="e-total">{fnum(sum.total, na)}</dd></div>
              <div><dt>{a("an2.e.male")}</dt><dd className="font-mono font-bold">{fnum(sum.male, na)}</dd></div>
              <div><dt>{a("an2.e.female")}</dt><dd className="font-mono font-bold">{fnum(sum.female, na)}</dd></div>
              <div><dt>{a("an2.e.third")}</dt><dd className="font-mono font-bold">{fnum(sum.thirdGender, na)}</dd></div>
              <div><dt>{a("an2.e.ratio")}</dt><dd className="font-mono font-bold" data-testid="e-ratio">{perThousand(sum) ?? na}</dd></div>
            </dl>
            <p className="text-[11px]">{a("an2.e.femaleShare")}: <strong>{fpct(gendered(sum) ? (sum.female / gendered(sum)) * 100 : null, na)}</strong></p>
            <section data-testid="electors-age" className="border border-black/40 p-3 text-xs space-y-1">
              <h3 className="font-bold">{a("an2.e.age")}</h3>
              <p>{a("an2.e.ageNote")}</p>
            </section>
            <label className="text-xs block"><span className="font-bold mr-2">{a("an2.e.sort")}</span>
              <select data-testid="electors-sort" className="border border-black bg-white text-[#121212] px-2 py-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="no">{a("an2.e.sortNo")}</option><option value="femaleHigh">{a("an2.e.sortFH")}</option>
                <option value="femaleLow">{a("an2.e.sortFL")}</option><option value="total">{a("an2.e.sortTotal")}</option>
              </select>
            </label>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs" data-testid="electors-table">
                <caption className="sr-only">{a("an2.e.title")}</caption>
                <thead><tr>{["#", a("an2.e.seat"), a("an2.e.male"), a("an2.e.female"), a("an2.e.third"), a("an2.e.total"), a("an2.e.ratio")].map((h) => <th key={h} scope="col" className="border-b border-black/30 py-1 pr-3 font-bold">{h}</th>)}</tr></thead>
                <tbody>
                  {items.map((x) => (
                    <tr key={x.acNo} data-testid="electors-row">
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{x.acNo}</td>
                      <th scope="row" className="border-b border-black/10 py-1 pr-3 font-bold">{x.acName}</th>
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(x.male, na)}</td>
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(x.female, na)}</td>
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(x.thirdGender, na)}</td>
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{fnum(x.total, na)}</td>
                      <td className="border-b border-black/10 py-1 pr-3 font-mono">{perThousand(x) ?? na}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
      </Wait>
    </section>
  );
}
