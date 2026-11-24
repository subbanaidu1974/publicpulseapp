import { FormEvent, ReactNode, useState } from "react";
import { PartyChangesSection } from "../analytics/blocks";
import type { ContestantHit, ContestantRecord, OfficeHolder } from "../../api/people";
import { peopleApi, useContestant, useMemberRoster, useOfficeHolders, useParty, usePartyList } from "../../api/people";
import { useApi } from "../../api/useApi";
import { ErrorBanner, Loading } from "../ui";
import { BlackoutNotice, PartyChip, PersonAvatar, ProfileShell, ReportControl, peopleHref } from "./common";
import { usePT } from "./peopleText";
import type { PKey } from "./peopleText";

const num = (n: number) => n.toLocaleString("en-IN");
const signed = (n: number) => (n > 0 ? "+" : "") + num(n);

function Wait({ s, children }: { s: { loading: boolean; error: string | null; retry: () => void }; children: ReactNode }) {
  if (s.loading) return <Loading />;
  if (s.error) return <ErrorBanner message={s.error} onRetry={s.retry} />;
  return <>{children}</>;
}

/* ---------------- home: search + lists ---------------- */

export function PeopleHome() {
  const { p, lang } = usePT();
  const parties = usePartyList();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ContestantHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (q.replace(/[^A-Za-zఀ-౿]/g, "").length < 2) { setHits(null); setErr(p("ppl.search.hint")); return; }
    try { setHits((await peopleApi.search(q)).results); } catch { setHits(null); setErr(p("ppl.error")); }
  }
  return (
    <div data-testid="people-home" className="space-y-8 font-sans">
      <header className="space-y-2 border-b border-black pb-4">
        <h1 className="font-serif text-4xl">{p("ppl.title")}</h1>
        <p className="text-sm max-w-2xl">{p("ppl.intro")}</p>
        <nav className="flex flex-wrap gap-4 text-xs font-bold uppercase tracking-widest" aria-label={p("ppl.title")}>
          <a data-testid="people-link-leaders" className="underline" href={peopleHref("leaders")}>{p("ppl.leaders")}</a>
          <a data-testid="people-link-members" className="underline" href={peopleHref("members", "AP", "assembly")}>{p("ppl.members")}</a>
          <a data-testid="people-link-process" className="underline" href={peopleHref("process")}>{p("ppl.process")}</a>
        </nav>
      </header>
      <section className="space-y-3">
        <form onSubmit={go} role="search" className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-bold">{p("ppl.search.label")}
            <input data-testid="people-search" value={q} onChange={e => setQ(e.target.value)} maxLength={60} className="block mt-1 border border-black bg-white px-2 py-1.5 text-sm font-normal w-64 max-w-full" />
          </label>
          <button data-testid="people-search-go" type="submit" className="border border-black bg-black text-[#FAF8F5] px-4 py-2 text-[11px] font-black uppercase tracking-widest cursor-pointer">{p("ppl.search.go")}</button>
        </form>
        <p className="text-[11px] text-black/70">{p("ppl.search.hint")}</p>
        {err && <p role="alert" className="text-xs text-red-800">{err}</p>}
        {hits && (hits.length === 0 ? <p data-testid="people-search-none" className="text-sm">{p("ppl.search.none")}</p> : (
          <ul data-testid="people-search-results" className="divide-y divide-black/10 border border-black/20">
            {hits.map(h => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <a data-testid="people-hit" className="font-bold underline" href={peopleHref("candidate", h.id)}>{h.name}</a>
                <PartyChip party={h.party} lang={lang} />
                <span className="text-xs">{h.acName} ({h.state}, {h.type === "ls" ? p("ppl.members.ls") : p("ppl.members.assembly")} {h.year})</span>
              </li>
            ))}
          </ul>
        ))}
      </section>
      <section className="space-y-2">
        <h2 className="text-xs font-black uppercase tracking-[0.2em] border-b border-black/20 pb-1">{p("ppl.parties")}</h2>
        <Wait s={parties}>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" data-testid="party-list">
            {parties.data?.parties.map(x => (
              <li key={x.code}><PartyChip party={{ ...x }} media lang={lang} /></li>
            ))}
          </ul>
        </Wait>
      </section>
    </div>
  );
}

/* ---------------- party profile (S-106) ---------------- */

export function PartyProfilePage({ code }: { code: string }) {
  const { p, lang } = usePT();
  const s = useParty(code);
  return (
    <Wait s={s}>
      {s.data && (() => {
        const d = s.data;
        const media = [d.flag, d.symbol].filter((m): m is NonNullable<typeof d.flag> => !!m);
        return (
          <ProfileShell
            kind="party"
            title={<>{lang === "te" && d.name.te ? d.name.te : d.name.en}</>}
            sub={<PartyChip party={{ code: d.code, name: d.name.en, nameTe: d.name.te, color: d.color }} lang={lang} href={false} />}
            sections={[
              { id: "identity", heading: p("ppl.party.identity"), body: (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="font-bold">{p("ppl.party.founded")}</dt>
                  <dd data-testid="party-founded">{d.founded ? <>{d.founded.year} <span className="text-xs text-black/70">({p("ppl.party.confidence")}: {d.founded.confidence})</span></> : p("ppl.cand.na")}</dd>
                  <dt className="font-bold">{p("ppl.party.wikidata")}</dt>
                  <dd>{d.wikidata ? <a data-testid="party-wikidata" className="underline" href={d.wikidata.url} target="_blank" rel="noopener noreferrer">{d.wikidata.qid}</a> : p("ppl.cand.na")}</dd>
                  {d.website && (<><dt className="font-bold">Web</dt><dd><a className="underline break-all" href={d.website} target="_blank" rel="noopener noreferrer">{d.website}</a></dd></>)}
                </dl>
              ) },
              { id: "media", heading: p("ppl.party.media"), body: media.length ? (
                <div className="flex flex-wrap gap-4">
                  {media.map(m => (
                    <figure key={m.path} className="border border-black/20 p-2 space-y-1 max-w-[12rem]">
                      <img data-testid={`party-media-${m.kind}`} src={m.path} alt="" className="h-20 w-auto object-contain" />
                      <figcaption className="text-[10px] space-y-0.5">
                        <span className="block">{m.author}, <a className="underline" href={m.licenceUrl ?? m.source} target="_blank" rel="noopener noreferrer">{m.licence}</a></span>
                        <a className="underline" href={m.source} target="_blank" rel="noopener noreferrer">{p("ppl.photo.source")}</a>
                        {m.use === "identification-only" && <span data-testid="identonly-caption" className="block font-bold">{p("ppl.party.identonly")}</span>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : <p data-testid="party-nomedia">{p("ppl.party.nomedia")}</p> },
              { id: "elections", heading: p("ppl.party.elections"), body: (
                <div className="overflow-x-auto">
                  <table data-testid="party-elections" className="w-full text-xs border-collapse min-w-[34rem]">
                    <thead><tr className="text-left border-b border-black">
                      <th className="py-1 pr-2">Election</th><th className="pr-2">{p("ppl.party.seats")}</th><th className="pr-2">{p("ppl.party.contested")}</th><th className="pr-2">{p("ppl.party.share")}</th><th>{p("ppl.party.alliances")}</th>
                    </tr></thead>
                    <tbody>
                      {d.elections.map(e => (
                        <tr key={`${e.state}${e.type}${e.year}`} data-testid="party-election-row" className="border-b border-black/10 align-top">
                          <td className="py-1 pr-2 font-bold">{e.state} {e.type === "ls" ? p("ppl.members.ls") : p("ppl.members.assembly")} {e.year}</td>
                          <td className="pr-2">{e.seatsWon} / {e.totalSeats}</td>
                          <td className="pr-2">{e.contested}</td>
                          <td className="pr-2">{e.voteSharePct === null ? p("ppl.cand.na") : `${e.voteSharePct.toFixed(2)}%`}</td>
                          <td>{e.alliances.length ? e.alliances.map(a => (
                            <div key={a.name} data-testid="alliance-label" data-kind={a.kind}>
                              {a.name}: <em>{a.kind === "pre-poll" ? p("ppl.party.prepoll") : p("ppl.party.posthoc")}</em>
                              {a.sources[0] && <> (<a className="underline" href={a.sources[0]} target="_blank" rel="noopener noreferrer">{p("ppl.photo.source")}</a>)</>}
                            </div>
                          )) : <span className="text-black/60">{p("ppl.party.noalliance")}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) },
              { id: "leaders", heading: p("ppl.party.leaders"), body: (
                <>
                  <BlackoutNotice notice={d.notice} />
                  {!d.blackout && (d.leaders.length ? <ul>{d.leaders.map(l => <li key={l.id}>{l.person}, {l.role} ({l.state}) {p("ppl.leaders.since")} {l.start}</li>)}</ul> : <p>{p("ppl.party.noleaders")}</p>)}
                </>
              ) },
              { id: "sources", heading: p("ppl.party.sources"), body: (
                <ul className="list-disc pl-5">{d.sources.map(x => <li key={x.url}><a className="underline inline-block py-1" href={x.url} target="_blank" rel="noopener noreferrer">{x.name}</a></li>)}</ul>
              ) },
            ]}
            report={<ReportControl page={`/people/party/${d.code}`} />}
          />
        );
      })()}
    </Wait>
  );
}

/* ---------------- contestant profile (S-109) ---------------- */

function RecordRow({ r }: { r: ContestantRecord; key?: string }) {
  const { p } = usePT();
  return (
    <tr data-testid="record-row" className="border-b border-black/10">
      <td className="py-1 pr-2 font-bold"><a className="underline" href={peopleHref("candidate", r.id)}>{r.state} {r.type === "ls" ? p("ppl.members.ls") : p("ppl.members.assembly")} {r.year}</a></td>
      <td className="pr-2">{r.acName}</td>
      <td className="pr-2">{num(r.votes)}</td>
      <td className="pr-2">{r.voteSharePct === null ? p("ppl.cand.na") : `${r.voteSharePct.toFixed(2)}%`}</td>
      <td className="pr-2">{r.position}{r.won ? ` (${p("ppl.cand.won")})` : ""}</td>
      <td>{r.marginVotes === null ? p("ppl.cand.na") : signed(r.marginVotes)}</td>
    </tr>
  );
}

export function ContestantPage({ id }: { id: string }) {
  const { p, lang } = usePT();
  const s = useContestant(id);
  return (
    <Wait s={s}>
      {s.data && (() => {
        const d = s.data;
        const yn = (v: boolean | null) => (v === null ? p("ppl.cand.na") : v ? p("ppl.cand.yes") : p("ppl.cand.no"));
        return (
          <ProfileShell
            kind="candidate"
            title={d.name}
            sub={<PartyChip party={d.party} lang={lang} />}
            sections={[
              { id: "identity", heading: p("ppl.cand.identity"), body: (
                <p>{d.record.acName}, {d.record.state} {d.record.type === "ls" ? p("ppl.members.ls") : p("ppl.members.assembly")} {d.record.year}{d.record.district ? `, ${d.record.district}` : ""}</p>
              ) },
              { id: "record", heading: p("ppl.cand.record"), body: (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="font-bold">{p("ppl.cand.votes")}</dt><dd data-testid="cand-votes">{num(d.record.votes)}</dd>
                  <dt className="font-bold">{p("ppl.cand.share")}</dt><dd>{d.record.voteSharePct === null ? p("ppl.cand.na") : `${d.record.voteSharePct.toFixed(2)}%`}</dd>
                  <dt className="font-bold">{p("ppl.cand.position")}</dt><dd data-testid="cand-position">{d.record.position}{d.record.won ? ` (${p("ppl.cand.won")})` : ""}</dd>
                  <dt className="font-bold">{p("ppl.cand.margin")}</dt>
                  <dd>{d.record.marginVotes === null ? p("ppl.cand.na") : `${num(Math.abs(d.record.marginVotes))} ${d.record.marginVotes >= 0 ? p("ppl.cand.ahead") : p("ppl.cand.behind")}`}</dd>
                </dl>
              ) },
              { id: "attributes", heading: p("ppl.cand.attributes"), body: (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="font-bold">{p("ppl.cand.sex")}</dt><dd data-testid="cand-sex">{d.attributes.sex ?? p("ppl.cand.na")}</dd>
                  <dt className="font-bold">{p("ppl.cand.age")}</dt><dd data-testid="cand-age">{d.attributes.age ?? p("ppl.cand.na")}</dd>
                  <dt className="font-bold">{p("ppl.cand.incumbent")}</dt><dd data-testid="cand-incumbent">{yn(d.attributes.incumbent)}</dd>
                </dl>
              ) },
              { id: "otherElections", heading: p("ppl.cand.other"), body: d.otherElections.length ? (
                <div className="overflow-x-auto">
                  <p className="text-xs text-black/70 mb-1">{p("ppl.cand.other.note")}</p>
                  <table className="w-full text-xs border-collapse min-w-[30rem]"><tbody>{d.otherElections.map(r => <RecordRow key={r.id} r={r} />)}</tbody></table>
                </div>
              ) : <p>{p("ppl.cand.none")}</p> },
              { id: "links", heading: p("ppl.cand.links"), body: (
                <>
                  <ul className="list-disc pl-5">{d.links.map(l => <li key={l.url}><a data-testid="affidavit-link" className="underline break-words" href={l.url} target="_blank" rel="noopener noreferrer">{lang === "te" ? l.labelTe : l.label}</a></li>)}</ul>
                  <p data-testid="affidavit-note" className="text-[11px] text-black/70 mt-1">{p("ppl.cand.links.note")}</p>
                </>
              ) },
              { id: "source", heading: p("ppl.cand.source"), body: <p>{d.source.attribution}{d.source.provenance ? ` (${d.source.provenance})` : ""}</p> },
            ]}
            report={<><PartyChangesSection name={d.name} state={d.record.state} acNo={d.record.acNo} type={d.record.type} /><ReportControl page={`/people/candidate/${d.id}`} /></>}
          />
        );
      })()}
    </Wait>
  );
}

/* ---------------- office holders (S-107) ---------------- */

const MINISTER_ROLE = "Minister";
type Holder = OfficeHolder & { constituency?: string; portfolio?: string[]; portfolioAsOf?: string };

function holderItem(o: Holder, p: (k: PKey) => string) {
  return (
    <li key={o.id} data-testid="office-holder" className="border border-black/20 p-2">
      <strong>{o.role}</strong>: {o.person}
      <span className="ml-2"><PartyChip party={{ code: o.party, name: o.party, nameTe: null, color: "#555" }} /></span>
      {o.constituency && <span className="block text-xs">{p("ppl.leaders.constituency")}: {o.constituency}</span>}
      {o.portfolio && o.portfolio.length > 0 && <span className="block text-xs" data-testid="office-portfolio">{p("ppl.leaders.portfolio")}: {o.portfolio.join("; ")}{o.portfolioAsOf ? ` (${p("ppl.leaders.portfolioasof")} ${o.portfolioAsOf})` : ""}</span>}
      <span className="block text-xs">{p("ppl.leaders.since")} {o.start}. {p("ppl.leaders.asof")} {o.asOf} ({p("ppl.party.confidence")}: {o.confidence})</span>
      <span className="block text-[11px]">{p("ppl.leaders.sources")}: {o.sources.map((u, i) => <a key={u} className="underline mr-2" href={u} target="_blank" rel="noopener noreferrer">{i + 1}</a>)}</span>
    </li>
  );
}

export function LeadersPage() {
  const { p } = usePT();
  const s = useOfficeHolders();
  return (
    <Wait s={s}>
      {s.data && (
        <ProfileShell
          kind="leaders" title={p("ppl.leaders.title")}
          sections={[{ id: "list", heading: p("ppl.leaders"), body: (
            <>
              <BlackoutNotice notice={s.data.notice} />
              {!s.data.blackout && (["AP", "TG"] as const).map(st => {
                const mine = (s.data!.officeHolders as Holder[]).filter(o => o.state === st);
                const ministers = mine.filter(o => o.role === MINISTER_ROLE).sort((a, b) => a.person.localeCompare(b.person, "en"));
                return (
                  <div key={st} className="mb-4">
                    <h3 className="font-bold mb-1">{p(`ppl.state.${st}` as PKey)}</h3>
                    <ul className="space-y-2">
                      {mine.filter(o => o.role !== MINISTER_ROLE).map(o => holderItem(o, p))}
                    </ul>
                    {ministers.length > 0 && (
                      <>
                        <h4 className="font-bold mt-3 mb-1" data-testid="ministers-heading">{p("ppl.leaders.ministers")}</h4>
                        <p className="text-xs text-black/70 mb-1">{p("ppl.leaders.ministers.note")}</p>
                        <ul className="space-y-2">{ministers.map(o => holderItem(o, p))}</ul>
                      </>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-black/70">{p("ppl.leaders.note")}</p>
            </>
          ) }]}
          report={<ReportControl page="/people/leaders" />}
        />
      )}
    </Wait>
  );
}

/* ---------------- members roster (S-108) ---------------- */

export function MembersPage({ state, type }: { state: string; type: string }) {
  const { p, lang } = usePT();
  const st = state === "TG" ? "TG" : "AP";
  const ty = type === "ls" ? "ls" : "assembly";
  const s = useMemberRoster(st, ty);
  return (
    <Wait s={s}>
      {s.data && (
        <ProfileShell
          kind="members" title={`${p("ppl.members.title")}: ${p(`ppl.state.${st}` as PKey)}`}
          sub={
            <nav className="flex flex-wrap gap-3 text-xs font-bold uppercase tracking-widest">
              {(["AP", "TG"] as const).flatMap(a => (["assembly", "ls"] as const).map(b => (
                <a key={a + b} data-testid={`members-tab-${a}-${b}`} aria-current={a === st && b === ty ? "page" : undefined} className={`underline ${a === st && b === ty ? "bg-black text-[#FAF8F5] px-1" : ""}`} href={peopleHref("members", a, b)}>
                  {a} {b === "ls" ? p("ppl.members.ls") : p("ppl.members.assembly")}
                </a>
              )))}
            </nav>
          }
          sections={[{ id: "roster", heading: `${p("ppl.members.elected")} ${s.data.electionYear}`, body: (
            <>
              <BlackoutNotice notice={s.data.notice} />
              <ul data-testid="members-list" className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {s.data.members.map(m => (
                  <li key={m.acNo} data-testid="member-row" className="border border-black/20 p-2 flex gap-3">
                    <PersonAvatar initials={m.member?.initials ?? "-"} photo={m.photo} size={48} />
                    <div className="min-w-0 space-y-1">
                      <div className="text-xs text-black/70">{m.acNo}. {m.acName}</div>
                      {m.member ? (
                        <div className="font-bold break-words">
                          <a className="underline" href={`#/people/candidate/${m.state}-${m.type}-${m.member.electionYear}-${m.acNo}-1`}>{m.member.name}</a>
                        </div>
                      ) : <div className="font-bold">{p("ppl.members.vacant")}</div>}
                      {m.member && <PartyChip party={m.member.party} lang={lang} />}
                      {m.notes.map(n => (
                        <p key={n.date + n.kind} data-testid="member-note" className="text-[11px]">
                          <strong>{n.status === "confirmed" ? p("ppl.members.changed") : p("ppl.members.reported")}</strong> ({n.date}): {n.note}{" "}
                          {n.sources.map((u, i) => <a key={u} className="underline mr-1" href={u} target="_blank" rel="noopener noreferrer">[{i + 1}]</a>)}
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) }]}
          report={<ReportControl page={`/people/members/${st}/${ty}`} />}
        />
      )}
    </Wait>
  );
}

/* ---------------- process page (S-113) ---------------- */

export function ProcessPage() {
  const { p } = usePT();
  const s = useApi(() => peopleApi.status(), []);
  return (
    <article data-testid="people-process" className="space-y-4 font-sans max-w-2xl">
      <a data-testid="people-back" href={peopleHref()} className="text-xs underline">{p("ppl.back")}</a>
      <h1 className="font-serif text-3xl">{p("ppl.process.title")}</h1>
      {(["ppl.process.p1", "ppl.process.p2", "ppl.process.p3", "ppl.process.p4", "ppl.process.p5"] as const).map(k => <p key={k} className="text-sm">{p(k)}</p>)}
      {s.data && <p data-testid="process-sla" className="text-sm font-bold">SLA: {s.data.slaDays} {p("ppl.report.days")}</p>}
      <p className="text-[11px] text-black/60">{p("ppl.draft")}</p>
      <ReportControl page="/people/process" />
    </article>
  );
}
