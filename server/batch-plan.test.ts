import test from "node:test";
import assert from "node:assert/strict";
import { planImport, planCopyWeek } from "./core/scheduling/batch-plan";

const row = (id: string, extra: any = {}) => ({ id, date: "2099-03-02", venueId: "v", timeSlotId: "s", className: "Class A", classKey: "classa", coachName: "Synthetic A", coachName2: null, coachCount: 1, coach1IsTeaching: true, coach2IsTeaching: false, isClassLocked: false, notes: "keep", createdAt: null, updatedAt: null, version: 1, ...extra });
const input = (extra: any = {}) => ({ line: 2, date: "2099-03-02", period: 1, className: "Class A", classKey: "classa", coachName: null, coachName2: null, coachCount: 1 as const, notes: null, providedFields: ["date", "period", "className"], ...extra });
const context = (extra: any = {}) => ({ venue: { id: "v", name: "Synthetic Venue" }, schedules: [row("a")], slots: [{ id: "s", order: 1 }], approvedCoaches: ["Synthetic A"], availability: [], ...extra });

test("import preserves omitted fields and previews explicit clears", () => {
  const preserved = planImport({ rows: [input()], errors: [], mode: "update_matching", context: context() });
  assert.equal(preserved.rows[0].values.coachName, undefined);
  assert.equal(preserved.rows[0].values.notes, undefined);
  const cleared = planImport({ rows: [input({ providedFields: ["date", "period", "className", "coachName", "notes"] })], errors: [], mode: "update_matching", context: context() });
  assert.deepEqual(cleared.rows[0].clearedFields.sort(), ["coachName", "notes"]);
  assert.equal(cleared.rows[0].values.coachName, null);
});
test("normalized class key matches existing rows and duplicate input", () => {
  const plan = planImport({ rows: [input({ className: "Class\t A" }), input({ line: 3, className: "CLASS A" })], errors: [], mode: "update_matching", context: context() });
  assert.equal(plan.rows[0].existingScheduleId, "a");
  assert.equal(plan.canCommit, false);
  assert.equal(plan.summary.error, 1);
});
test("locked dates and canonical duplicate coaches fail before any apply", () => {
  const locked = planImport({ rows: [input()], errors: [], mode: "update_matching", context: context({ schedules: [row("a", { isClassLocked: true })] }) });
  assert.equal(locked.canCommit, false);
  const duplicate = planImport({ rows: [input({ coachName: "Synthetic A", coachName2: "SyntheticA", coachCount: 2, providedFields: ["coachName", "coachName2", "coachCount"] })], errors: [], mode: "update_matching", context: context() });
  assert.equal(duplicate.canCommit, false);
  assert.ok(duplicate.rows[0].issues.some(i => i.code === "duplicate_coach"));
});
test("copy limits dates, preserves empty-cell policy and blocks locked target dates", () => {
  const base = { sourceStartDate: "2099-03-02", sourceEndDate: "2099-03-08", targetStartDate: "2099-03-09", venueId: "v" };
  const good = planCopyWeek(base, [row("a")]);
  assert.equal(good.plannedCount, 1);
  assert.equal(good.items[0].date, "2099-03-09");
  assert.equal(good.rows[0].values.coachName, null);
  const locked = planCopyWeek(base, [row("a"), row("b", { date: "2099-03-09", timeSlotId: "other", isClassLocked: true })]);
  assert.equal(locked.canCommit, false);
  assert.ok(locked.rows[0].issues.some(i => i.code === "locked"));
  assert.throws(() => planCopyWeek({ ...base, sourceEndDate: "2099-03-20" }, []), /INVALID_COPY_RANGE/);
  assert.throws(() => planCopyWeek({ ...base, targetStartDate: "2099-03-03" }, []), /OVERLAPPING_COPY_RANGE/);
});
