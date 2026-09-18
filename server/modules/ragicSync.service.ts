import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { coachUsers, venues, venueInfos } from "@shared/schema";
import { audit, MutationError, type Transaction } from "../shared/audit";
import { lockScheduleWrites } from "../shared/scheduleMutation";
import { actorContext } from "../shared/auth/auditContext";

export type SyncItem = { kind: "coach" | "venue"; sourceId: string; name: string; phone?: string | null; email?: string | null; lineId?: string | null; employeeId?: string | null; mapUrl?: string | null };
const safeCode = (err: unknown) => err instanceof MutationError ? err.code : "SYNC_WRITE_FAILED";

async function applyItem(tx: Transaction, item: SyncItem) {
  await lockScheduleWrites(tx);
  if (item.kind === "venue") {
    const existing = await tx.select().from(venues).where(eq(venues.name, item.name));
    if (existing.length > 1) throw new MutationError("VENUE_IDENTITY_AMBIGUOUS");
    if (!existing.length) {
      const [after] = await tx.insert(venues).values({ name: item.name, color: "blue", order: 100 }).returning();
      await audit(tx, "venue", after.id, null, after);
    }
    if (item.mapUrl) {
      const [info] = await tx.select().from(venueInfos).where(eq(venueInfos.venueName, item.name));
      if (!info) {
        const [after] = await tx.insert(venueInfos).values({ venueName: item.name, mapUrl: item.mapUrl }).returning();
        await audit(tx, "venue_info", after.id, null, after);
      }
    }
    return;
  }
  // Ragic sheet + record id is immutable. Names are only display fields.
  const [existing] = await tx.select().from(coachUsers).where(eq(coachUsers.ragicRecordId, item.sourceId));
  if (existing) {
    if (item.lineId && existing.lineId && item.lineId !== existing.lineId) throw new MutationError("COACH_LINE_ID_CONFLICT");
    const [after] = await tx.update(coachUsers).set({ name: item.name, phone: item.phone ?? existing.phone,
      email: item.email ?? existing.email, lineId: existing.lineId || item.lineId || null,
      employeeId: item.employeeId ?? existing.employeeId, updatedAt: new Date() }).where(eq(coachUsers.id, existing.id)).returning();
    await audit(tx, "coach", after.id, { id: existing.id, name: existing.name }, { id: after.id, name: after.name, ragicRecordId: after.ragicRecordId });
    return;
  }
  const candidates = await tx.select().from(coachUsers);
  // Existing staff must be mapped in the reviewed migration. Never claim a row
  // by a matching name, mutable employee number, or by taking its LINE binding.
  if (candidates.some(c => c.name === item.name || (item.lineId && c.lineId === item.lineId) || (item.employeeId && c.employeeId === item.employeeId))) {
    throw new MutationError("IDENTITY_MAPPING_REQUIRED");
  }
  const [after] = await tx.insert(coachUsers).values({ name: item.name, ragicRecordId: item.sourceId, phone: item.phone,
    email: item.email, lineId: item.lineId, employeeId: item.employeeId, status: "approved", role: "coach", linkedCoachName: item.name }).returning();
  await audit(tx, "coach", after.id, null, { id: after.id, name: after.name, ragicRecordId: item.sourceId });
}

export async function runDurableSync(loadItems: (() => Promise<SyncItem[]>) | null, retryRunId?: string) {
  const lock = await pool.connect();
  let acquired = false;
  let runId = retryRunId ?? randomUUID();
  try {
    const guard = await lock.query("SELECT pg_try_advisory_lock(620260919) AS acquired");
    acquired = guard.rows[0].acquired;
    if (!acquired) throw new MutationError("SYNC_ALREADY_RUNNING");
    await pool.query("UPDATE ragic_sync_runs SET status='interrupted', error_code='PROCESS_INTERRUPTED', completed_at=now() WHERE status='running'");
    if (retryRunId) {
      const items = await pool.query("SELECT count(*)::int AS total FROM ragic_sync_items WHERE run_id=$1", [runId]);
      if (!items.rows[0].total) throw new MutationError("SYNC_SOURCE_RETRY_REQUIRES_NEW_RUN");
      const r = await pool.query("UPDATE ragic_sync_runs SET status='running', completed_at=NULL WHERE id=$1 RETURNING id", [runId]);
      if (!r.rowCount) throw new MutationError("SYNC_RUN_NOT_FOUND", 404);
    } else {
      await pool.query("INSERT INTO ragic_sync_runs(id,status) VALUES($1,'running')", [runId]);
      const items = await loadItems!();
      await db.transaction(async tx => {
        for (const item of items) {
          if (!item.sourceId || !item.name) throw new MutationError("INVALID_SOURCE_IDENTITY");
          await tx.execute(sql`INSERT INTO ragic_sync_items(run_id,kind,source_id,payload,status) VALUES (${runId},${item.kind},${item.sourceId},${JSON.stringify(item)}::jsonb,'pending')`);
        }
      });
    }
    const pending = await pool.query("SELECT kind,source_id FROM ragic_sync_items WHERE run_id=$1 AND status<>'succeeded' AND attempts<5 ORDER BY kind,source_id", [runId]);
    for (const row of pending.rows) {
      try {
        await actorContext.run({ id: "system:ragic", role: "system", requestId: runId, venueIds: [] }, () => db.transaction(async tx => {
          const result = await tx.execute(sql`SELECT payload,status FROM ragic_sync_items WHERE run_id=${runId} AND kind=${row.kind} AND source_id=${row.source_id} FOR UPDATE`);
          if (result.rows[0].status === "succeeded") return;
          await applyItem(tx, result.rows[0].payload as SyncItem);
          await tx.execute(sql`UPDATE ragic_sync_items SET status='succeeded',attempts=attempts+1,error_code=NULL,updated_at=now() WHERE run_id=${runId} AND kind=${row.kind} AND source_id=${row.source_id}`);
        }));
      } catch (err) {
        await pool.query("UPDATE ragic_sync_items SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'needs_attention' ELSE 'failed' END,error_code=$4,updated_at=now() WHERE run_id=$1 AND kind=$2 AND source_id=$3", [runId, row.kind, row.source_id, safeCode(err)]);
      }
    }
    const counts = await pool.query("SELECT count(*)::int total,count(*) FILTER(WHERE status='succeeded')::int succeeded,count(*) FILTER(WHERE status<>'succeeded')::int failed FROM ragic_sync_items WHERE run_id=$1", [runId]);
    const c = counts.rows[0]; const status = c.failed ? "partial_failed" : "succeeded";
    await pool.query("UPDATE ragic_sync_runs SET status=$2,total_count=$3,success_count=$4,failure_count=$5,error_code=$6,completed_at=now() WHERE id=$1", [runId, status, c.total, c.succeeded, c.failed, c.failed ? "PARTIAL_SYNC_FAILED" : null]);
    return { runId, status, ...c };
  } catch (err) {
    if (acquired) await pool.query("UPDATE ragic_sync_runs SET status='failed',error_code=$2,completed_at=now() WHERE id=$1", [runId, err instanceof MutationError ? err.code : "SYNC_SOURCE_FAILED"]);
    throw err;
  } finally {
    try { if (acquired) await lock.query("SELECT pg_advisory_unlock(620260919)"); }
    finally { lock.release(); }
  }
}

export async function readDurableSyncStatus() {
  const result = await pool.query("SELECT id,status,started_at,completed_at,total_count,success_count,failure_count,error_code FROM ragic_sync_runs ORDER BY started_at DESC LIMIT 1");
  const run = result.rows[0];
  if (run?.status === "running") {
    // A persisted running row does not prove that its worker survived a restart.
    const c = await pool.connect();
    let acquired = false;
    try {
      const lock = await c.query("SELECT pg_try_advisory_lock(620260919) AS acquired");
      acquired = lock.rows[0].acquired;
      if (lock.rows[0].acquired) {
        const changed = await c.query("UPDATE ragic_sync_runs SET status='interrupted',error_code='PROCESS_INTERRUPTED',completed_at=now() WHERE id=$1 AND status='running' RETURNING completed_at", [run.id]);
        if (changed.rowCount) {
          run.status = "interrupted"; run.error_code = "PROCESS_INTERRUPTED";
          run.completed_at = changed.rows[0].completed_at;
        }
      }
    } finally {
      try { if (acquired) await c.query("SELECT pg_advisory_unlock(620260919)"); }
      finally { c.release(); }
    }
  }
  return { run: run ?? null, isSyncing: run?.status === "running", lastSyncTime: run?.completed_at ?? null,
    lastSyncResult: null, lastError: run && run.status !== "succeeded" && run.status !== "running" ? { at: run.completed_at, message: run.error_code ?? "SYNC_INCOMPLETE" } : null };
}
