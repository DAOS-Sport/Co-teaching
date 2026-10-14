import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { appLog } from "@shared/schema";

export type AppLogLevel = "error" | "warn" | "info";
export type AppLogSource = "api" | "ragic" | "notify" | "system";

export interface AppLogEntry {
  level: AppLogLevel;
  source: AppLogSource;
  code?: string | null;
  message?: string | null;
  method?: string | null;
  route?: string | null;
  status?: number | null;
  requestId?: string | null;
  detail?: Record<string, unknown> | null;
}

type AppLogWriter = (entries: AppLogEntry[]) => Promise<void>;

const MAX_PENDING = 500;
const MAX_ACTIVE_WRITES = 2;
const BATCH_SIZE = 50;

let pending: AppLogEntry[] = [];
let activeWrites = 0;
let dropped = 0;
let writer: AppLogWriter = async (entries) => {
  await db.insert(appLog).values(entries);
};

/**
 * Queues a log row. Never awaited by callers and never throws: when the
 * database is the thing failing, logging must not make requests slower or
 * fail them too. A full queue drops the row and counts it.
 */
export function recordAppLog(entry: AppLogEntry): void {
  if (pending.length >= MAX_PENDING) {
    dropped++;
    return;
  }
  pending.push(entry);
  drain();
}

function drain(): void {
  while (activeWrites < MAX_ACTIVE_WRITES && pending.length > 0) {
    const batch = pending.splice(0, BATCH_SIZE);
    activeWrites++;
    writer(batch)
      .catch((error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        console.error(`[app_log] write failed (${typeof code === "string" ? code : "error"}); ${batch.length} rows lost`);
      })
      .finally(() => {
        activeWrites--;
        drain();
      });
  }
}

export function appLogQueueStats() {
  return { pending: pending.length, activeWrites, dropped };
}

export function setAppLogWriterForTest(next: AppLogWriter): void {
  writer = next;
  pending = [];
  activeWrites = 0;
  dropped = 0;
}

export async function flushAppLogForTest(): Promise<void> {
  while (pending.length > 0 || activeWrites > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Server errors are errors; refusals (auth, locked, stale version…) are only counted. */
export function levelForStatus(status: number): AppLogLevel | null {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return null;
}

export const UNMATCHED_ROUTE = "(未對應路由)";

/**
 * The route template the request matched (e.g. /api/schedules/:id). The
 * real path and query can hold LINE IDs, coach names or the admin
 * password, so they are never logged.
 */
export function routeTemplate(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? `${req.baseUrl ?? ""}${path}` : UNMATCHED_ROUTE;
}

// The IT page polls these; logging their own refusals would fill the log.
const NOT_LOGGED = (route: string) => route.startsWith("/api/admin/it");

/** Records every /api response with status >= 400 after it is sent. */
export function apiLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api")) return next();
  const requestId = randomUUID();
  res.setHeader("X-Request-ID", requestId);
  res.on("finish", () => {
    const level = levelForStatus(res.statusCode);
    if (!level) return;
    const route = routeTemplate(req);
    if (NOT_LOGGED(route)) return;
    recordAppLog({
      level,
      source: "api",
      code: `HTTP_${res.statusCode}`,
      method: req.method,
      route,
      status: res.statusCode,
      requestId,
    });
  });
  next();
}
