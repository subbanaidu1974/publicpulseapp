/** Erasure and job registration for consultations (side effects at import). */
import { registerErasureSubjects, registerStoreErasureHook } from "../core";
import { registerJob } from "../jobs";
import { runConsultationJobs } from "./registry";
import { cdb } from "./schema";
import { feedbackKey } from "./types";

// Erasure (S-74 pattern): the person's feedback rows are found through their keyed pseudonyms and deleted. Published closing reports are
// frozen snapshots of aggregates and stay (they hold no row-level data).
registerErasureSubjects("consultations", (personId) => {
  try {
    return (cdb().prepare("SELECT id FROM consultations").all() as unknown as { id: string }[]).map((r) => feedbackKey(r.id, personId));
  } catch { return []; }
});
registerStoreErasureHook("survey", "consultations.feedback", (subjects) => {
  for (let i = 0; i < subjects.length; i += 500) {
    const c = subjects.slice(i, i + 500);
    cdb().prepare(`DELETE FROM consultation_feedback WHERE person_key IN (${c.map(() => "?").join(",")})`).run(...c);
  }
});

// Closes consultations at closes_at and flags overdue closing reports in the public registry (S-36 c).
registerJob({ name: "consultations", intervalMs: 60_000, run: (now) => runConsultationJobs(now) });
