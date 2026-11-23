import { ConsolePage } from "./Console";
import { ConsultationDetailPage } from "./Detail";
import { FiguresPage } from "./Figures";
import { ParticipatePage } from "./Participate";
import { RegistryPage } from "./Registry";
import { ReportPage } from "./Report";
import { useConsT } from "./consultationsText";
import { useHash } from "./shared";

export const isConsultationsHash = (h: string) => /^#\/consultations(\/|$)/.test(h);

/** Hash router for the bill-consultation area: #/consultations, /console, /<id>, /<id>/participate, /<id>/figures, /<id>/report. */
export default function ConsultationsRoot() {
  const hash = useHash();
  const parts = hash.replace(/^#\/consultations\/?/, "").split("/").filter(Boolean);
  const [a, b] = parts;
  if (!a) return <RegistryPage />;
  if (a === "console") return <ConsolePage />;
  if (b === "participate") return <ParticipatePage key={a} id={a} />;
  if (b === "figures") return <FiguresPage key={a} id={a} />;
  if (b === "report") return <ReportPage key={a} id={a} />;
  return <ConsultationDetailPage key={a} id={a} />;
}

/** A small link from the Civic tab. */
export function ConsultationsLink() {
  const c = useConsT();
  return <p><a href="#/consultations" data-testid="civic-to-consultations" className="underline font-bold min-h-[44px] inline-flex items-center">{c("link.civic")}</a></p>;
}
