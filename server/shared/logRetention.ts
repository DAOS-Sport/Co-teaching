import { sql } from "drizzle-orm";
import { db } from "../db";

export const LOG_RETENTION_DAYS = 90;
const BATCH = 5000;
const DAY_MS = 86_400_000;

const TABLES: { table: string; timeColumn: string }[] = [
  { table: "app_log", timeColumn: "occurred_at" },
  { table: "operation_audit", timeColumn: "occurred_at" },
  // ragic_sync_items rows go with their run (ON DELETE CASCADE).
  { table: "ragic_sync_runs", timeColumn: "started_at" },
];

/** Deletes rows older than 90 days, in small batches so no table stays locked long. */
export async function purgeOldLogs(now = new Date()): Promise<Record<string, number>> {
  const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS);
  const removed: Record<string, number> = {};
  for (const { table, timeColumn } of TABLES) {
    removed[table] = 0;
    for (;;) {
      const result = await db.execute(sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE ctid IN (
          SELECT ctid FROM ${sql.identifier(table)}
          WHERE ${sql.identifier(timeColumn)} < ${cutoff.toISOString()}
          LIMIT ${BATCH}
        )`);
      const count = Number((result as { rowCount?: number | null }).rowCount ?? 0);
      removed[table] += count;
      if (count < BATCH) break;
    }
  }
  return removed;
}

/** Runs shortly after start and then daily. Every instance may run it; the deletes are idempotent. */
export function setupLogRetention(): void {
  const run = () =>
    purgeOldLogs()
      .then((removed) => {
        const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
        if (total > 0) console.log(`[retention] removed rows older than ${LOG_RETENTION_DAYS} days:`, removed);
      })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown })?.code;
        console.error(`[retention] purge failed (${typeof code === "string" ? code : "error"})`);
      });
  setTimeout(run, 60_000).unref();
  setInterval(run, DAY_MS).unref();
}
