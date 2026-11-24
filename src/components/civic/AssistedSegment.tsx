import { useEffect, useState } from "react";
import { CivicApiError, assistedApi, type AssistedSegment as Segment } from "../../api/civic";
import { useT } from "../../i18n";
import { glyphFor, useCategories } from "./categories";
import { useCivicT } from "./civicText";
import { statusLabel } from "./IssueFeed";
import { Btn, TextInput } from "./ui";

/** Receipt holder tools: check a report, or ask for it to be deleted. No account and no phone: the paper code is the only handle. */
function ReceiptTools() {
  const c = useCivicT();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (del: boolean) => {
    setMsg(null);
    try {
      if (del) { await assistedApi.receiptDelete(code); setMsg(c("c.as.rcDone")); return; }
      const s = await assistedApi.receiptStatus(code);
      setMsg(s.deleted ? c("c.as.rcDeleted") : s.state === "published" ? c("c.as.rcPublished") : c("c.as.rcHeld"));
    } catch (e) { setMsg(e instanceof CivicApiError && e.status === 429 ? c("c.as.rcRate") : c("c.as.rcNotFound")); }
  };
  return (
    <details className="text-sm border border-black p-2" data-testid="as-receipt-tools">
      <summary className="cursor-pointer font-bold min-h-[44px] flex items-center">{c("c.as.rcTitle")}</summary>
      <div className="space-y-2 pt-2">
        <label htmlFor="as-rc" className="block font-bold">{c("c.as.rcCode")}</label>
        <TextInput id="as-rc" data-testid="as-rc-code" autoComplete="off" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
        <div className="flex gap-2 flex-wrap">
          <Btn secondary data-testid="as-rc-check" disabled={!code.trim()} onClick={() => void run(false)}>{c("c.as.rcCheck")}</Btn>
          <Btn secondary data-testid="as-rc-delete" disabled={!code.trim()} onClick={() => void run(true)}>{c("c.as.rcDelete")}</Btn>
        </div>
        {msg && <p role="status" data-testid="as-rc-msg">{msg}</p>}
      </div>
    </details>
  );
}

/**
 * The separate, labelled segment of the public issue list ("Reported with assistance"). Never merged into the main list, never ranked, no counts.
 * The server answers 404 assisted_disabled while the feature is off, and this component then renders nothing.
 */
export default function AssistedSegment({ refreshKey = 0 }: { refreshKey?: number }) {
  const c = useCivicT();
  const { lang } = useT();
  const { label } = useCategories();
  const [seg, setSeg] = useState<Segment | null>(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    let live = true;
    assistedApi.segment().then((s) => { if (live) { setSeg(s); setFail(false); } }).catch((e) => { if (live) { setSeg(null); setFail(!(e instanceof CivicApiError && e.status === 404)); } });
    return () => { live = false; };
  }, [refreshKey]);
  if (!seg && !fail) return null;
  return (
    <section data-testid="assisted-segment" aria-labelledby="asg-h" className="space-y-2 border-2 border-black p-3">
      <h2 id="asg-h" className="text-xl font-bold" data-testid="assisted-segment-label">{seg ? (lang === "te" ? seg.labelTe : seg.labelEn) : c("c.as.badge")}</h2>
      {seg && <p className="text-xs">{lang === "te" ? seg.noteTe : seg.noteEn}</p>}
      {fail && <p role="alert" className="text-sm">{c("c.as.segLoadFail")}</p>}
      {seg && seg.items.length === 0 && <p className="text-sm">{c("c.as.segEmpty")}</p>}
      <ul className="space-y-2">
        {(seg?.items ?? []).map((i) => (
          <li key={i.id} data-testid="assisted-item" className="border border-black p-3 text-sm break-words flex items-start gap-2">
            <span aria-hidden="true" className="text-2xl leading-none">{glyphFor({ id: i.category })}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p><strong>{label(i.category)}</strong> <span className="text-xs">({statusLabel(c, i.status)})</span> <span className="text-xs border border-black px-1" data-testid="assisted-badge">{c("c.as.badge")}</span></p>
              {(lang === "te" ? i.snippetTe ?? i.snippet : i.snippet ?? i.snippetTe) && <p>{lang === "te" ? i.snippetTe ?? i.snippet : i.snippet ?? i.snippetTe}</p>}
            </div>
          </li>
        ))}
      </ul>
      <ReceiptTools />
    </section>
  );
}
