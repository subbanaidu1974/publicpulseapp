import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { tokenStore } from "../../api/civic";

/**
 * Links from the civic home to the other areas. They live in this tiny file ON PURPOSE: importing them from the big area modules
 * (surveys, notifications, consultations, dashboards) would pull every one of those screens into the civic/PWA-lite entry bundle,
 * which has a 150 KB gzip budget (tests/civic/channels.size.test.ts, E2E-55). Keep this file free of heavy imports.
 */
const CLS = "underline font-bold min-h-[44px] inline-flex items-center";

const TEXT = {
  surveys: { en: "Pulse Surveys: see open surveys and answer once, anonymously", te: "పల్స్ సర్వేలు: తెరిచిన సర్వేలను చూడండి, అజ్ఞాతంగా ఒక్కసారి సమాధానం ఇవ్వండి" },
  notifications: { en: "Government notifications: your inbox, settings and the public sender log", te: "ప్రభుత్వ నోటిఫికేషన్లు: మీ ఇన్‌బాక్స్, సెట్టింగ్‌లు, పంపినవారి బహిరంగ లాగ్" },
  consultations: { en: "Bill consultations: read a draft bill in plain language and give feedback clause by clause", te: "బిల్లు సంప్రదింపులు: ముసాయిదా బిల్లును సులభ భాషలో చదివి, క్లాజు వారీగా అభిప్రాయం ఇవ్వండి" },
  dashboard: { en: "Open my dashboards", te: "నా డాష్‌బోర్డ్‌లు తెరవండి" },
} as const;

function useText() {
  const { lang } = useT();
  return (k: keyof typeof TEXT) => TEXT[k][lang === "te" ? "te" : "en"];
}

export function SurveysLink() {
  const t = useText();
  return <p><a href="#/surveys" data-testid="civic-to-surveys" className={CLS}>{t("surveys")}</a></p>;
}

export function NotifyLink() {
  const t = useText();
  return <p><a href="#/notifications" data-testid="civic-to-notifications" className={CLS}>{t("notifications")}</a></p>;
}

export function ConsultationsLink() {
  const t = useText();
  return <p><a href="#/consultations" data-testid="civic-to-consultations" className={CLS}>{t("consultations")}</a></p>;
}

/** Shown only when the server says the signed-in person holds a role (GET /scope/me); the server stays the only authority. */
export function ScopeLink() {
  const t = useText();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    const token = tokenStore.get();
    if (token) {
      fetch("/api/v1/civic/scope/me", { headers: { authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((m: { roles?: unknown[] } | null) => { if (live) setShow(!!m?.roles?.length); })
        .catch(() => { /* signed out or no role: show nothing */ });
    }
    return () => { live = false; };
  }, []);
  if (!show) return null;
  return <a href="#/dashboard" data-testid="scope-link" className="underline font-bold text-blue-900 inline-flex items-center min-h-[44px]">{t("dashboard")}</a>;
}
