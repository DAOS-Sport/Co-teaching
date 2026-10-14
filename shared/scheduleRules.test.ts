import assert from "node:assert/strict";
import test from "node:test";
import {
  findAssignmentWarnings,
  isoWeekdayOf,
  mondayOf,
  newlyPlacedCoaches,
  promoteCoachSlots,
  sameCoach,
  statisticsPeriod,
  unconfirmedWarnings,
} from "./scheduleRules";

test("settlement periods run from the 16th through the next 15th without overlap", () => {
  const september = statisticsPeriod(2026, 8);
  const october = statisticsPeriod(2026, 9);
  assert.equal(september.start.getDate(), 16);
  assert.equal(september.end.getDate(), 15);
  assert.equal(october.start.getTime() - september.end.getTime(), 86_400_000);
});

test("coach comparison rejects whitespace and case variants of the same person", () => {
  assert.equal(sameCoach(" 王教練 ", "王 教練"), true);
  assert.equal(sameCoach("Coach A", "coach a"), true);
  assert.equal(sameCoach("王教練", "陳教練"), false);
});

test("promoteCoachSlots: a lone slot-2 coach moves up and keeps their teaching flag", () => {
  assert.deepEqual(
    promoteCoachSlots({ coachName: null, coachName2: "張哲瑋", coach1IsTeaching: false, coach2IsTeaching: true }),
    { coachName: "張哲瑋", coachName2: null, coach1IsTeaching: true, coach2IsTeaching: false },
  );
  assert.deepEqual(
    promoteCoachSlots({ coachName: "  ", coachName2: "張哲瑋", coach1IsTeaching: true, coach2IsTeaching: false }),
    { coachName: "張哲瑋", coachName2: null, coach1IsTeaching: false, coach2IsTeaching: false },
  );
});

test("promoteCoachSlots: consistent slots are left alone", () => {
  assert.equal(promoteCoachSlots({ coachName: "熊韋程", coachName2: "張哲瑋", coach1IsTeaching: false, coach2IsTeaching: false }), null);
  assert.equal(promoteCoachSlots({ coachName: "熊韋程", coachName2: null, coach1IsTeaching: true, coach2IsTeaching: false }), null);
  assert.equal(promoteCoachSlots({ coachName: null, coachName2: null, coach1IsTeaching: false, coach2IsTeaching: false }), null);
  assert.equal(promoteCoachSlots({ coachName: null, coachName2: " ", coach1IsTeaching: false, coach2IsTeaching: false }), null);
});

test("000 is not a duplicate coach and still occupies a confirmed slot", () => {
  assert.equal(sameCoach("000", "000"), false);
  assert.equal(sameCoach("000", "熊韋程"), false);
  assert.equal(promoteCoachSlots({ coachName: "000", coachName2: "熊韋程", coach1IsTeaching: false, coach2IsTeaching: true }), null);
});

test("calendar helpers read YYYY-MM-DD as a calendar date in any process timezone", () => {
  assert.equal(isoWeekdayOf("2026-10-12"), 1);
  assert.equal(isoWeekdayOf("2026-10-18"), 7);
  assert.equal(mondayOf("2026-10-18"), "2026-10-12");
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
});

test("only coaches newly placed on a row are checked; 000 and 缺 are not people", () => {
  assert.deepEqual(newlyPlacedCoaches(null, { coachName: " 王教練 ", coachName2: "000" }), ["王教練"]);
  assert.deepEqual(newlyPlacedCoaches({ coachName: null, coachName2: "王教練" }, { coachName: "王教練", coachName2: null }), []);
  assert.deepEqual(newlyPlacedCoaches({ coachName: "王教練", coachName2: null }, { coachName: "王 教練", coachName2: "缺" }), []);
  assert.deepEqual(newlyPlacedCoaches({ coachName: "王教練", coachName2: null }, { coachName: "王教練", coachName2: "李教練" }), ["李教練"]);
});

test("assignment warnings: same-slot clash on another row, and a filled week missing this slot", () => {
  const sameSlotSchedules = [
    { id: "self", venueId: "v1", coachName: "王教練", coachName2: null, className: "A", venue: { name: "一館" } },
    { id: "x", venueId: "v2", coachName: "林教練", coachName2: "王教練", className: "B", venue: { name: "二館" } },
    { id: "y", venueId: "v3", coachName: "陳教練-李教練", coachName2: null, className: "C", venue: { name: "三館" } },
  ];
  const weekAvailability = [
    { coachName: "王教練", dayOfWeek: 3, timeSlotOrder: 2 },
    { coachName: "李教練", dayOfWeek: 1, timeSlotOrder: 1 },
  ];
  const warnings = findAssignmentWarnings({ scheduleId: "self", venueId: "v1", coaches: ["王教練", "李教練", "張教練"], sameSlotSchedules, weekAvailability, dayOfWeek: 3, timeSlotOrder: 2 });
  assert.deepEqual(warnings.map(w => [w.code, w.coachName]), [["COACH_CONFLICT", "王教練"], ["COACH_UNAVAILABLE", "李教練"]]);
  assert.match(warnings[0].message, /二館/);
  // Legacy combined names ("陳教練-李教練") are compared whole, as the assignment page does.
  assert.equal(unconfirmedWarnings(warnings, ["COACH_CONFLICT"]).length, 1);
  assert.equal(unconfirmedWarnings(warnings, ["COACH_CONFLICT", "COACH_UNAVAILABLE"]).length, 0);
  assert.equal(unconfirmedWarnings(warnings, "COACH_CONFLICT").length, 2);
});

test("a coach in two classes at the same venue and period is not a conflict (#6 is cross-venue)", () => {
  const sameSlotSchedules = [
    { id: "other-class", venueId: "v1", coachName: "王教練", coachName2: null, className: "B", venue: { name: "一館" } },
  ];
  const warnings = findAssignmentWarnings({ scheduleId: "self", venueId: "v1", coaches: ["王教練"], sameSlotSchedules, weekAvailability: [], dayOfWeek: 3, timeSlotOrder: 2 });
  assert.deepEqual(warnings, []);
});
