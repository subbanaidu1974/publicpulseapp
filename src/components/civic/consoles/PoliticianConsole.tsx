import { useEffect, useState } from "react";
import { CivicApiError, representativesApi, type ReplyVersion, type SchemeTagInfo } from "../../../api/civic";
import { useT } from "../../../i18n";
import { useCivicT, type CivicKey } from "../civicText";
import { Btn, ErrorNote, Field, TextInput, inputCls } from "../ui";

const errKey = (code: string, status: number): CivicKey => ({
  outside_scope: "c.rep.errScope", reply_exists: "c.rep.errExists", not_author: "c.rep.errAuthor", bad_length: "c.rep.errLen", bad_tags: "c.rep.errTags", unknown_scheme: "c.rep.errTags",
  too_many_tags: "c.rep.errTags", rate_limited: "c.rep.errRate", no_change: "c.rep.errSame", role_required: "c.cons.403",
} as Record<string, CivicKey>)[code] ?? (status === 404 ? "c.rep.errNone" : status === 403 ? "c.cons.403" : status === 401 ? "c.cons.401" : "c.error");

/**
 * Representative console (S-145): post one labelled official reply on an issue in your constituency, or add a new version of it. Versions are
 * appended, never edited in place. The server decides scope and moderation; a version it holds is shown here as waiting for a moderator.
 */
export default function PoliticianConsole() {
  const c = useCivicT();
  const { lang } = useT();
  const [issue, setIssue] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [versions, setVersions] = useState<ReplyVersion[]>([]);
  const [schemes, setSchemes] = useState<SchemeTagInfo[]>([]);
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { representativesApi.schemes().then(setSchemes).catch(() => { /* tags are optional */ }); }, []);
  const fail = (e: unknown) => setErr(c(e instanceof CivicApiError ? errKey(String((e.body as { code?: unknown }).code ?? ""), e.status) : "c.error"));
  const load = async () => {
    setErr(null); setMsg(null);
    const id = issue.trim();
    try { setVersions(await representativesApi.mine(id)); } catch (e) { if (e instanceof CivicApiError && e.status === 404) setVersions([]); else return fail(e); }
    setLoaded(id);
  };
  const has = versions.length > 0;
  const toggle = (id: string) => setTags((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length >= 3 ? t : [...t, id]));
  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const v = has ? await representativesApi.revise(loaded!, text, tags) : await representativesApi.post(loaded!, text, tags);
      setMsg(v.status === "held" ? c("c.rep.held") : c("c.rep.saved")); setText("");
      setVersions(await representativesApi.mine(loaded!));
    } catch (e) { fail(e); }
  };
  const tagLabel = (s: SchemeTagInfo) => (lang === "te" ? s.labelTe : s.labelEn);
  return (
    <section data-testid="politician-console" aria-labelledby="pc-h" className="space-y-3">
      <h3 id="pc-h" className="text-lg font-bold">{c("c.rep.title")}</h3>
      <p className="text-sm">{c("c.rep.help")}</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <Field id="pc-issue" label={c("c.rep.issue")}><TextInput id="pc-issue" data-testid="pc-issue" value={issue} onChange={(e) => setIssue(e.target.value)} /></Field>
        <button type="submit" data-testid="pc-load" disabled={issue.trim().length < 6} className="min-h-[44px] px-4 border border-black bg-black text-white font-bold disabled:opacity-60">{c("c.rep.load")}</button>
      </form>
      {loaded && (
        <>
          {has && (
            <div className="text-sm space-y-1">
              <p className="font-bold">{c("c.rep.versions")}</p>
              <ol data-testid="pc-versions" className="space-y-1">
                {versions.map((v) => <li key={v.id} className="border border-black p-2 break-words"><span className="text-xs">{c("c.rep.version")} {v.version} - {c(`c.rep.s.${v.status}` as CivicKey)}</span><br />{v.text}</li>)}
              </ol>
            </div>
          )}
          <Field id="pc-text" label={c("c.rep.text")}><textarea id="pc-text" data-testid="pc-text" className={inputCls} rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {schemes.length > 0 && (
            <fieldset className="space-y-1"><legend className="text-sm font-bold">{c("c.rep.tags")}</legend>
              {schemes.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" data-testid={`pc-tag-${s.id}`} className="w-5 h-5" checked={tags.includes(s.id)} disabled={!tags.includes(s.id) && tags.length >= 3} onChange={() => toggle(s.id)} />{tagLabel(s)}</label>
              ))}
            </fieldset>
          )}
          <Btn data-testid="pc-save" disabled={text.trim().length < 20} onClick={() => void save()}>{has ? c("c.rep.revise") : c("c.rep.post")}</Btn>
        </>
      )}
      {msg && <p role="status" data-testid="pc-msg">{msg}</p>}
      <ErrorNote msg={err} />
    </section>
  );
}
