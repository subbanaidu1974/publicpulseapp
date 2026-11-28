import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Express 4 does not catch a rejected promise from an async handler (the request would hang). This forwards it to the error handler. */
export const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
