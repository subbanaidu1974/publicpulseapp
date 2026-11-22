/**
 * Pulse Surveys router, mounted at /api/v1/civic/surveys (server/civic/index.ts). Assembles the three survey modules:
 *   registryRouter    ./registry    public registry, wording panel, quotas, lifecycle (S-28, S-34)
 *   credentialRouter  ./credential  eligibility credential + response submission
 *   resultsRouter     ./results     published figures
 * Static paths of the sibling routers must not collide with registry `/:id`; the registry only owns GET /:id, GET /:id/versions/:n and
 * POST|PATCH /:id/(submit|panel/review|open|cancel|close). Siblings mount first-match order: registry, credential, results.
 */
import { Router } from "express";
import { credentialRouter } from "./credential";
import { registryRouter } from "./registry";
import { resultsRouter } from "./results";

export const surveysRouter = Router();
surveysRouter.use(registryRouter);
surveysRouter.use(credentialRouter);
surveysRouter.use(resultsRouter);

export { closeDueSurveys, electionChoiceAllowed, electionGate, figuresPublishable, getSurvey, hiddenReason, surveyActorPseudonym, surveyAnswerable } from "./registry";
