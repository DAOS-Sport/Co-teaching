import assert from "node:assert/strict";
import test from "node:test";
import { promoteCoachSlots, sameCoach, statisticsPeriod } from "./scheduleRules";

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