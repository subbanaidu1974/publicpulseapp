import { useEffect, useState } from "react";
import { BUILTIN_CATEGORIES, issuesApi, type CategoryInfo } from "../../api/civic";
import { useT } from "../../i18n";

/** Server icon names (lucide names from GET /issues/categories) to a glyph. The glyph is decorative: the text label always accompanies it. */
const GLYPH: Record<string, string> = { droplets: "💧", route: "🛣️", zap: "⚡", "heart-pulse": "🏥", "graduation-cap": "🏫", sprout: "🌾", "hand-heart": "🤝", "shield-alert": "🛡️", ellipsis: "📋" };
const BY_ID: Record<string, string> = { water: "droplets", roads: "route", electricity: "zap", health: "heart-pulse", education: "graduation-cap", agriculture: "sprout", welfare: "hand-heart", law_order: "shield-alert", other: "ellipsis" };
export const glyphFor = (c: { id: string; icon?: string }) => GLYPH[c.icon ?? ""] ?? GLYPH[BY_ID[c.id]] ?? "📋";

let cache: CategoryInfo[] | null = null;
/** Categories from GET /issues/categories, with the built-in nine as an instant default and offline fallback. */
export function useCategories(): { cats: CategoryInfo[]; label: (id: string) => string } {
  const { lang } = useT();
  const [cats, setCats] = useState<CategoryInfo[]>(cache ?? BUILTIN_CATEGORIES);
  useEffect(() => {
    if (cache) return;
    let live = true;
    issuesApi.categories().then((r) => { cache = r; if (live) setCats(r); });
    return () => { live = false; };
  }, []);
  const label = (id: string) => { const k = cats.find((x) => x.id === id); return k ? (lang === "te" ? k.labelTe : k.labelEn) : id; };
  return { cats, label };
}
