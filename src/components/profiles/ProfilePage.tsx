import type { ProfileRoute } from "../../api/profiles";
import { useT } from "../../i18n";
import ConstituencyProfile from "./ConstituencyProfile";
import PlaceProfile from "./PlaceProfile";

/** Page for #/constituency/<ST>/<acNo> and #/place/<ST>/<level>/<code> (S-98, S-99). */
export default function ProfilePage({ route, onBack }: { route: ProfileRoute; onBack: () => void }) {
  const { t } = useT();
  return (
    <section data-testid="profile-page" className="max-w-3xl mx-auto space-y-4" aria-label={t("prof.page")}>
      <button type="button" data-testid="profile-back" onClick={onBack} className="border border-black px-3 py-1 text-[10px] uppercase tracking-widest font-black cursor-pointer">
        &larr; {t("prof.back")}
      </button>
      {route.kind === "ac"
        ? <ConstituencyProfile state={route.state} acNo={route.acNo} />
        : <PlaceProfile state={route.state} level={route.level} code={route.code} />}
    </section>
  );
}
