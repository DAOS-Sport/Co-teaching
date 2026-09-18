import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";

// Deliberately fixed task-owned endpoint; no production environment is consumed.
process.env.DATABASE_URL = "postgres://isolated@127.0.0.1:55438/postgres";
process.env.DATABASE_DRIVER = "pg";
process.env.NODE_ENV = "test";
process.env.ADMIN_PASSWORD = "isolated-admin-password";
process.env.REPLIT_DOMAINS = "127.0.0.1";
const { db, pool } = await import("./db");
const { sql, eq } = await import("drizzle-orm");
const schema = await import("../shared/schema");
const { ScheduleRepository } = await import("./repositories/schedule.repository");
const { CoachRepository } = await import("./repositories/coach.repository");
const { VenueRepository } = await import("./repositories/venue.repository");
const { actorContext, registerAuditContext } = await import("./shared/auth/auditContext");
const { registerScheduleRoutes } = await import("./modules/schedule.routes");
const { registerCoachPortalRoutes } = await import("./modules/coachPortal.routes");
const { issueCoachSessionToken } = await import("./shared/auth/coachPortalSession");
const { previewScheduleImport, commitScheduleImport } = await import("./modules/scheduleImport.service");

test("real PostgreSQL mutation, authorization and concurrency regressions", async t => {
  const schedules = new ScheduleRepository(); const coaches = new CoachRepository(); const venues = new VenueRepository();
  const prefix = randomUUID();
  const actor = { id: "test-admin", role: "admin", venueIds: [], requestId: prefix };
  const asAdmin = <T>(fn: () => T) => actorContext.run(actor, fn);
  try {
    const [venueA] = await db.insert(schema.venues).values({ name: prefix + " A", color: "blue", order: 1 }).returning();
    const [venueB] = await db.insert(schema.venues).values({ name: prefix + " B", color: "blue", order: 2 }).returning();
    const [slot] = await db.insert(schema.timeSlots).values({ period: prefix, startTime: "08:00", endTime: "09:00", order: 1 }).returning();
    const [coach] = await db.insert(schema.coachUsers).values({ name: prefix, status: "approved" }).returning();
    await asAdmin(() => coaches.upsertCoachAvailability(coach.name, "2026-09-21", [{ dayOfWeek: 1, timeSlotOrder: 1 }], coach.id));
    const input = { date: "2026-09-21", venueId: venueA.id, timeSlotId: slot.id, className: prefix, coachName: coach.name };
    const created = await asAdmin(() => schedules.upsertSchedule(input));

    await t.test("concurrent writers cannot silently overwrite", async () => {
      const results = await Promise.allSettled([
        asAdmin(() => schedules.updateSchedule(created.id, { className: prefix + " one" }, created.version)),
        asAdmin(() => schedules.updateSchedule(created.id, { className: prefix + " two" }, created.version)),
      ]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(failure.reason.code, "VERSION_CONFLICT");
    });
    await t.test("cross-venue overlap, unavailable time and locked rows are rejected", async () => {
      await assert.rejects(asAdmin(() => schedules.upsertSchedule({ ...input, venueId: venueB.id })), { code: "COACH_TIME_CONFLICT" });
      await assert.rejects(asAdmin(() => schedules.upsertSchedule({ ...input, date: "2026-09-22" })), { code: "COACH_UNAVAILABLE" });
      await asAdmin(() => schedules.lockSchedules(venueA.id, input.date, input.date));
      const current = (await schedules.getScheduleById(created.id))!;
      await assert.rejects(asAdmin(() => schedules.updateSchedule(current.id, { className: "locked" }, current.version)), { code: "SCHEDULE_LOCKED" });
      const changed = await actorContext.run({ ...actor, overrideReason: "isolated supervisor exception" }, () => schedules.updateSchedule(current.id, { className: "override" }, current.version));
      assert.equal(changed.className, "override");
      const evidence = await pool.query("select override_reason from operation_audit where entity_id=$1 order by id desc limit 1", [current.id]);
      assert.equal(evidence.rows[0].override_reason, "isolated supervisor exception");
      await asAdmin(() => schedules.unlockSchedules(venueA.id, input.date, input.date));
    });
    await t.test("audit failure rolls business write back", async () => {
      await pool.query("ALTER TABLE operation_audit ADD CONSTRAINT isolated_audit_fail CHECK (after_data->>'className' IS DISTINCT FROM 'force-audit-fail')");
      try {
        const current = (await schedules.getScheduleById(created.id))!;
        await assert.rejects(asAdmin(() => schedules.updateSchedule(current.id, { className: "force-audit-fail" }, current.version)));
        assert.equal((await schedules.getScheduleById(created.id))!.className, current.className);
      } finally { await pool.query("ALTER TABLE operation_audit DROP CONSTRAINT isolated_audit_fail"); }
    });
    await t.test("failed replacement preserves availability and venue history", async () => {
      await assert.rejects(asAdmin(() => coaches.upsertCoachAvailability(coach.name, "2026-09-21", [{ dayOfWeek: 2, timeSlotOrder: 1 }, { dayOfWeek: 2, timeSlotOrder: 1 }], coach.id)));
      const remaining = await db.select().from(schema.coachAvailability).where(eq(schema.coachAvailability.coachUserId, coach.id));
      assert.equal(remaining.length, 1); assert.equal(remaining[0].dayOfWeek, 1);
      await assert.rejects(asAdmin(() => venues.deleteVenue(venueA.id)), { code: "VENUE_HAS_SCHEDULE_HISTORY" });
      assert.ok(await schedules.getScheduleById(created.id));
    });
    await t.test("duplicate names fail closed while stable IDs survive rename", async () => {
      await db.insert(schema.coachUsers).values({ name: coach.name, status: "approved" });
      await assert.rejects(asAdmin(() => schedules.upsertSchedule({ ...input, date: "2026-09-28" })), { code: "COACH_IDENTITY_AMBIGUOUS" });
      await coaches.updateCoachUserName(coach.id, prefix + " renamed");
      const current = (await schedules.getScheduleById(created.id))!;
      const updated = await asAdmin(() => schedules.updateSchedule(current.id, { className: "still same person" }, current.version));
      assert.equal(updated.coachUserId, coach.id);
      await asAdmin(() => coaches.updateCoachUserLineId(coach.id, prefix + "-line"));
      await assert.rejects(asAdmin(() => coaches.updateCoachUserLineId(coach.id, prefix + "-other-line")), { code: "COACH_LINE_ID_CONFLICT" });
    });
    await t.test("import is atomic and rejects changed previews", async () => {
      const header = "日期\t節次\t班別\t教練1\t教練2\t教練人數";
      const text = header + `\n2026-09-29\t1\t${prefix}-import1\t\t\t1\n2026-09-30\t1\t${prefix}-import2\tmissing-${prefix}\t\t1`;
      const preview = await previewScheduleImport(venueB.id, text, "insert_only");
      assert.equal(preview.canCommit, true);
      await assert.rejects(asAdmin(() => commitScheduleImport(venueB.id, text, "insert_only", preview.previewToken)), { code: "COACH_IDENTITY_AMBIGUOUS" });
      const absent = await pool.query("SELECT id FROM schedules WHERE venue_id=$1 AND date='2026-09-29'", [venueB.id]);
      assert.equal(absent.rowCount, 0);
      const shortText = header + `\n2026-09-29\t1\t${prefix}-import1\t\t\t1`;
      const old = await previewScheduleImport(venueB.id, shortText, "update_matching");
      await asAdmin(() => schedules.upsertSchedule({ date:"2026-09-29", venueId:venueB.id, timeSlotId:old.rows[0].timeSlotId!, className:prefix+"-import1" }));
      await assert.rejects(asAdmin(() => commitScheduleImport(venueB.id, shortText, "update_matching", old.previewToken)), { code:"IMPORT_PREVIEW_CONFLICT" });
    });
    await t.test("existing admin and coach auth protect list while role split is deferred", async () => {
      const app = express(); app.use(express.json());
      registerAuditContext(app); registerScheduleRoutes(app); registerCoachPortalRoutes(app);
      const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
      const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
      try {
        assert.equal((await fetch(base + "/api/coach-portal/approved-coaches")).status, 401);
        const token = await issueCoachSessionToken(coach.id, "synthetic-line-id");
        const own = await fetch(base + "/api/coach-portal/approved-coaches", { headers: { "x-coach-token": token } });
        assert.equal(own.status, 200); const rows = await own.json();
        assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "name"]);
        const admin = await fetch(base + "/api/coach-portal/approved-coaches", { headers: { "x-admin-password": "isolated-admin-password" } });
        assert.equal(admin.status, 200);
        assert.ok((await admin.json()).every((r: object) => Object.keys(r).sort().join(",") === "id,name"));
        const other = await fetch(base + "/api/coach-portal/availability?coachName=someone-else&weekStart=2026-09-21", { headers: { "x-coach-token": token } });
        assert.equal(other.status, 403);
        const current = (await schedules.getScheduleById(created.id))!;
        const responses = await Promise.all(["http-one", "http-two"].map(className => fetch(base + `/api/schedules/${created.id}`, {
          method:"PUT", headers:{"Content-Type":"application/json","x-admin-password":"isolated-admin-password"},
          body:JSON.stringify({className,expectedVersion:current.version}),
        })));
        assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
        const evidence = await pool.query("SELECT actor_id FROM operation_audit WHERE entity_id=$1 ORDER BY id DESC LIMIT 1",[created.id]);
        assert.equal(evidence.rows[0].actor_id,"shared-admin:identity-unknown");
      } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    });
  } finally { await pool.end(); }
});
