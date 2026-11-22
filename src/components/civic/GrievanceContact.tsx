import { useEffect, useState } from "react";
import { useCivicT } from "./civicText";

interface Officer { name: string; email: string; postalAddress?: string; status?: string }

/** Grievance officer contact (DPDP / IT Act s.79 duty), from the compliance module. Always visible at sign-up. */
export default function GrievanceContact() {
  const c = useCivicT();
  const [o, setO] = useState<Officer | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/civic/households/grievance-officer").then((r) => (r.ok ? r.json() : null)).then((j) => { if (live) setO(j); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <section data-testid="grievance-contact" aria-labelledby="gc-h" className="border border-black p-3 text-sm break-words">
      <h3 id="gc-h" className="font-bold">{c("c.grievance")}</h3>
      {o ? <p>{o.name} · {o.email}{o.postalAddress ? ` · ${o.postalAddress}` : ""}</p> : <p>...</p>}
    </section>
  );
}
