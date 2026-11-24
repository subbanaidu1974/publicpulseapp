import { useState } from "react";
import { representativesApi } from "../../../api/civic";
import { useCivicT } from "../civicText";
import { Btn, ErrorNote, Field, TextInput } from "../ui";
import { Gate, actionError, useGuarded } from "./shared";

/** Held representative replies (S-145): a moderator approves a version, or removes it with a reason. Held text is never public. */
export default function ReplyModeration() {
  const c = useCivicT();
  const { data, state, reload } = useGuarded(() => representativesApi.heldQueue());
  const [why, setWhy] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, decision: "approve" | "remove") => {
    setErr(null);
    try { await representativesApi.review(id, decision, why[id]); reload(); } catch (e) { setErr(actionError(e, c)); }
  };
  return (
    <section data-testid="rep-mod" aria-labelledby="rm-h" className="space-y-3">
      <h4 id="rm-h" className="font-bold">{c("c.repmod.title")}</h4>
      <Gate state={state} onRetry={reload}>
        {data && data.length === 0 && <p className="text-sm">{c("c.repmod.empty")}</p>}
        <ul className="space-y-2">
          {(data ?? []).map((r) => (
            <li key={r.id} data-testid="rep-mod-item" className="border border-black p-2 text-sm space-y-2 break-words">
              <p className="text-xs">{r.constituency} - {c("c.rep.version")} {r.version} - {r.reasons.join(", ")}</p>
              <p>{r.text}</p>
              <Field id={`rm-why-${r.id}`} label={c("c.repmod.why")}><TextInput id={`rm-why-${r.id}`} maxLength={300} value={why[r.id] ?? ""} onChange={(e) => setWhy({ ...why, [r.id]: e.target.value })} /></Field>
              <div className="flex flex-wrap gap-2">
                <Btn data-testid="rep-mod-approve" onClick={() => void act(r.id, "approve")}>{c("c.repmod.approve")}</Btn>
                <Btn secondary data-testid="rep-mod-remove" disabled={(why[r.id] ?? "").trim().length < 5} onClick={() => void act(r.id, "remove")}>{c("c.repmod.remove")}</Btn>
              </div>
            </li>
          ))}
        </ul>
      </Gate>
      <ErrorNote msg={err} />
    </section>
  );
}
