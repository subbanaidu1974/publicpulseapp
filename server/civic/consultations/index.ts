/**
 * Bill consultations router, mounted at /api/v1/civic/consultations (server/civic/index.ts). See docs/CONSULTATIONS.md.
 * Static sub-paths (`/mine`) are owned by the registry router, which mounts first; every `/:id/...` path is distinct across routers.
 */
import { Router } from "express";
import "./hooks";
import { feedbackRouter } from "./feedback";
import { registryRouter } from "./registry";
import { reportRouter } from "./report";

export const consultationsRouter = Router();
consultationsRouter.use(registryRouter);
consultationsRouter.use(feedbackRouter);
consultationsRouter.use(reportRouter);

export { submitFeedback } from "./feedback";
export { getConsultation, runConsultationJobs } from "./registry";
export { setCommentReviewer, noopReviewer } from "./reviewer";
export type { CommentReviewer } from "./reviewer";
