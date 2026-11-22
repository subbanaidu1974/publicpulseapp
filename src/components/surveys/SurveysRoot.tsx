import { BuilderPage, ConsolePage } from "./Creator";
import { SurveyDetailPage } from "./Detail";
import { FiguresPage } from "./Figures";
import { PanelPage } from "./Panel";
import { RegistryLog, RegistryPage } from "./Registry";
import { TakePage } from "./Take";
import { useHash } from "./shared";
import { useSurveyT } from "./surveysText";

export const isSurveysHash = (h: string) => /^#\/surveys(\/|$)/.test(h);

/** Hash router for the Pulse Survey area: #/surveys, /log, /console, /new, /edit/<id>, /panel, /<id>, /<id>/versions, /<id>/take, /<id>/figures. */
export default function SurveysRoot() {
  const hash = useHash();
  const parts = hash.replace(/^#\/surveys\/?/, "").split("/").filter(Boolean);
  const [a, b] = parts;
  if (!a) return <RegistryPage />;
  if (a === "log") return <RegistryLog />;
  if (a === "console") return <ConsolePage />;
  if (a === "new") return <BuilderPage />;
  if (a === "edit" && b) return <BuilderPage key={b} editId={b} />;
  if (a === "panel") return <PanelPage />;
  if (b === "take") return <TakePage key={a} id={a} />;
  if (b === "figures") return <FiguresPage key={a} id={a} />;
  return <SurveyDetailPage key={a} id={a} focus={b === "versions" ? "versions" : undefined} />;
}

/** A small link from the Civic tab. */
export function SurveysLink() {
  const s = useSurveyT();
  return <p><a href="#/surveys" data-testid="civic-to-surveys" className="underline font-bold min-h-[44px] inline-flex items-center">{s("link.civic")}</a></p>;
}
