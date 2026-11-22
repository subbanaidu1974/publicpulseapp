import { useEffect, useRef, useState, type ReactNode } from "react";
import { CivicApiError } from "../../api/civic";
import { errorCode, surveysApi, type DraftInput, type Finding, type QuotaState, type SurveyDetail, type TopicClass } from "../../api/surveys";
import { useT } from "../../i18n";
import { useErrorMessage } from "./Take";
import { Btn, Disclaimer, ErrorLine, Page, ProtectionBox, StatusBadge, card, fmtDate, go, inputCls, linkCls, shortHash, type Keyed, titleOf, useLoad, useMe } from "./shared";
import { useSurveyT, type SurveyKey } from "./surveysText";

export const CREATOR_ROLES = ["politician", "officer", "journalist", "admin"];
export const PANEL_ROLES = ["admin", "survey_panel"];
const REASONS = ["creator_withdrew", "wording_dispute", "legal_advice", "duplicate", "low_relevance", "election_window", "safety", "other"];
const TOPICS: TopicClass[] = ["issue_service", "bill", "political", "election_choice"];

// ---------------------------------------------------------------- form model
interface OptF { label_en: string; label_te: string; prefer_not: boolean }
interface QF { kind: "single" | "multi" | "scale5"; text_en: string; text_te: string; max_select: number; preferNot: boolean; options: OptF[] }
interface Form {
  topic_class: TopicClass; title_en: string; title_te: string; state: string; district: string; mandal: string; opens: string; closes: string;
  asks_party_preference: boolean; org_kind: string; org_code: string; questions: QF[];
}
const PN = { en: "Prefer not to say", te: "చెప్పడానికి ఇష్టపడను" };
const blankQ = (): QF => ({ kind: "single", text_en: "", text_te: "", max_select: 2, preferNot: false, options: [{ label_en: "", label_te: "", prefer_not: false }, { label_en: "", label_te: "", prefer_not: false }] });
const local = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const blankForm = (): Form => {
  const now = new Date(); now.setSeconds(0, 0);
  return { topic_class: "issue_service", title_en: "", title_te: "", state: "AP", district: "", mandal: "", opens: local(now), closes: local(new Date(now.getTime() + 7 * 86_400_000)), asks_party_preference: false, org_kind: "", org_code: "", questions: [blankQ()] };
};
const codes = (v: string) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

function toInput(f: Form): DraftInput {
  const units: Record<string, string[]> = {};
  if (codes(f.district).length) units.district = codes(f.district);
  if (codes(f.mandal).length) units.mandal = codes(f.mandal);
  return {
    topic_class: f.topic_class, title_en: f.title_en.trim(), title_te: f.title_te.trim(), scope: { state: f.state, units },
    opens_at: new Date(f.opens).toISOString(), closes_at: new Date(f.closes).toISOString(),
    ...(f.asks_party_preference ? { asks_party_preference: true } : {}), ...(f.org_kind ? { org_kind: f.org_kind, org_code: f.org_code } : {}),
    questions: f.questions.map((q) => ({
      kind: q.kind, text_en: q.text_en.trim(), text_te: q.text_te.trim(), ...(q.kind === "multi" ? { max_select: q.max_select } : {}),
      options: q.kind === "scale5" ? (q.preferNot ? [{ label_en: PN.en, label_te: PN.te, prefer_not: true }] : [])
        : q.options.map((o) => ({ label_en: o.label_en.trim(), label_te: o.label_te.trim(), prefer_not: o.prefer_not })),
    })),
  };
}

/** Enough to be worth sending to the server for a wording check (the server stays the judge). */
function sendable(f: Form): boolean {
  if (f.title_en.trim().length < 3 || !f.opens || !f.closes || new Date(f.closes) <= new Date(f.opens) || new Date(f.closes) <= new Date()) return false;
  return f.questions.length > 0 && f.questions.every((q) => q.text_en.trim().length >= 3 && (q.kind === "scale5" || (q.options.length >= 2 && q.options.every((o) => o.label_en.trim()))));
}

function formFrom(sv: SurveyDetail): Form {
  const u = sv.scope.units ?? {};
  return {
    topic_class: sv.topic_class, title_en: sv.title_en, title_te: sv.title_te ?? "", state: sv.scope.state, district: (u.district ?? []).join(", "), mandal: (u.mandal ?? []).join(", "),
    opens: local(new Date(sv.opens_at)), closes: local(new Date(sv.closes_at)), asks_party_preference: false, org_kind: "", org_code: "",
    questions: sv.questions.map((q) => ({
      kind: q.kind, text_en: q.text_en, text_te: q.text_te ?? "", max_select: q.max_select ?? 2, preferNot: q.options.some((o) => o.prefer_not),
      options: q.kind === "scale5" ? [] : q.options.map((o) => ({ label_en: o.label_en, label_te: o.label_te ?? "", prefer_not: o.prefer_not })),
    })),
  };
}

// ---------------------------------------------------------------- small pieces
export function useCreatorGate() {
  const me = useMe();
  return { ...me, isCreator: me.roles.some((r) => CREATOR_ROLES.includes(r)), isPanel: me.roles.some((r) => PANEL_ROLES.includes(r)) };
}

function Gate({ me, need, children }: { me: ReturnType<typeof useCreatorGate>; need: "creator" | "panel"; children: ReactNode }) {
  const s = useSurveyT();
  if (me.loading) return <p role="status">{s("loading")}</p>;
  if (!me.signedIn) return (
    <section className={card} data-testid="console-signin"><p>{s("take.signin")}</p><Btn onClick={() => window.dispatchEvent(new CustomEvent("pp-nav", { detail: "civic" }))}>{s("take.signinBtn")}</Btn></section>
  );
  if (need === "creator" ? !me.isCreator : !me.isPanel) return <p role="alert" data-testid="console-forbidden" className="font-bold">{s(need === "creator" ? "con.noRole" : "pan.noRole")}</p>;
  return <>{children}</>;
}

export function FindingsList({ items }: { items: Finding[] }) {
  const s = useSurveyT();
  if (!items.length) return <p className="text-sm" data-testid="findings-none">{s("bld.findingsNone")}</p>;
  return (
    <ul className="space-y-1 text-sm" data-testid="findings">
      {items.map((f, i) => <li key={i} data-severity={f.severity} className={f.severity === "block" ? "border border-red-800 bg-red-50 text-black px-2 py-1" : "border border-amber-700 bg-amber-50 text-black px-2 py-1"}><strong>{f.severity === "block" ? s("bld.block") : s("bld.warn")}</strong> ({f.where}) {f.text}</li>)}
    </ul>
  );
}

export function QuotaMeter({ topic, org }: { topic: TopicClass; org?: { org_kind?: string; org_code?: string } }) {
  const s = useSurveyT();
  const { lang } = useT();
  const r = useLoad<QuotaState>(() => surveysApi.quota(topic, org), [topic, org?.org_kind, org?.org_code]);
  const q = r.data;
  if (r.error) return <ErrorLine msg={errorCode(r.error) === "topic_not_allowed_for_org" ? s("err.topic_not_allowed_for_org") : s("err.load")} />;
  if (!q) return <p role="status">{s("loading")}</p>;
  const pct = q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
  return (
    <div data-testid="quota-meter" className="space-y-1" data-allowed={q.allowed ? "1" : "0"}>
      <p className="text-sm font-bold">{q.limit === null ? s("quota.unlimited") : s("quota.used").replace("{u}", String(q.used)).replace("{l}", String(q.limit)).replace("{d}", String(q.window_days))}</p>
      {q.limit !== null && <div role="meter" aria-valuemin={0} aria-valuemax={q.limit} aria-valuenow={q.used} aria-label={s("quota.title")} className="h-3 border border-black bg-white"><div className="h-full bg-black" style={{ width: `${pct}%` }} /></div>}
      {!q.allowed && <p className="text-sm font-bold" data-testid="quota-blocked">{s("quota.blocked")}{q.resets_at ? ` ${s("quota.resets")} ${fmtDate(q.resets_at, lang)}.` : ""}</p>}
      <p className="text-xs">{s("quota.equal")}</p>
    </div>
  );
}

const ORDER = ["draft", "in_review", "approved", "open", "closed"] as const;
function Timeline({ sv }: { sv: SurveyDetail }) {
  const s = useSurveyT();
  const { lang } = useT();
  const at: Record<string, string | null> = { draft: null, in_review: sv.registered_at, approved: sv.approved_at, open: sv.opened_at, closed: sv.status === "closed" ? sv.closed_at : null };
  const idx = sv.status === "cancelled" ? -1 : ORDER.indexOf(sv.status as (typeof ORDER)[number]);
  return (
    <ol className="flex flex-wrap gap-2 text-xs" data-testid="timeline" aria-label={s("con.timeline")}>
      {ORDER.map((k, i) => <li key={k} aria-current={i === idx ? "step" : undefined} data-done={i <= idx ? "1" : "0"} className={`border px-2 py-1 ${i <= idx ? "border-black bg-black text-white" : "border-black/40 bg-white text-black"}`}>{s(`st.${k}` as SurveyKey)}{at[k] ? ` ${fmtDate(at[k], lang)}` : ""}</li>)}
      {sv.status === "cancelled" && <li aria-current="step" className="border border-red-800 bg-red-50 text-black px-2 py-1">{s("st.cancelled")}</li>}
    </ol>
  );
}

function CancelForm({ id, onDone }: { id: string; onDone: () => void }) {
  const s = useSurveyT();
  const errMsg = useErrorMessage();
  const [code, setCode] = useState(""), [text, setText] = useState(""), [err, setErr] = useState<string | null>(null);
  const ok = !!code && text.trim().length >= 10;
  return (
    <form className="space-y-2 border border-red-800 p-3 bg-white text-black" data-testid="cancel-form" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await surveysApi.cancel(id, code, text.trim()); onDone(); } catch (x) { setErr(errMsg(x)); } }}>
      <p className="text-sm font-bold">{s("cancel.publicNote")}</p>
      <label className="block text-sm font-bold">{s("cancel.code")}
        <select data-testid="cancel-code" className={inputCls + " font-normal"} value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">{s("take.choose")}</option>{REASONS.map((r) => <option key={r} value={r}>{s(`reason.${r}` as SurveyKey)}</option>)}
        </select>
      </label>
      <label className="block text-sm font-bold">{s("cancel.text")}
        <textarea data-testid="cancel-text" className={inputCls + " font-normal"} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <ErrorLine msg={err} />
      <Btn type="submit" data-testid="cancel-submit" disabled={!ok}>{s("cancel.submit")}</Btn>
    </form>
  );
}

function MyRow({ sv, reload }: Keyed & { sv: SurveyDetail; reload: () => void }) {
  const s = useSurveyT();
  const { lang } = useT();
  const errMsg = useErrorMessage();
  const [err, setErr] = useState<string | null>(null), [cancel, setCancel] = useState(false);
  const act = (fn: () => Promise<unknown>) => async () => { setErr(null); try { await fn(); reload(); } catch (x) { setErr(errMsg(x)); } };
  return (
    <li className={card} data-testid="my-survey" data-survey-id={sv.id} data-status={sv.status}>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge status={sv.status} /><code title={sv.wording_hash}>{shortHash(sv.wording_hash)}</code></div>
      <h3 className="font-bold break-words">{sv.status === "draft" ? sv.title_en : <a className={linkCls} href={`#/surveys/${sv.id}`}>{titleOf(sv, lang)}</a>}</h3>
      <Timeline sv={sv} />
      {sv.status === "draft" && <FindingsList items={sv.findings ?? []} />}
      {sv.status === "in_review" && <p className="text-sm" data-testid="my-panel">{s("det.panelSummary").replace("{a}", String(sv.panel.approvals)).replace("{r}", String(sv.panel.required_approvals))}</p>}
      {sv.panel.decisions.filter((d) => d.decision === "reject").map((d, i) => <p key={i} className="text-sm" data-testid="my-reject-note">{s("pan.reject")}: {d.notes}</p>)}
      <ErrorLine msg={err} />
      <div className="flex flex-wrap gap-2">
        {sv.status === "draft" && <a className="sv-btn px-4 py-2 text-sm font-bold border border-black bg-white text-black no-underline" href={`#/surveys/edit/${sv.id}`} data-testid="my-edit">{s("con.edit")}</a>}
        {sv.status === "draft" && <Btn data-testid="my-submit" onClick={act(() => surveysApi.submit(sv.id))}>{s("con.submit")}</Btn>}
        {sv.status === "approved" && <Btn data-testid="my-open" onClick={act(() => surveysApi.open(sv.id))}>{s("con.open")}</Btn>}
        {sv.status === "open" && <Btn secondary data-testid="my-close" onClick={act(() => surveysApi.close(sv.id))}>{s("con.close")}</Btn>}
        {["in_review", "approved", "open"].includes(sv.status) && <Btn secondary data-testid="my-cancel" aria-expanded={cancel} onClick={() => setCancel(!cancel)}>{s("con.cancel")}</Btn>}
      </div>
      {cancel && <CancelForm id={sv.id} onDone={() => { setCancel(false); reload(); }} />}
    </li>
  );
}

export function ConsolePage() {
  const s = useSurveyT();
  const me = useCreatorGate();
  const [topic, setTopic] = useState<TopicClass>("issue_service");
  const [orgKind, setOrgKind] = useState("");
  const mine = useLoad(() => (me.isCreator ? surveysApi.mine() : Promise.resolve(null)), [me.isCreator]);
  return (
    <Page title={s("con.title")} back={{ label: s("nav.registry"), to: "#/surveys" }}>
      <Disclaimer />
      <ProtectionBox compact />
      <Gate me={me} need="creator">
        <section className={card} aria-label={s("quota.title")}>
          <h2 className="text-lg font-bold">{s("quota.title")}</h2>
          <label className="block text-sm font-bold">{s("f.topic")}
            <select data-testid="quota-topic" className={inputCls + " font-normal"} value={topic} onChange={(e) => setTopic(e.target.value as TopicClass)}>{TOPICS.map((t) => <option key={t} value={t}>{s(`topic.${t}` as SurveyKey)}</option>)}</select>
          </label>
          {me.roles.includes("admin") && (
            <label className="block text-sm font-bold">{s("bld.orgKind")}
              <select data-testid="quota-org" className={inputCls + " font-normal"} value={orgKind} onChange={(e) => setOrgKind(e.target.value)}><option value="">{s("org.platform")}</option><option value="academic">{s("org.academic")}</option><option value="civil_society">{s("org.civil_society")}</option></select>
            </label>
          )}
          <QuotaMeter topic={topic} org={orgKind ? { org_kind: orgKind } : undefined} />
        </section>
        <div className="flex flex-wrap gap-3">
          <a className="sv-btn px-4 py-2 text-sm font-bold border border-black bg-black text-white no-underline" href="#/surveys/new" data-testid="con-new">{s("con.new")}</a>
          {me.isPanel && <a className="sv-btn px-4 py-2 text-sm font-bold border border-black bg-white text-black no-underline" href="#/surveys/panel" data-testid="con-panel">{s("pan.title")}</a>}
        </div>
        <section aria-label={s("con.mine")} className="space-y-3">
          <h2 className="text-lg font-bold">{s("con.mine")}</h2>
          {mine.error != null && <ErrorLine msg={s("err.load")} />}
          <ul className="space-y-3" data-testid="my-list">{(mine.data?.surveys ?? []).map((sv) => <MyRow key={sv.id} sv={sv} reload={mine.reload} />)}</ul>
          {mine.data && mine.data.surveys.length === 0 && <p role="status">{s("con.none")}</p>}
        </section>
      </Gate>
      {me.signedIn && !me.isCreator && me.isPanel && (
        <p><a className={linkCls} href="#/surveys/panel" data-testid="con-panel-only">{s("pan.title")}</a></p>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- builder
export function BuilderPage({ editId }: Keyed & { editId?: string }) {
  const s = useSurveyT();
  const me = useCreatorGate();
  const errMsg = useErrorMessage();
  const [form, setForm] = useState<Form>(blankForm);
  const [draftId, setDraftId] = useState<string | null>(editId ?? null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [err, setErr] = useState<string | null>(null), [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [loaded, setLoaded] = useState(!editId);
  const dirty = useRef(false);
  const idRef = useRef<string | null>(editId ?? null);

  useEffect(() => {
    if (!editId || !me.isCreator) return;
    surveysApi.mine().then((r) => { const sv = r.surveys.find((x) => x.id === editId && x.status === "draft"); if (sv) { setForm(formFrom(sv)); setFindings(sv.findings ?? []); } setLoaded(true); }).catch(() => setLoaded(true));
  }, [editId, me.isCreator]);

  const save = async (): Promise<string | null> => {
    setErr(null); setStatus("saving");
    try {
      const body = toInput(form);
      const r = idRef.current ? await surveysApi.update(idRef.current, body) : await surveysApi.create(body);
      idRef.current = r.id ?? idRef.current; setDraftId(idRef.current); setFindings(r.findings ?? []); setStatus("saved"); dirty.current = false;
      return idRef.current;
    } catch (x) { setStatus("idle"); setErr(errMsg(x)); if (x instanceof CivicApiError && Array.isArray(x.body.findings)) setFindings(x.body.findings as Finding[]); return null; }
  };
  // live wording check: the draft is saved a moment after the last edit and the server's findings are shown
  useEffect(() => {
    if (!loaded || !me.isCreator || !dirty.current || !sendable(form)) return;
    const t = setTimeout(() => { void save(); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, loaded, me.isCreator]);

  const set = (p: Partial<Form>) => { dirty.current = true; setForm((f) => ({ ...f, ...p })); };
  const setQ = (i: number, p: Partial<QF>) => set({ questions: form.questions.map((q, j) => (j === i ? { ...q, ...p } : q)) });
  const setO = (i: number, k: number, p: Partial<OptF>) => setQ(i, { options: form.questions[i].options.map((o, j) => (j === k ? { ...o, ...p } : o)) });

  const submit = async () => {
    const id = await save();
    if (!id) return;
    try { await surveysApi.submit(id); go("#/surveys/console"); } catch (x) {
      setErr(errMsg(x));
      if (x instanceof CivicApiError && Array.isArray(x.body.findings)) setFindings(x.body.findings as Finding[]);
    }
  };

  const lbl = "block text-sm font-bold space-y-1";
  return (
    <Page title={s("bld.title")} back={{ label: s("con.title"), to: "#/surveys/console" }}>
      <Disclaimer />
      <Gate me={me} need="creator">
        <form className="space-y-4" data-testid="builder" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <section className={card}>
            <label className={lbl}>{s("f.topic")}
              <select data-testid="bld-topic" className={inputCls + " font-normal"} value={form.topic_class} onChange={(e) => set({ topic_class: e.target.value as TopicClass })}>{TOPICS.map((t) => <option key={t} value={t}>{s(`topic.${t}` as SurveyKey)}</option>)}</select>
            </label>
            {form.topic_class === "political" && <label className="flex items-center gap-3 min-h-[44px] text-sm"><input type="checkbox" data-testid="bld-party-pref" checked={form.asks_party_preference} onChange={(e) => set({ asks_party_preference: e.target.checked })} />{s("bld.partyPref")}</label>}
            {me.roles.includes("admin") && !me.roles.some((r) => ["politician", "officer", "journalist"].includes(r)) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className={lbl}>{s("bld.orgKind")}<select data-testid="bld-org-kind" className={inputCls + " font-normal"} value={form.org_kind} onChange={(e) => set({ org_kind: e.target.value })}><option value="">{s("org.platform")}</option><option value="academic">{s("org.academic")}</option><option value="civil_society">{s("org.civil_society")}</option></select></label>
                <label className={lbl}>{s("bld.orgCode")}<input data-testid="bld-org-code" className={inputCls + " font-normal"} value={form.org_code} onChange={(e) => set({ org_code: e.target.value })} /></label>
              </div>
            )}
            <label className={lbl}>{s("bld.titleEn")}<input data-testid="bld-title-en" className={inputCls + " font-normal"} value={form.title_en} onChange={(e) => set({ title_en: e.target.value })} /></label>
            <label className={lbl}>{s("bld.titleTe")}<input data-testid="bld-title-te" lang="te" className={inputCls + " font-normal"} value={form.title_te} onChange={(e) => set({ title_te: e.target.value })} /></label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className={lbl}>{s("f.state")}<select data-testid="bld-state" className={inputCls + " font-normal"} value={form.state} onChange={(e) => set({ state: e.target.value })}><option>AP</option><option>TG</option></select></label>
              <label className={lbl}>{s("bld.districts")}<input data-testid="bld-district" className={inputCls + " font-normal"} value={form.district} onChange={(e) => set({ district: e.target.value })} /></label>
              <label className={lbl}>{s("bld.mandals")}<input data-testid="bld-mandal" className={inputCls + " font-normal"} value={form.mandal} onChange={(e) => set({ mandal: e.target.value })} /></label>
            </div>
            <p className="text-xs">{s("bld.scopeHint")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className={lbl}>{s("bld.opens")}<input type="datetime-local" data-testid="bld-opens" className={inputCls + " font-normal"} value={form.opens} onChange={(e) => set({ opens: e.target.value })} /></label>
              <label className={lbl}>{s("bld.closes")}<input type="datetime-local" data-testid="bld-closes" className={inputCls + " font-normal"} value={form.closes} onChange={(e) => set({ closes: e.target.value })} /></label>
            </div>
          </section>
          {form.questions.map((q, i) => (
            <fieldset key={i} className={card} data-testid="bld-question">
              <legend className="font-bold px-1">{s("bld.question")} {i + 1}</legend>
              <label className={lbl}>{s("bld.kind")}
                <select data-testid="bld-kind" className={inputCls + " font-normal"} value={q.kind} onChange={(e) => setQ(i, { kind: e.target.value as QF["kind"] })}>
                  <option value="single">{s("bld.kind.single")}</option><option value="multi">{s("bld.kind.multi")}</option><option value="scale5">{s("bld.kind.scale5")}</option>
                </select>
              </label>
              <label className={lbl}>{s("bld.textEn")}<input data-testid="bld-text-en" className={inputCls + " font-normal"} value={q.text_en} onChange={(e) => setQ(i, { text_en: e.target.value })} /></label>
              <label className={lbl}>{s("bld.textTe")}<input data-testid="bld-text-te" lang="te" className={inputCls + " font-normal"} value={q.text_te} onChange={(e) => setQ(i, { text_te: e.target.value })} /></label>
              {q.kind === "multi" && <label className={lbl}>{s("bld.maxSelect")}<input type="number" min={2} data-testid="bld-max" className={inputCls + " font-normal"} value={q.max_select} onChange={(e) => setQ(i, { max_select: Number(e.target.value) })} /></label>}
              {q.kind === "scale5" ? (
                <>
                  <p className="text-sm">{s("bld.scaleFixed")}</p>
                  <label className="flex items-center gap-3 min-h-[44px] text-sm"><input type="checkbox" data-testid="bld-scale-pn" checked={q.preferNot} onChange={(e) => setQ(i, { preferNot: e.target.checked })} />{s("bld.addPreferNot")}</label>
                </>
              ) : (
                <div className="space-y-2">
                  {q.options.map((o, k) => (
                    <div key={k} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end" data-testid="bld-option">
                      <label className={lbl}>{s("bld.optEn")} {k + 1}<input data-testid="bld-opt-en" className={inputCls + " font-normal"} value={o.label_en} onChange={(e) => setO(i, k, { label_en: e.target.value })} /></label>
                      <label className={lbl}>{s("bld.optTe")} {k + 1}<input data-testid="bld-opt-te" lang="te" className={inputCls + " font-normal"} value={o.label_te} onChange={(e) => setO(i, k, { label_te: e.target.value })} /></label>
                      <label className="flex items-center gap-2 min-h-[44px] text-sm"><input type="checkbox" data-testid="bld-opt-pn" checked={o.prefer_not} onChange={(e) => setO(i, k, { prefer_not: e.target.checked })} />{s("bld.preferNot")}</label>
                      <Btn secondary aria-label={`${s("bld.removeOpt")} ${k + 1}`} disabled={q.options.length <= 2} onClick={() => setQ(i, { options: q.options.filter((_, j) => j !== k) })}>{s("bld.remove")}</Btn>
                    </div>
                  ))}
                  <Btn secondary data-testid="bld-add-opt" disabled={q.options.length >= 8} onClick={() => setQ(i, { options: [...q.options, { label_en: "", label_te: "", prefer_not: false }] })}>{s("bld.addOpt")}</Btn>
                </div>
              )}
              {form.questions.length > 1 && <Btn secondary onClick={() => set({ questions: form.questions.filter((_, j) => j !== i) })}>{s("bld.removeQ")}</Btn>}
            </fieldset>
          ))}
          <Btn secondary data-testid="bld-add-q" disabled={form.questions.length >= 10} onClick={() => set({ questions: [...form.questions, blankQ()] })}>{s("bld.addQ")}</Btn>
          <section className={card} aria-live="polite">
            <h2 className="font-bold">{s("bld.findings")}</h2>
            <p className="text-xs" data-testid="bld-status">{status === "saving" ? s("bld.saving") : status === "saved" ? s("bld.saved") : s("bld.unsaved")}</p>
            <FindingsList items={findings} />
          </section>
          <ErrorLine msg={err} />
          <p className="text-sm font-bold">{s("bld.freezeNote")}</p>
          <div className="flex flex-wrap gap-3">
            <Btn type="submit" secondary data-testid="bld-save" disabled={!sendable(form)}>{s("bld.save")}</Btn>
            <Btn data-testid="bld-submit" disabled={!sendable(form)} onClick={() => void submit()}>{s("con.submit")}</Btn>
          </div>
          {draftId && <p className="text-xs">{s("bld.draftId")}: <code>{draftId.slice(0, 8)}</code></p>}
        </form>
      </Gate>
    </Page>
  );
}
