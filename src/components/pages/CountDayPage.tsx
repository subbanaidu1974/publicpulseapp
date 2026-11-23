import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useStateCtx } from "../../state/StateContext";

interface Ac { acNo: number; acName: string; status: string; label: string; round: number; totalRounds: number | null; leader: { candidate: string; party: string } | null; margin: number | null; underReview: boolean }
interface Latest {
  body: { seq: number; asOf: string; sourceId: string; delayLabel: string; synthetic: boolean; acs: Ac[]; summary: { total: number; declared: number; counting: number; notStarted: number; underReview: number }; notice: { en: string; te: string }; links: { kind: string; label: string; url: string }[] };
  sha256: string;
  signature: { keyId: string };
  live: { state: string; delayed_minutes: number; banner: { en: string; te: string } | null; forecast_hidden: boolean };
}

export const isCountDayHash = (h: string) => h === "#/countday" || h.startsWith("#/countday/");

const TXT = {
  en: { title: "Count day", none: "No count-day feed is active for this state.", loading: "Loading...", live: "Live", seq: "Snapshot", asOf: "As of", source: "Source", signed: "Signed with key", declared: "Declared", counting: "Counting", notStarted: "Not started", review: "Under review", seat: "Seat", status: "Status", leader: "Leader", margin: "Margin", round: "Round", forecast: "No forecast or projection is shown while counting is active.", links: "Official links (outside this site)", labels: { not_started: "Not started", leading: "Leading", tied: "Tied", won: "Won" } as Record<string, string> },
  te: { title: "లెక్కింపు రోజు", none: "ఈ రాష్ట్రానికి లెక్కింపు ఫీడ్ ప్రస్తుతం లేదు.", loading: "లోడ్ అవుతోంది...", live: "ప్రత్యక్షం", seq: "స్నాప్‌షాట్", asOf: "సమయం", source: "మూలం", signed: "సంతకం చేసిన కీ", declared: "ప్రకటించినవి", counting: "లెక్కింపులో", notStarted: "ప్రారంభం కాలేదు", review: "సమీక్షలో", seat: "స్థానం", status: "స్థితి", leader: "ముందంజ", margin: "తేడా", round: "రౌండ్", forecast: "లెక్కింపు జరుగుతున్నప్పుడు ఎలాంటి అంచనా చూపబడదు.", links: "అధికారిక లింకులు (ఈ సైట్ బయట)", labels: { not_started: "ప్రారంభం కాలేదు", leading: "ముందంజలో", tied: "సమానం", won: "గెలిచారు" } as Record<string, string> },
};

export default function CountDayPage() {
  const { lang } = useT();
  const { state } = useStateCtx();
  const x = TXT[lang === "te" ? "te" : "en"];
  const [data, setData] = useState<Latest | null>(null);
  const [status, setStatus] = useState<"loading" | "none" | "ok">("loading");
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/v1/countday/${state}/latest`).then(async (r) => { if (!alive) return; if (!r.ok) { setStatus("none"); return; } setData(await r.json()); setStatus("ok"); }).catch(() => alive && setStatus("none"));
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [state]);

  return (
    <div className="space-y-6" lang={lang} data-testid="countday-page">
      <h2 className="text-2xl font-serif italic border-b border-black pb-3">{x.title} - {state}</h2>
      {status === "loading" && <p className="text-xs">{x.loading}</p>}
      {status === "none" && <p className="text-sm" data-testid="countday-none">{x.none}</p>}
      {status === "ok" && data && (<>
        {data.live.banner && <div role="alert" className="border-2 border-black bg-[#F4EBD0] text-[#121212] p-3 text-sm font-bold" data-testid="countday-banner" data-live-state={data.live.state}>{data.live.banner[lang === "te" ? "te" : "en"]}</div>}
        <p className="text-xs" data-testid="countday-meta">{x.seq} {data.body.seq} | {x.asOf} {data.body.asOf} | {x.source} {data.body.sourceId} | {x.signed} {data.signature.keyId} | sha256 {data.sha256.slice(0, 12)}</p>
        <p className="text-xs">{data.body.notice[lang === "te" ? "te" : "en"]}</p>
        {data.live.forecast_hidden && <p className="text-xs italic" data-testid="countday-forecast-note">{x.forecast}</p>}
        <p className="text-sm font-bold" data-testid="countday-summary">{x.declared} {data.body.summary.declared} | {x.counting} {data.body.summary.counting} | {x.notStarted} {data.body.summary.notStarted} | {x.review} {data.body.summary.underReview}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-black/30" data-testid="countday-table">
            <thead><tr className="text-left bg-black/5"><th className="p-2">{x.seat}</th><th className="p-2">{x.status}</th><th className="p-2">{x.leader}</th><th className="p-2">{x.margin}</th><th className="p-2">{x.round}</th></tr></thead>
            <tbody>{data.body.acs.map((a) => (
              <tr key={a.acNo} className="border-t border-black/10" data-label={a.label}>
                <td className="p-2">{a.acNo}. {a.acName}</td>
                <td className="p-2 font-bold">{x.labels[a.label] ?? a.label}{a.underReview ? ` (${x.review})` : ""}</td>
                <td className="p-2">{a.leader ? `${a.leader.candidate} (${a.leader.party})` : "-"}</td>
                <td className="p-2">{a.margin ?? "-"}</td>
                <td className="p-2">{a.round}{a.totalRounds ? `/${a.totalRounds}` : ""}</td>
              </tr>))}</tbody>
          </table>
        </div>
        {data.body.links.length > 0 && <div className="text-xs"><strong>{x.links}</strong><ul className="list-disc pl-5">{data.body.links.map((l) => <li key={l.url + l.kind}><a className="underline" href={l.url} rel="noopener noreferrer" target="_blank">{l.label}</a></li>)}</ul></div>}
      </>)}
    </div>
  );
}
