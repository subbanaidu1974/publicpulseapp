import { useCivicT } from "../civicText";
import ReplyModeration from "./ReplyModeration";
import { LexiconPanel, ModerationQueue } from "./ModerationQueue";

export default function ModeratorConsole() {
  const c = useCivicT();
  return (
    <section data-testid="moderator-console" aria-labelledby="mc-h" className="space-y-4">
      <h3 id="mc-h" className="text-lg font-bold">{c("c.mod.title")}</h3>
      <ModerationQueue />
      <ReplyModeration />
      <LexiconPanel />
    </section>
  );
}
