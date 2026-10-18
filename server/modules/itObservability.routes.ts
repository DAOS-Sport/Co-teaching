import type { Express, Response } from "express";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { appLog, operationAudit, ragicSyncItems, ragicSyncRuns } from "@shared/schema";
import { AUDIT_ENTITY_GROUPS } from "@shared/auditActions";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { displayRunStatus } from "../ragic.logic";

const DAY_MS = 86_400_000;
const RECENT_DAYS = 7;

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** Activity filter groups shown on the IT page. */
export const ACTIVITY_GROUPS: Record<string, string[]> = {};
for (const [entity, group] of Object.entries(AUDIT_ENTITY_GROUPS)) {
  (ACTIVITY_GROUPS[group] ??= []).push(entity);
}

/** Failed or cut-off runs first, then partial, then running, then clean ones. */
export function runPriority(displayStatus: string): number {
  if (displayStatus === "failed" || displayStatus === "interrupted") return 0;
  if (displayStatus === "partial_failed") return 1;
  if (displayStatus === "running") return 2;
  return 3;
}

const queryFailed = (res: Response) => res.status(500).json({ code: "IT_QUERY_FAILED", message: "查詢失敗，請稍後再試" });

export function registerItObservabilityRoutes(app: Express): void {
  // Operation timeline (#3), newest first.
  app.get("/api/admin/it/activity", requireAdminPassword, async (req, res) => {
    try {
      const entities = typeof req.query.group === "string" ? ACTIVITY_GROUPS[req.query.group] : undefined;
      const rows = await db
        .select()
        .from(operationAudit)
        .where(entities ? inArray(operationAudit.entity, entities) : undefined)
        .orderBy(desc(operationAudit.occurredAt))
        .limit(clampLimit(req.query.limit, 100, 300));
      res.json({ rows });
    } catch {
      queryFailed(res);
    }
  });

  // System log: errors of the last 7 days first, then the latest other entries.
  app.get("/api/admin/it/logs", requireAdminPassword, async (req, res) => {
    try {
      const since = new Date(Date.now() - RECENT_DAYS * DAY_MS);
      const [errors, others] = await Promise.all([
        db
          .select()
          .from(appLog)
          .where(and(eq(appLog.level, "error"), gte(appLog.occurredAt, since)))
          .orderBy(desc(appLog.occurredAt))
          .limit(200),
        db
          .select()
          .from(appLog)
          .where(ne(appLog.level, "error"))
          .orderBy(desc(appLog.occurredAt))
          .limit(clampLimit(req.query.limit, 100, 300)),
      ]);
      res.json({ since, errors, others });
    } catch {
      queryFailed(res);
    }
  });

  // Ragic sync runs (#1): problems first, with their failed items.
  app.get("/api/admin/it/ragic-runs", requireAdminPassword, async (req, res) => {
    try {
      const now = new Date();
      const runs = (
        await db
          .select()
          .from(ragicSyncRuns)
          .orderBy(desc(ragicSyncRuns.startedAt))
          .limit(clampLimit(req.query.limit, 30, 100))
      ).map((run) => ({ ...run, displayStatus: displayRunStatus(run, now) }));
      const problemIds = runs.filter((run) => runPriority(run.displayStatus) < 2).map((run) => run.id);
      const items = problemIds.length
        ? await db.select().from(ragicSyncItems).where(inArray(ragicSyncItems.runId, problemIds)).orderBy(ragicSyncItems.id).limit(2000)
        : [];
      runs.sort(
        (a, b) => runPriority(a.displayStatus) - runPriority(b.displayStatus) || b.startedAt.getTime() - a.startedAt.getTime(),
      );
      res.json({ runs: runs.map((run) => ({ ...run, items: items.filter((item) => item.runId === run.id) })) });
    } catch {
      queryFailed(res);
    }
  });

  // Errors and refusals per API route template over the last 7 days.
  app.get("/api/admin/it/endpoint-stats", requireAdminPassword, async (_req, res) => {
    try {
      const since = new Date(Date.now() - RECENT_DAYS * DAY_MS);
      const rows = await db
        .select({
          method: appLog.method,
          route: appLog.route,
          errors: sql<number>`count(*) filter (where ${appLog.level} = 'error')::int`,
          refusals: sql<number>`count(*) filter (where ${appLog.level} = 'warn')::int`,
          lastErrorAt: sql<string | null>`max(${appLog.occurredAt}) filter (where ${appLog.level} = 'error')`,
        })
        .from(appLog)
        .where(and(eq(appLog.source, "api"), gte(appLog.occurredAt, since)))
        .groupBy(appLog.method, appLog.route);
      res.json({ since, rows });
    } catch {
      queryFailed(res);
    }
  });
}
