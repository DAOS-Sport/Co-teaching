import test from "node:test";
import assert from "node:assert/strict";

// These tests must never connect to a real database or send notifications.
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
const { storage } = await import("../storage");
const { db } = await import("../db");
// #3: write tools run in a transaction and add an audit row; stand in for both.
(db as unknown as { transaction: unknown }).transaction = async (fn: (tx: unknown) => unknown) => fn(db);
const { setAuditWriterForTest } = await import("../shared/audit");
const auditRows: any[] = [];
setAuditWriterForTest(async (entry) => { auditRows.push(entry); });
const { schedules, venues, timeSlots, coachUsers } = await import("../../shared/schema");
const { callSchedulingTool } = await import("./schedulingTools");
const { ScheduleRepository } = await import("../repositories/schedule.repository");
const { buildRecipientsForWeek } = await import("../modules/weeklyPush/weeklyPush.service");

const venue = { id: "venue", name: "測試場館", color: "blue", order: 1 };
const slot = { id: "slot", order: 1, period: "1", startTime: "08:00", endTime: "09:00" };
const row = (id: string, coachName: string | null = null, coachName2: string | null = null) => ({
  id, date: "2026-09-30", venueId: venue.id, timeSlotId: slot.id,
  className: id, coachName, coachName2, coachCount: coachName2 ? 2 : 1,
  coach1IsTeaching: true, coach2IsTeaching: false, isClassLocked: false,
  venue, timeSlot: slot,
});
const approved = [{ id: "real", name: "熊韋程", linkedCoachName: null, lineId: "test-line", status: "approved" }];

test("MCP: repeated placeholders, both slots, search, clear and replacement with approved coach", async (t) => {
  const rows = [row("first"), row("second"), { ...row("third"), venueId: "other", venue: { ...venue, id: "other", name: "另一場館" } }];
  const repo = new ScheduleRepository();
  t.mock.method(repo, "getSchedulesByDate", async () => rows);
  t.mock.method(storage, "getScheduleById", async (id: string) => rows.find(r => r.id === id));
  t.mock.method(storage, "getSchedulesByDateRange", async () => rows);
  t.mock.method(storage, "updateSchedule", async (id: string, fields: object) => Object.assign(rows.find(r => r.id === id)!, fields));
  t.mock.method(storage, "getConflicts", (date: string) => repo.getConflicts(date));
  t.mock.method(storage, "getVenues", async () => [venue, { ...venue, id: "other", name: "另一場館" }]);
  t.mock.method(storage, "getTimeSlots", async () => [slot]);
  const approvalLookup = t.mock.method(storage, "getApprovedCoachUsers", async () => approved);
  const call = (scheduleId: string, fields: object) => callSchedulingTool("update_schedule", { scheduleId, ...fields }) as Promise<any>;

  for (const r of rows) {
    const result = await call(r.id, { coachName: "000" });
    assert.equal(result.updated.coachName, "000");
    assert.deepEqual(result.conflictWarnings, []);
  }
  assert.equal(approvalLookup.mock.callCount(), 0);
  assert.deepEqual((await call("first", { coachName2: "000" })).conflictWarnings, []);
  const found: any = await callSchedulingTool("find_schedules", { startDate: "2026-09-30", endDate: "2026-09-30", coachName: "000" });
  assert.equal(found.totalMatched, 3);
  assert.ok(found.schedules.every((s: any) => s.coachName === "000"));
  await call("first", { coachName2: null });
  assert.equal(rows[0].coachName2, null);
  await call("first", { coachName: null });
  assert.equal(rows[0].coachName, null);
  await assert.rejects(call("first", { coachName: "未核准" }), /已核准教練/);
  assert.deepEqual((await call("first", { coachName: "熊韋程" })).conflictWarnings, []);
  // Two classes at the same venue in one period are not a conflict (#6 is cross-venue).
  assert.deepEqual((await call("second", { coachName: "熊韋程" })).conflictWarnings, []);
  const conflict = await call("third", { coachName: "熊韋程" });
  assert.equal(conflict.conflictWarnings[0].coachName, "熊韋程");
  await assert.rejects(call("second", { coachName2: "熊韋程" }), /同一位教練/);
  const last = auditRows.at(-1);
  assert.deepEqual([last.actor, last.action, last.entityId, last.after.coachName], ["MCP", "schedule.update", "third", "熊韋程"]);
  assert.equal(last.reason, "另一場館 2026-09-30 第1節 third");
});

test("MCP batch: preview and commit preserve 000 with no approval or conflict warnings", async (t) => {
  const existing = [row("existing", "000", "000")];
  const written: any[] = [];
  const executor: any = {
    execute: async () => undefined,
    transaction: async (fn: (tx: unknown) => unknown) => fn(executor),
    select: () => ({ from: (table: unknown) => {
      const data = table === venues ? [venue] : table === timeSlots ? [slot] : table === schedules ? existing : table === coachUsers ? approved : [];
      return Object.assign(Promise.resolve(data), { where: async () => data });
    } }),
    insert: () => ({ values: async (values: object) => written.push(values) }),
    update: () => ({ set: (values: object) => ({ where: async () => written.push(values) }) }),
  };
  t.mock.method(db, "select", executor.select);
  t.mock.method(db, "transaction", async (fn: any) => fn(executor));
  t.mock.method(storage, "getVenues", async () => [venue]);
  const approvalLookup = t.mock.method(storage, "getApprovedCoachUsers", async () => approved);
  const args = { venueName: venue.name, updateMatching: true, rows: ["existing", "new"].map(className => ({ date: "2026-09-30", period: 1, className, coachName: "000", coachName2: "000" })) };
  const preview: any = await callSchedulingTool("create_or_update_schedules", { ...args, previewOnly: true });
  assert.equal(preview.canCommit, true);
  assert.equal(preview.summary.warning, 0);
  const result: any = await callSchedulingTool("create_or_update_schedules", args);
  assert.equal(result.committed, true);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.warningCount, 0);
  assert.equal(written.length, 2);
  assert.ok(written.every(r => r.coachName === "000" && r.coachName2 === "000"));
  assert.equal(approvalLookup.mock.callCount(), 0);
  const imported = auditRows.at(-1);
  assert.deepEqual([imported.action, imported.after.created, imported.after.updated], ["schedule.import", 1, 1]);
  const realPreview: any = await callSchedulingTool("create_or_update_schedules", { ...args, previewOnly: true, rows: args.rows.map(r => ({ ...r, coachName: "熊韋程" })) });
  assert.ok(realPreview.rows[1].issues.some((i: any) => i.code === "coach_conflict"));
});

test("statistics and weekly recipients exclude placeholders but retain the real second coach", async (t) => {
  const rows = [row("empty", "000", "000"), row("mixed", "000", "熊韋程")];
  t.mock.method(db, "select", () => ({ from: () => ({ innerJoin: () => ({ where: async () => rows.map(r => ({ ...r, venueName: venue.name, venueColor: venue.color })) }) }) }));
  const stats = await new ScheduleRepository().getCoachStatistics("2026-09-30", "2026-09-30");
  assert.equal(stats.length, 1);
  assert.equal(stats[0].coachName, "熊韋程");
  assert.equal(stats[0].totalClasses, 1);
  t.mock.method(storage, "getApprovedCoachUsers", async () => [...approved, { ...approved[0], id: "placeholder", name: "000" }]);
  t.mock.method(storage, "getSchedulesByDateRange", async () => rows);
  const recipients = await buildRecipientsForWeek("2026-09-28", "2026-10-04");
  assert.deepEqual(recipients.map(r => [r.recipientName, r.scheduleCount]), [["熊韋程", 1]]);
});
