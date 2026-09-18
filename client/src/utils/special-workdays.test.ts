import assert from "node:assert/strict";
import test from "node:test";
import { getExtendedWeekDays, getExtendedWeekEnd, getExtendedWeekdayNames } from "./special-workdays";

test("weekly views always cover Monday through Sunday", () => {
  const monday = new Date("2026-08-31T00:00:00Z");
  assert.equal(getExtendedWeekDays(monday).length, 7);
  assert.deepEqual(getExtendedWeekdayNames(monday), ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]);
  assert.equal(getExtendedWeekEnd(monday).toISOString().slice(0, 10), "2026-09-06");
});
