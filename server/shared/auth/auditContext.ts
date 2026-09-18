import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Express } from "express";
import { verifyAdminPassword } from "./adminPassword";
export type Actor = { id: string; role: string; requestId: string; venueIds: string[]; overrideReason?: string };
export const actorContext = new AsyncLocalStorage<Actor>();
// Shared credentials establish authority, but never a person's identity.
export function registerAuditContext(app: Express) {
  app.use("/api", (req, _res, next) => {
    if (!verifyAdminPassword(req)) return next();
    const overrideReason = typeof req.body?.overrideReason === "string" ? req.body.overrideReason.trim().slice(0,300) : undefined;
    actorContext.run({ id: "shared-admin:identity-unknown", role: "admin", requestId: randomUUID(), venueIds: [], overrideReason }, next);
  });
}
