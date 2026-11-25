import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { isStateCode, STATES, StateCode, StateConfig, ElectionType } from "../lib/states";

const KEY = "pp-state";

function initialState(): StateCode {
  try {
    const q = new URLSearchParams(window.location.search).get("state")?.toUpperCase();
    if (q && isStateCode(q)) return q;
  } catch { /* ignore */ }
  try {
    const s = localStorage.getItem(KEY);
    if (s && isStateCode(s)) return s;
  } catch { /* ignore */ }
  return "AP";
}

interface Ctx { state: StateCode; config: StateConfig; setState: (s: StateCode) => void }
const StateCtx = createContext<Ctx | null>(null);

export function StateProvider({ children }: { children: ReactNode }) {
  const [state, setStateRaw] = useState<StateCode>(initialState);

  const setState = useCallback((s: StateCode) => setStateRaw(s), []);

  useEffect(() => {
    try { localStorage.setItem(KEY, state); } catch { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("state", state);
      window.history.replaceState(null, "", url.toString());
    } catch { /* ignore */ }
  }, [state]);

  const value = useMemo(() => ({ state, config: STATES[state], setState }), [state, setState]);
  return <StateCtx.Provider value={value}>{children}</StateCtx.Provider>;
}

export function useStateCtx(): Ctx {
  const c = useContext(StateCtx);
  if (!c) throw new Error("useStateCtx outside StateProvider");
  return c;
}

/**
 * Fallback only: the cycles known when this was written, used until (or if) the server's election list cannot be read.
 * The pickers read the real list from the data (useElectionYears), so a new election appears without a code change.
 */
export const ELECTION_YEARS: Record<StateCode, Record<ElectionType, number[]>> = {
  AP: { assembly: [2024, 2019, 2014], ls: [2024, 2019] },
  TG: { assembly: [2023, 2018, 2014], ls: [2024, 2019] },
};

type YearTable = Record<StateCode, Record<ElectionType, number[]>>;
let yearTable: Promise<YearTable | null> | null = null;
/** Years that have results in the dataset, per state and type, newest first (from GET /states). null when it cannot be read. */
export function loadElectionYears(): Promise<YearTable | null> {
  yearTable ??= api.states().then((list) => {
    const out: YearTable = { AP: { assembly: [], ls: [] }, TG: { assembly: [], ls: [] } };
    for (const s of list) {
      if (!isStateCode(s.code)) continue;
      for (const e of s.elections ?? []) {
        const bucket = out[s.code][e.type];
        if (bucket && !bucket.includes(e.year)) bucket.push(e.year);
      }
      for (const t of ["assembly", "ls"] as ElectionType[]) out[s.code][t].sort((a, b) => b - a);
    }
    return out;
  }).catch(() => { yearTable = null; return null; });
  return yearTable;
}

/** The years offered in a picker, newest first, read from the data; the fallback list is used only if the data cannot be read or has none. */
export function useElectionYears(state: StateCode, type: ElectionType): number[] {
  const [table, setTable] = useState<YearTable | null>(null);
  useEffect(() => { let live = true; void loadElectionYears().then((t) => { if (live) setTable(t); }); return () => { live = false; }; }, []);
  const fromData = table?.[state]?.[type];
  return fromData && fromData.length ? fromData : ELECTION_YEARS[state][type];
}

