import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useStateCtx } from "../../state/StateContext";

interface Ac { acNo: number; acName: string; status: string; label: string; round: number; totalRounds: number | null; leader: { candidate: string; party: string } | null; margin: number | null; underReview: boolean }
interface Latest {
  body: { seq: number; asOf: string; sourceId: string; delayLabel: string; synthetic: boolean; acs: Ac[]; summary: { total: number; declared: number; counting: number; notStarted: number; underReview: number }; notice: { en: string; te: string }; links: { kind: string; label: string; url: string }[] };
  sha256: string;
  signature: { keyId: string };
  live: { state: string; delayed_minutes: number; snapshot_age_minutes?: number; stale_after_minutes?: number; as_of?: string; banner: { en: string; te: string } | null; forecast_hidden: boolean };
}

export const isCountDayHash = (h: string) => h === "#/countday" || h.startsWith("#/countday/");

const TXT = {
  en: { title: "Count day", none: "No count-day feed is active for this state.", loading: "Loading...", live: "Live", seq: "Snapshot", asOf: "As of", source: "Source", signed: "Signed with key", declared: "Declared", counting: "Counting", notStarted: "Not started", review: "Under review", seat: "Seat", status: "Status", leader: "Leader", margin: "Margin", round: "Round", forecast: "No forecast or projection is shown while counting is active.", links: "Official links (outside this site)", refreshFailed: "Could not refresh just now. Showing the last figures received; they may be behind.", delayed: "Delayed by {n} minutes", updated: "Updated {n} minutes ago", notLive: "Not live", states: { live: "LIVE", stale: "NOT LIVE: STALE", "source-down": "FEED FAILING", "delayed-fallback": "DELAYED ARCHIVE", synthetic: "SYNTHETIC TEST DATA" } as Record<string, string>, synthBadge: "SYNTHETIC: NOT REAL COUNTS", verifyTitle: "How to verify these figures", verify1: "Every snapshot is signed. The hash is sha256 over the canonical JSON of the snapshot body (sorted keys, no spaces); the signature is Ed25519 over that 64-character hash.", verify2: "Get the public keys from the keys page and pin the key id out of band. The keys page is a convenience, not a trust anchor.", verify3: "Compare at least two mirrors: a lower head means lag or rollback; the same number with a different hash means a fork.", verify4: "Command line: npx tsx scripts/countday-verify.ts <mirror url> <second mirror url> --pin <key id>", keys: "Signing keys", index: "Snapshot index", snapshot: "This snapshot (immutable)", labels: { not_started: "Not started", leading: "Leading", tied: "Tied", won: "Won" } as Record<string, string> },
  te: { title: "లెక్కింపు రోజు", none: "ఈ రాష్ట్రానికి లెక్కింపు ఫీడ్ ప్రస్తుతం లేదు.", loading: "లోడ్ అవుతోంది...", live: "ప్రత్యక్షం", seq: "స్నాప్‌షాట్", asOf: "సమయం", source: "మూలం", signed: "సంతకం చేసిన కీ", declared: "ప్రకటించినవి", counting: "లెక్కింపులో", notStarted: "ప్రారంభం కాలేదు", review: "సమీక్షలో", seat: "స్థానం", status: "స్థితి", leader: "ముందంజ", margin: "తేడా", round: "రౌండ్", forecast: "లెక్కింపు జరుగుతున్నప్పుడు ఎలాంటి అంచనా చూపబడదు.", links: "అధికారిక లింకులు (ఈ సైట్ బయట)", refreshFailed: "ఇప్పుడు నవీకరించలేకపోయాము. చివరిగా అందిన గణాంకాలు చూపబడుతున్నాయి; అవి వెనుకబడి ఉండవచ్చు.", delayed: "{n} నిమిషాలు ఆలస్యం", updated: "{n} నిమిషాల క్రితం నవీకరించబడింది", notLive: "ప్రత్యక్షం కాదు", states: { live: "ప్రత్యక్షం", stale: "ప్రత్యక్షం కాదు: పాతది", "source-down": "ఫీడ్ విఫలమవుతోంది", "delayed-fallback": "ఆలస్య ఆర్కైవ్", synthetic: "కృత్రిమ పరీక్ష డేటా" } as Record<string, string>, synthBadge: "కృత్రిమం: నిజమైన లెక్కింపు కాదు", verifyTitle: "ఈ గణాంకాలను ఎలా ధృవీకరించాలి", verify1: "ప్రతి స్నాప్‌షాట్‌కు సంతకం ఉంది. హ్యాష్ అనేది స్నాప్‌షాట్ బాడీ యొక్క canonical JSON (క్రమబద్ధమైన కీలు, ఖాళీలు లేకుండా)పై sha256; సంతకం ఆ 64 అక్షరాల హ్యాష్‌పై Ed25519.", verify2: "కీల పేజీ నుండి పబ్లిక్ కీలను తీసుకుని, కీ ఐడీని వేరే మార్గంలో నిర్ధారించుకోండి. కీల పేజీ సౌలభ్యం మాత్రమే, నమ్మకానికి ఆధారం కాదు.", verify3: "కనీసం రెండు మిర్రర్లను పోల్చండి: తక్కువ హెడ్ అంటే ఆలస్యం లేదా వెనక్కి పోవడం; అదే సంఖ్యకు వేరే హ్యాష్ అంటే చీలిక.", verify4: "కమాండ్ లైన్: npx tsx scripts/countday-verify.ts <మిర్రర్ url> <రెండో మిర్రర్ url> --pin <కీ ఐడీ>", keys: "సంతకం కీలు", index: "స్నాప్‌షాట్ సూచిక", snapshot: "ఈ స్నాప్‌షాట్ (మారనిది)", labels: { not_started: "ప్రారంభం కాలేదు", leading: "ముందంజలో", tied: "సమానం", won: "గెలిచారు" } as Record<string, string> },
};

export default function CountDayPage() {
  const { lang } = useT();
  const { state } = useStateCtx();
  const x = TXT[lang === "te" ? "te" : "en"];
  const [data, setData] = useState<Latest | null>(null);
  const [status, setStatus] = useState<"loading" | "none" | "ok">("loading");
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    // Keep the last good figures when a refresh fails (and say so); only a first load with no feed shows the empty state. Paused while the tab is hidden.
    let have = false;
    const load = () => { if (document.hidden) return; return fetch(`/api/v1/countday/${state}/latest`).then(async (r) => { if (!alive) return; if (!r.ok) { if (have) setRefreshFailed(true); else setStatus("none"); return; } setData(await r.json()); have = true; setRefreshFailed(false); setStatus("ok"); }).catch(() => { if (!alive) return; if (have) setRefreshFailed(true); else setStatus("none"); }); };
    setStatus("loading"); setData(null); setRefreshFailed(false);
    void load();
    const t = setInterval(() => void load(), 15000);
    const vis = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [state]);

  return (
    <div className="space-y-6" lang={lang} data-testid="countday-page">
      <h2 className="text-2xl font-serif italic border-b border-black pb-3">{x.title} - {state}</h2>
      {status === "loading" && <p className="text-xs">{x.loading}</p>}
      {status === "none" && <p className="text-sm" data-testid="countday-none">{x.none}</p>}
      {status === "ok" && data && (<>
        {data.live.state === "synthetic" && <p role="note" data-testid="countday-synthetic-badge" className="border-4 border-double border-red-800 bg-red-700 text-white p-3 text-center text-lg font-black tracking-wide uppercase">{x.synthBadge}</p>}
        <p data-testid="countday-state" data-live-state={data.live.state} className={`inline-block border-2 px-3 py-1 text-xs font-black tracking-wider ${data.live.state === "live" ? "border-black bg-white text-black" : "border-red-800 bg-red-50 text-red-900"}`}>{x.states[data.live.state] ?? data.live.state}</p>
        {data.live.banner && <div role="alert" className="border-2 border-black bg-[#F4EBD0] text-[#121212] p-3 text-sm font-bold" data-testid="countday-banner" data-live-state={data.live.state}>{data.live.banner[lang === "te" ? "te" : "en"]}</div>}
        <p className="text-xs font-bold" data-testid="countday-delay" data-delayed-minutes={data.live.delayed_minutes}>{data.live.state === "live" ? x.updated.replace("{n}", String(data.live.delayed_minutes)) : x.delayed.replace("{n}", String(data.live.delayed_minutes))}</p>
        {refreshFailed && <p role="status" data-testid="countday-refresh-failed" className="text-xs font-bold border border-black p-2">{x.refreshFailed}</p>}
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
        <details data-testid="countday-verify" className="text-xs border border-black/40 p-3">
          <summary className="cursor-pointer font-bold min-h-[44px] inline-flex items-center">{x.verifyTitle}</summary>
          <ol className="list-decimal pl-5 space-y-1 pt-2"><li>{x.verify1}</li><li>{x.verify2}</li><li>{x.verify3}</li><li><code>{x.verify4}</code></li></ol>
          <ul className="list-disc pl-5 pt-2"><li><a className="underline" data-testid="countday-keys-link" href="/api/v1/countday/keys">{x.keys}</a></li><li><a className="underline" href={`/api/v1/countday/${state}/index`}>{x.index}</a></li><li><a className="underline" data-testid="countday-snapshot-link" href={`/api/v1/countday/${state}/snapshots/${data.body.seq}`}>{x.snapshot}</a></li></ul>
        </details>
        {data.body.links.length > 0 && <div className="text-xs"><strong>{x.links}</strong><ul className="list-disc pl-5">{data.body.links.map((l) => <li key={l.url + l.kind}><a className="underline" href={l.url} rel="noopener noreferrer" target="_blank">{l.label}</a></li>)}</ul></div>}
      </>)}
    </div>
  );
}
