import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

// #3 (spec S4b): on a real PostgreSQL, a business write and its audit row
// commit or roll back together, including writes that open their own inner
// transaction (copy-week, MCP batch delete). Runs only when AUDIT_PG_URL
// points at a throwaway database with the app schema; it uses node-postgres,
// not the Neon driver the app runs on.
const url = process.env.AUDIT_PG_URL;
if (!url || process.env.CT_THROWAWAY_PG !== "1") throw new Error("Explicit isolated PostgreSQL URL and opt-in are required");
const isolated = new URL(url);
if (isolated.hostname !== "127.0.0.1" || !/^\/ct_(?:a1|ca3)_[a-zA-Z0-9_]+$/.test(isolated.pathname) || !isolated.port || isolated.port === "5432") throw new Error("Refusing a non-isolated PostgreSQL target");
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/isolated";

test("audit row and business write commit or roll back together on PostgreSQL", { timeout: 60000 }, async () => {
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

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  setBaseDbForTest(db);
  const app = express();
  app.use(express.json());
  registerScheduleRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, path: string, body: object) =>
    (await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword }, body: JSON.stringify(body) })).status;
  const auditCount = async () => Number((await db.execute(sql`select count(*)::int as n from operation_audit`)).rows[0].n);
  const scheduleRow = async (id: string) => (await db.select().from(schema.schedules).where(eq(schema.schedules.id, id)))[0];
  const weekRows = async (from: string, to: string) =>
    Number((await db.execute(sql`select count(*)::int as n from schedules where date between ${from} and ${to}`)).rows[0].n);
  // Fails inside PostgreSQL (NOT NULL actor), not in JavaScript.
  let copyForAudit: { venueId: string; targetStartDate: string } | null = null;
  const observedPendingCopy: number[] = [];
  const auditFailureCodes: string[] = [];
  const failingAudit = async () => {
    assert.ok(copyForAudit, "Copy observation must be configured before failure injection");
    const pending = await currentDb().execute(sql`SELECT count(*)::int AS n FROM schedules WHERE venue_id=${copyForAudit!.venueId} AND date>=${copyForAudit!.targetStartDate}::date AND date<(${copyForAudit!.targetStartDate}::date + INTERVAL '7 days')`);
    observedPendingCopy.push(Number(pending.rows[0].n));
    try { 
    await currentDb().execute(sql`insert into operation_audit (actor, action, entity, entity_id) values (null, 'x', 'x', 'x')`);
   assert.fail("Original audit SQL must fail"); }
    catch (error) {
      let cause: any = error; for (let depth=0; cause && !cause.code && depth<8; depth++) cause=cause.cause;
      const code=String(cause?.code ?? "UNKNOWN"); auditFailureCodes.push(code); assert.equal(code, "23502"); throw error;
    }
  };

  try {
    await db.execute(sql`truncate operation_audit, schedules, venues, time_slots restart identity cascade`);
    const [venue] = await db.insert(schema.venues).values({ name: "測試場館", color: "blue", order: 1 }).returning();
    const [slot] = await db.insert(schema.timeSlots).values({ period: "第1節", startTime: "08:00", endTime: "09:00", order: 1 }).returning();
    const [row] = await db.insert(schema.schedules).values({ date: "2099-03-04", venueId: venue.id, timeSlotId: slot.id, className: "A班" }).returning();
    const copyWeek = { sourceStartDate: "2099-03-02", sourceEndDate: "2099-03-08", targetStartDate: "2099-03-09", venueId: venue.id };
    copyForAudit = copyWeek;
    const sendJson = async (method: string, path: string, body: object) => { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const previewCopy = async () => {
      const response = await sendJson("POST", "/api/schedules/copy-week", { ...copyWeek, preview: true });
      assert.equal(response.status, 200);
      assert.equal(typeof response.body.confirmationToken, "string");
      return { ...copyWeek, confirmationToken: response.body.confirmationToken };
    };

    // Committed together.
    assert.equal(await send("PUT", `/api/schedules/${row.id}`, { expectedVersion: 1, className: "A班改", coachName: null }), 200);
    assert.equal((await scheduleRow(row.id)).className, "A班改");
    assert.equal(await auditCount(), 1);

    // Audit insert fails in the database → the change is rolled back too.
    setAuditWriterForTest(failingAudit);
    assert.equal(await send("PUT", `/api/schedules/${row.id}`, { expectedVersion: 2, className: "B班", coachName: null }), 500);
    const kept = await scheduleRow(row.id);
    assert.deepEqual([kept.className, kept.version], ["A班改", 2]);
    assert.equal(await send("POST", "/api/schedules/copy-week", await previewCopy()), 500);
    assert.equal(observedPendingCopy.at(-1), 1, "Copy row must exist in the transaction before audit SQL fails");
    assert.equal(auditFailureCodes.at(-1), "23502");
    assert.equal(await weekRows("2099-03-09", "2099-03-15"), 0, "copy-week rows must roll back with the audit row");
    await assert.rejects(callSchedulingTool("delete_schedules", { scheduleIds: [row.id] }));
    assert.ok(await scheduleRow(row.id), "MCP delete must roll back with the audit row");
    assert.equal(await auditCount(), 1);

    // Inner transactions become savepoints of the audited one and commit with it.
    setAuditWriterForTest(null);
    assert.equal(await send("POST", "/api/schedules/copy-week", await previewCopy()), 200);
    assert.equal(await weekRows("2099-03-09", "2099-03-15"), 1);
    await callSchedulingTool("delete_schedules", { scheduleIds: [row.id] });
    assert.equal(await scheduleRow(row.id), undefined);
    const actions = (await db.execute(sql`select actor, action from operation_audit order by id`)).rows;
    assert.deepEqual(actions, [
      { actor: "共用管理員", action: "schedule.update" },
      { actor: "共用管理員", action: "schedule.copy_week" },
      { actor: "MCP", action: "schedule.bulk_delete" },
    ]);
  } finally {
    setAuditWriterForTest(null);
    setBaseDbForTest(null);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
