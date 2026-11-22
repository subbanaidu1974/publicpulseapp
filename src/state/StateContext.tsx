import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
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

/** Election cycles offered in the pickers (newest first). */
export const ELECTION_YEARS: Record<StateCode, Record<ElectionType, number[]>> = {
  AP: { assembly: [2024, 2019, 2014], ls: [2024, 2019] },
  TG: { assembly: [2023, 2018, 2014], ls: [2024, 2019] },
};

export function defaultYear(state: StateCode, type: ElectionType): number {
  return ELECTION_YEARS[state][type][0];
}
