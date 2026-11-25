import { useEffect, useState } from "react";
import { civicIdentityApi, tokenStore, type DemoPersonaInfo, type Session } from "../../api/civic";
import { Btn, ErrorNote } from "./ui";

/**
 * Demo sign-in (S-166). Renders nothing unless the server answers GET /demo/personas, which it does only when it runs with
 * CIVIC_DEMO_PERSONAS=1 outside production. A persona is a ready-made account, so there is no registration.
 */
export default function DemoPersonas({ onDone }: { onDone: (s: Session) => void }) {
  const [personas, setPersonas] = useState<DemoPersonaInfo[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let live = true; void civicIdentityApi.demoPersonas().then((p) => { if (live) setPersonas(p); }); return () => { live = false; }; }, []);
  if (personas.length === 0) return null;
  return (
    <section data-testid="demo-personas" aria-label="Demo sign-in" className="border border-dashed border-black p-3 space-y-2 max-w-md">
      <h3 className="font-bold text-sm">Demo sign-in (development only)</h3>
      <p className="text-xs">Pick a ready-made account. No registration. This panel never appears on the live site.</p>
      <ul className="space-y-2">
        {personas.map((p) => (
          <li key={p.key}>
            <Btn secondary data-testid={`demo-${p.key}`} disabled={!!busy} onClick={async () => {
              setBusy(p.key); setErr(null);
              try { const s = await civicIdentityApi.demoLogin(p.key); tokenStore.set(s.token); onDone(s); } catch { setErr("Could not sign in as this persona."); } finally { setBusy(""); }
            }}>Sign in as: {p.label}</Btn>
            <span className="block text-xs mt-1">{p.description}</span>
          </li>
        ))}
      </ul>
      <ErrorNote msg={err} />
    </section>
  );
}
