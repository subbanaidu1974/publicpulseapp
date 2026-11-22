import { useState } from "react";
import { errorCode, errStatus, surveysApi, type FigCell, type FigQuestion, type FigStratum, type Figures } from "../../api/surveys";
import { useT } from "../../i18n";
import { type Keyed, Disclaimer, ErrorLine, Page, ProtectionBox, card, fmtDate, linkCls, pickLang, titleOf, useLoad, Btn } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

type Dim = "geo" | "age_band" | "gender" | "tier";
const DIMS: Dim[] = ["geo", "age_band", "gender", "tier"];
const pct = (v: number | undefined) => (v === undefined ? "-" : `${Math.round(v * 10) / 10}%`);
/** Server shares are percentages already (one decimal) in the unweighted figures; weighted shares use the same scale. */

function CellTable({ q, cell }: Keyed & { q: FigQuestion; cell: FigCell }) {
  const s = useSurveyT();
  const { lang } = useT();
  const label = (id: string) => { const o = q.options.find((x) => x.id === id); return o ? pickLang(o.label_en, o.label_te, lang) || id : id; };
  const w = new Map(cell.weighted.options.map((o) => [o.id, o.share]));
  const catName = cell.label_en === "unknown" ? s("fig.unknown") : pickLang(cell.label_en, cell.label_te, lang) || cell.id;
  return (
    <div className="overflow-x-auto" data-testid="fig-cell" data-cell={cell.id}>
      <table className="w-full text-sm border-collapse">
        <caption className="text-left font-bold py-1">{cell.level === "all" ? s("fig.all") : catName} - {s("fig.n")} {cell.n}</caption>
        <thead><tr className="border-b border-black"><th scope="col" className="text-left py-1 pr-2">{s("fig.option")}</th><th scope="col" className="text-right px-2">{s("fig.unweighted")}</th><th scope="col" className="text-right pl-2">{s("fig.weighted")}</th></tr></thead>
        <tbody>
          {cell.unweighted.options.map((o) => (
            <tr key={o.id} className="border-b border-black/20" data-testid="fig-row">
              <th scope="row" className="text-left font-normal py-1 pr-2 break-words">{label(o.id)}</th>
              <td className="text-right px-2" data-testid="fig-unweighted">{pct(o.share)}</td>
              <td className="text-right pl-2" data-testid="fig-weighted">{pct(w.get(o.id))}</td>
            </tr>
          ))}
          {cell.unweighted.other && (
            <tr className="border-b border-black/20"><th scope="row" className="text-left font-normal py-1 pr-2">{s("fig.other")}</th><td className="text-right px-2">{pct(cell.unweighted.other.share)}</td><td className="text-right pl-2">{pct(cell.weighted.other?.share)}</td></tr>
          )}
        </tbody>
      </table>
      {cell.hidden_children > 0 && <p className="text-xs mt-1" data-testid="fig-rolled-up">{s("fig.rolledUp").replace("{n}", String(cell.hidden_children))}</p>}
    </div>
  );
}

function StratumCard({ st, dim }: Keyed & { st: FigStratum; dim: Dim }) {
  const s = useSurveyT();
  const { lang } = useT();
  const title = s(st.channel === "assisted" ? "fig.channel.assisted" : "fig.channel.app");
  if (!st.published) {
    return (
      <section className={card} data-testid="fig-stratum" data-channel={st.channel} data-published="0">
        <h2 className="text-lg font-bold">{title}</h2>
        <p data-testid="fig-unpublished">{s(`fig.reason.${st.reason}` as SurveyKey) === `fig.reason.${st.reason}` ? s("fig.reason.other") : s(`fig.reason.${st.reason}` as SurveyKey)}</p>
      </section>
    );
  }
  const qual = st.quality!;
  return (
    <section className={card} data-testid="fig-stratum" data-channel={st.channel} data-published="1">
      <h2 className="text-lg font-bold">{title}</h2>
      {st.channel === "assisted" && <p className="text-sm font-bold" data-testid="fig-assisted-note">{s("fig.assistedNote")}</p>}
      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="fig-sample">
        <dt className="font-bold">{s("fig.sample")}</dt><dd data-testid="fig-sample-n">{st.n}</dd>
        <dt className="font-bold">{s("fig.effective")}</dt><dd data-testid="fig-effective-n">{st.sampling?.effective_n}</dd>
        <dt className="font-bold">{s("fig.deff")}</dt><dd>{st.sampling?.design_effect}</dd>
      </dl>
      <p className="text-sm" data-testid="fig-sampling-note">{s("fig.noMargin")} {pickLang(st.sampling?.coverage_warning_en, st.sampling?.coverage_warning_te, lang)}</p>
      <p className="text-sm" data-testid="fig-weighting">{st.weighting?.applied ? s("fig.weightedOn").replace("{d}", (st.weighting.dimensions ?? []).join(", ")) : s("fig.noWeights")}</p>
      <div data-testid="fig-quality">
        <h3 className="font-bold text-sm">{s("fig.quality")}: <span data-testid="fig-quality-score">{Math.round(qual.score)}</span>/100{qual.partial ? ` (${s("fig.partial")})` : ""}</h3>
        <ul className="text-sm list-disc pl-5">
          {qual.components.map((c) => <li key={c.key} data-testid="fig-quality-part">{s(`fig.q.${c.key}` as SurveyKey) === `fig.q.${c.key}` ? c.key : s(`fig.q.${c.key}` as SurveyKey)}: {c.available && c.value !== null ? `${Math.round(c.value * 100)}%` : s("fig.unavailable")} ({s("fig.weightOf")} {c.weight})</li>)}
        </ul>
      </div>
      {(st.questions ?? []).map((q, i) => {
        const cells = q.breakdowns[dim] ?? [];
        return (
          <div key={q.id} className="border-t border-black/30 pt-3 space-y-2" data-testid="fig-question">
            <h3 className="font-bold">{i + 1}. {pickLang(q.text_en, q.text_te, lang)}</h3>
            {cells.length === 0 ? <p className="text-sm" data-testid="fig-suppressed">{s("fig.suppressed")}</p> : cells.map((c) => <CellTable key={c.id} q={q} cell={c} />)}
          </div>
        );
      })}
    </section>
  );
}

function MethodBox({ id }: { id: string }) {
  const s = useSurveyT();
  const [open, setOpen] = useState(false);
  const r = useLoad(() => (open ? surveysApi.figuresMethod(id) : Promise.resolve(null)), [id, open]);
  return (
    <section className={card}>
      <Btn secondary data-testid="fig-method-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? s("fig.methodHide") : s("fig.methodShow")}</Btn>
      {open && r.error != null && <ErrorLine msg={s("err.load")} />}
      {open && r.data && (
        <div className="text-sm space-y-3" data-testid="fig-method">
          <p>{s("fig.codeVersion")}: <code>{r.data.code_version}</code></p>
          {r.data.strata.map((m) => (
            <div key={m.channel} data-testid="fig-method-stratum">
              <h3 className="font-bold">{s(m.channel === "assisted" ? "fig.channel.assisted" : "fig.channel.app")}</h3>
              <p data-testid="fig-method-weights">{m.weights.applied ? s("fig.weightedOn").replace("{d}", m.weights.dimensions_used.filter((d) => d.weighted).map((d) => d.dimension).join(", ")) : s("fig.noWeights")}</p>
              {m.weights.dimensions_skipped.length > 0 && <ul className="list-disc pl-5">{m.weights.dimensions_skipped.map((d) => <li key={d.dimension}>{d.dimension}: {d.reason}</li>)}</ul>}
              {m.weights.residual_gap_pp != null && <p>{s("fig.residual")}: {m.weights.residual_gap_pp}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function FiguresPage({ id }: Keyed & { id: string }) {
  const s = useSurveyT();
  const { lang } = useT();
  const [dim, setDim] = useState<Dim>("geo");
  const sv = useLoad(() => surveysApi.get(id), [id]);
  const r = useLoad<Figures>(() => surveysApi.figures(id, dim), [id, dim]);
  const title = sv.data ? titleOf(sv.data, lang) : s("fig.title");
  const code = errorCode(r.error);
  const election = !!sv.data?.election_choice;
  return (
    <Page title={`${s("fig.title")}: ${title}`} back={{ label: s("a.details"), to: `#/surveys/${id}` }}>
      <Disclaimer en={r.data?.disclaimer_en ?? sv.data?.disclaimer_en} te={r.data?.disclaimer_te ?? sv.data?.disclaimer_te} />
      <p className="text-sm font-bold border border-black bg-white text-black px-3 py-2" data-testid="fig-not-random" role="note">{s("fig.notRandom")}</p>
      {r.loading && <p role="status">{s("loading")}</p>}
      {r.error != null && code === "not_published" && (
        <section className={card} data-testid="fig-not-published" role="status">
          <h2 className="text-lg font-bold">{s("fig.notPublished.title")}</h2>
          <p>{s("fig.notPublished.body")}</p>
          {election && <p data-testid="fig-blackout" className="font-bold">{s("fig.blackout")}</p>}
        </section>
      )}
      {r.error != null && code === "budget_exceeded" && <ErrorLine msg={s("err.budget_exceeded")} />}
      {r.error != null && code !== "not_published" && code !== "budget_exceeded" && <ErrorLine msg={errStatus(r.error) === 0 ? s("err.network") : s("err.load")} />}
      {r.data && (
        <>
          <p className="text-sm">{s("fig.publishedAt")}: {fmtDate(r.data.published_at, lang, true)} - {s("fig.hash")}: <code>{r.data.snapshot_sha256.slice(0, 10)}</code></p>
          <fieldset className={card} data-testid="fig-dim">
            <legend className="font-bold px-1">{s("fig.dim")}</legend>
            <p className="text-xs">{s("fig.dimNote")}</p>
            <div className="flex flex-wrap gap-x-5">
              {DIMS.map((d) => (
                <label key={d} className="flex items-center gap-2 min-h-[44px]"><input type="radio" name="fig-dim" data-testid={`fig-dim-${d}`} checked={dim === d} onChange={() => setDim(d)} />{s(`fig.dim.${d}` as SurveyKey)}</label>
              ))}
            </div>
          </fieldset>
          {!r.data.has_published_figures && <p role="status" data-testid="fig-none">{s("fig.none")}</p>}
          {r.data.strata.map((st) => <StratumCard key={st.channel} st={st} dim={dim} />)}
          <p className="text-xs">{s("fig.rounding").replace("{k}", String(r.data.partition.minimum_cell_size)).replace("{r}", String(r.data.partition.counts_rounded_to))}</p>
          <MethodBox id={id} />
        </>
      )}
      <ProtectionBox compact />
      <button type="button" className={linkCls + " min-h-[44px] text-left"} data-testid="fig-method-link" onClick={() => { window.dispatchEvent(new CustomEvent("pp-nav", { detail: "methodology" })); setTimeout(() => document.getElementById("surveys")?.scrollIntoView?.(), 150); }}>{s("fig.methodLink")}</button>
    </Page>
  );
}
