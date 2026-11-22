import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import { defaultYear, useStateCtx } from "../../state/StateContext";
import { useT } from "../../i18n";
import HomeMap from "../HomeMap";
import { DemoBadge, ErrorBanner, Loading } from "../ui";

type Theme = "beige" | "dark" | "dark-beige" | "earth-yellow";
const go = (tab: string) => window.dispatchEvent(new CustomEvent("pp-nav", { detail: tab }));

export default function HomePage({ theme }: { theme: Theme }) {
  const { state, config } = useStateCtx();
  const { t, lang } = useT();
  const year = defaultYear(state, "assembly");
  const summary = useApi(() => api.summary(state, year, "assembly"), [state, year]);
  const marginal = useApi(() => api.marginal(state, year, "assembly", 2), [state, year]);
  const top = summary.data ? Object.entries(summary.data.tally).sort((a, b) => b[1] - a[1])[0] : undefined;
  const name = lang === "te" ? config.nameTe : config.name;

  const stats = [
    { id: "seats", count: String(summary.data?.totalSeats ?? config.assemblySeats), label: t("home.seats") },
    { id: "top", count: top ? `${top[0]} ${top[1]}` : "n/a", label: `${t("home.topParty")} ${year}` },
    { id: "marginal", count: marginal.data ? String(marginal.data.seats.length) : "n/a", label: t("el.marginal") },
    { id: "parties", count: summary.data ? String(Object.keys(summary.data.tally).length) : "n/a", label: t("home.parties") },
  ];

  const cards = [
    { tab: "elections", title: t("nav.elections"), desc: t("home.cardElections") },
    { tab: "analytics", title: t("nav.analytics"), desc: t("home.cardAnalytics") },
    { tab: "constituencies", title: t("nav.constituencies"), desc: t("home.cardSeats") },
    { tab: "civic", title: t("nav.civic"), desc: t("home.cardCivic") },
  ];

  return (
    <div className="space-y-12" data-testid="home-page">
      <div id="hero-banner" className="border-y-2 border-black/80 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-7 space-y-5 flex flex-col justify-center">
            <h1 className="text-4xl sm:text-6xl leading-[0.95] tracking-tighter italic font-serif">{name}<br />{t("home.heading")}</h1>
            <p className="text-sm sm:text-base font-serif leading-relaxed max-w-2xl">{t("home.lead")}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => go("elections")} className="bg-black text-[#F9F7F2] text-[10px] tracking-[0.2em] uppercase font-bold py-3 px-6 border border-black cursor-pointer">{t("nav.elections")}</button>
              <button type="button" onClick={() => go("analytics")} className="bg-transparent text-black text-[10px] tracking-[0.2em] uppercase font-bold py-3 px-6 border border-black cursor-pointer">{t("nav.analytics")}</button>
            </div>
          </div>
          <div className="lg:col-span-5 h-[360px] lg:h-auto lg:min-h-[380px]"><HomeMap theme={theme} state={state} /></div>
        </div>
      </div>

      <div id="hero-statistics" className="space-y-2">
        {summary.error && <ErrorBanner message={summary.error} onRetry={summary.retry} />}
        {summary.loading && <Loading />}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div key={s.id} data-testid={`home-stat-${s.id}`} className="bg-[#FAF8F5] p-5 border border-black/10 text-center min-h-[100px] flex flex-col justify-center">
              <span className="text-2xl font-serif italic block">{s.count}</span>
              <span className="text-[9px] uppercase tracking-wider font-bold mt-1">{s.label}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] font-sans flex items-center gap-2">{t("common.source")}: ECI / TCPD {summary.data?.demo && <DemoBadge />}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {cards.map((c) => (
          <button key={c.tab} type="button" onClick={() => go(c.tab)} className="text-left bg-[#FAF8F5] p-6 border border-black/10 hover:border-black cursor-pointer">
            <h3 className="text-base font-bold font-serif mb-2">{c.title}</h3>
            <p className="text-xs font-serif leading-relaxed">{c.desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
