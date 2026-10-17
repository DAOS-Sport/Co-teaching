import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

// Explicit opt-in, localhost and a disposable name: never point this at an app database.
const target = process.env.AUDIT_PG_URL;
if (!target || process.env.CT_THROWAWAY_PG !== "1") throw new Error("Throwaway PostgreSQL opt-in required");
const parsed = new URL(target);
if (parsed.hostname !== "127.0.0.1" || !/^\/ct_(?:a1|ca3)_[a-zA-Z0-9_]+$/.test(parsed.pathname) || !parsed.port || parsed.port === "5432") {
  throw new Error("Refusing a non-disposable database target");
}
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
process.env.ADMIN_PASSWORD = "synthetic-a1-admin";

test("A1 real PostgreSQL: network HTTP/MCP policies, locks, confirmation and atomic audit", { timeout: 60_000 }, async (t) => {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { eq, sql } = await import("drizzle-orm");
  const schema = await import("@shared/schema");
  const { setBaseDbForTest, currentDb } = await import("./shared/dbContext");
  const { setAuditWriterForTest } = await import("./shared/audit");
  const { registerScheduleRoutes } = await import("./modules/schedule.routes");
  const { callSchedulingTool } = await import("./mcp/schedulingTools");
  const { env } = await import("./config/env");
  const express = (await import("express")).default;
  const pool = new pg.Pool({ connectionString: target, max: 8, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  const db = drizzle(pool, { schema });
  setBaseDbForTest(db);
  const app = express();
  app.use(express.json());
  registerScheduleRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (id: string, body: object, assign = false) => {
    const response = await fetch(`${base}/api/schedules/${id}${assign ? "/assign-coach" : ""}`, {
      method: "PUT", headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const row = async (id: string) => (await db.select().from(schema.schedules).where(eq(schema.schedules.id, id)))[0];
  const audits = async () => (await db.select().from(schema.operationAudit)).length;
  try {
    await db.execute(sql`truncate operation_audit, schedules, venues, time_slots restart identity cascade`);
    const venues = await db.insert(schema.venues).values([1, 2].map(n => ({ id: `v${n}`, name: `Synthetic Venue ${n}`, color: "blue", order: n }))).returning();
    const [slot] = await db.insert(schema.timeSlots).values({ id: "slot", period: "1", startTime: "08:00", endTime: "09:00", order: 1 }).returning();
    const make = async (id: string, date: string, venueId = venues[0].id, extra = {}) =>
      (await db.insert(schema.schedules).values({ id, date, venueId, timeSlotId: slot.id, className: id, ...extra }).returning())[0];

    await t.test("missing/stale versions do not write through either entry", async () => {
      const r = await make("versions", "2099-03-04");
      const count = await audits();
      assert.equal((await send(r.id, { className: "changed" })).status, 428);
      assert.equal((await send(r.id, { coachName2: "Synthetic Coach A" }, true)).body.code, "VERSION_REQUIRED");
      assert.equal((await send(r.id, { expectedVersion: 2, coachName2: "Synthetic Coach A" }, true)).body.code, "VERSION_CONFLICT");
      assert.equal((await send("missing-row", { expectedVersion: 1, coachName2: "Synthetic Coach A" }, true)).body.code, "SCHEDULE_NOT_FOUND");
      await assert.rejects(callSchedulingTool("update_schedule", { scheduleId: "missing-row", expectedVersion: 1, notes: "changed" }), (e: any) => e.code === "SCHEDULE_NOT_FOUND");
      await assert.rejects(callSchedulingTool("update_schedule", { scheduleId: r.id, notes: "changed" }), (e: any) => e.code === "VERSION_REQUIRED");
      assert.equal((await send(r.id, { expectedVersion: 2, className: "changed" })).body.code, "VERSION_CONFLICT");
      await assert.rejects(callSchedulingTool("update_schedule", { scheduleId: r.id, expectedVersion: 2, notes: "changed" }), (e: any) => e.code === "VERSION_CONFLICT");
      assert.deepEqual([(await row(r.id)).version, await audits()], [1, count]);
    });

    await t.test("same row HTTP/MCP race commits exactly one version and audit", async () => {
      const r = await make("cas", "2099-03-05"), count = await audits();
      const results = await Promise.all([
        send(r.id, { expectedVersion: 1, className: "http" }).then(r => r.status),
        callSchedulingTool("update_schedule", { scheduleId: r.id, expectedVersion: 1, notes: "mcp" }).then(() => 200, (e: any) => e.code === "VERSION_CONFLICT" ? 409 : Promise.reject(e)),
      ]);
      assert.deepEqual(results.sort(), [200, 409]);
      assert.deepEqual([(await row(r.id)).version, await audits() - count], [2, 1]);
    });

    await t.test("different courses sharing a coach serialize before conflict reads", async () => {
      const a = await make("clash-a", "2099-03-06"), b = await make("clash-b", "2099-03-06", venues[1].id);
      await db.insert(schema.coachUsers).values({ id: "race-coach", name: "Synthetic Coach Race", status: "approved" });
      const count = await audits();
      const { placementLockKeys } = await import("./core/scheduling/policies");
      const key = "schedule-writes";
      const blocker = await pool.connect();
    const blockerPID = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      let requests: Promise<{ status: number; body: any }[]> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
        requests = Promise.all([
          send(a.id, { expectedVersion: 1, coachName: "Synthetic Coach Race" }, true),
          callSchedulingTool("update_schedule", { scheduleId: b.id, expectedVersion: 1, coachName: "Synthetic Coach Race" })
            .then(body => ({ status: 200, body }), (e: any) => e.code === "CONFIRM_REQUIRED" ? { status: 409, body: e } : Promise.reject(e)),
        ]);
        // Observe both real transactions waiting on the held advisory lock before release.
        const deadline = Date.now() + 3_000;
        let waiting = 0;
        while (waiting < 2 && Date.now() < deadline) {
          const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND pg_blocking_pids(a.pid) @> ARRAY[$1::int]", [blockerPID]);
          waiting = result.rows[0].n;
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(waiting, 2, "both entry transactions must reach the production advisory lock");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        // Always consume requests, even if the overlap assertion failed.
        if (requests) await requests.catch(() => {});
      }
      const responses = await requests!;
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
      const blocked = responses.find(r => r.status === 409)!;
      assert.equal(blocked.body.code, "CONFIRM_REQUIRED");
      assert.equal(blocked.body.warnings[0].code, "COACH_CONFLICT");
      assert.equal(await audits() - count, 1);
      assert.equal([await row(a.id), await row(b.id)].filter(r => r.coachName).length, 1);
    });

    await t.test("changed warning source invalidates an old signed confirmation", async () => {
      const source = await make("token-source", "2099-03-07", venues[1].id, { coachName: "Synthetic Coach Token" });
      const target = await make("token-target", "2099-03-07"), count = await audits();
      const input = { expectedVersion: 1, coachName: "Synthetic Coach Token" };
      const first = await send(target.id, input, true);
      assert.equal(first.status, 409);
      assert.equal(typeof first.body.confirmationToken, "string");
      // A committed writer changes the relevant row, without changing the target version.
      assert.equal((await send(source.id, { expectedVersion: 1, className: "source changed", coachName: "Synthetic Coach Token" })).status, 200);
      const stale = await send(target.id, { ...input, confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.body.confirmationToken }, true);
      assert.equal(stale.status, 409);
      assert.equal((await row(target.id)).version, 1);
      assert.equal(await audits() - count, 1);
      const fresh = await send(target.id, { ...input, confirmWarnings: ["COACH_CONFLICT"], confirmationToken: stale.body.confirmationToken }, true);
      assert.equal(fresh.status, 200);
      assert.equal((await row(target.id)).version, 2);
      assert.equal(await audits() - count, 2);
    });

    await t.test("locked coach assignment succeeds but locked class name cannot be overridden", async () => {
      const r = await make("locked", "2099-03-08", venues[0].id, { isClassLocked: true });
      assert.equal((await send(r.id, { expectedVersion: 1, coachName: "000" }, true)).status, 200);
      const result: any = await callSchedulingTool("update_schedule", { scheduleId: r.id, expectedVersion: 2, coachName: null });
      assert.equal(result.updated.version, 3);
      await assert.rejects(callSchedulingTool("update_schedule", { scheduleId: r.id, expectedVersion: 3, className: "override", forceLocked: true }), (e: any) => e.code === "SCHEDULE_LOCKED");
      assert.equal((await row(r.id)).className, "locked");
    });

    await t.test("a real PostgreSQL audit constraint failure rolls back both entry writes", async () => {
      const r = await make("rollback", "2099-03-09"), count = await audits();
      const observed: Array<{ className: string | null; notes: string | null; version: number }> = [];
      const failureCodes: string[] = [];
      const postgresCode = (error: any): string | undefined => error?.code ?? (error?.cause ? postgresCode(error.cause) : undefined);
      setAuditWriterForTest(async () => {
        const [pending] = await currentDb().select().from(schema.schedules).where(eq(schema.schedules.id, r.id));
        observed.push({ className: pending.className, notes: pending.notes, version: pending.version });
        try {
          await currentDb().execute(sql`insert into operation_audit (actor, action, entity, entity_id) values (null, 'x', 'x', 'x')`);
        } catch (error) {
          failureCodes.push(postgresCode(error) ?? "unknown");
          throw error;
        }
      });
      try {
        assert.equal((await send(r.id, { expectedVersion: 1, className: "must rollback" })).status, 500);
        await assert.rejects(callSchedulingTool("update_schedule", { scheduleId: r.id, expectedVersion: 1, notes: "must rollback" }), (error: any) => postgresCode(error) === "23502");
        assert.deepEqual(observed, [
          { className: "must rollback", notes: null, version: 2 },
          { className: "rollback", notes: "must rollback", version: 2 },
        ], "both audit writers must see their pending business mutation in the same transaction");
        assert.deepEqual(failureCodes, ["23502", "23502"]);
        assert.deepEqual([(await row(r.id)).className, (await row(r.id)).notes, (await row(r.id)).version, await audits()], ["rollback", null, 1, count]);
      } finally { setAuditWriterForTest(null); }
    });
  } finally {
    setAuditWriterForTest(null);
    setBaseDbForTest(null);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
});
