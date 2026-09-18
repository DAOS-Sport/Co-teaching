import test from "node:test";
import assert from "node:assert/strict";
import {
  parseScheduleImportText,
  SCHEDULE_IMPORT_MAX_ROWS,
  SCHEDULE_IMPORT_TEMPLATE,
} from "./scheduleImport";

test("parses the documented TSV template", () => {
  const result = parseScheduleImportText(SCHEDULE_IMPORT_TEMPLATE);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    line: 2,
    date: "2026-09-07",
    period: 1,
    className: "新北116",
    coachName: "潘思蒓",
    coachName2: null,
    coachCount: 1,
    notes: null,
  });
});

test("accepts common Chinese headers and 第N節 notation", () => {
  const result = parseScheduleImportText(
    "\uFEFF日期\t節次\t班級\t教練一\t教練二\t教練人數\t備註\r\n2026-10-01\t第3節\t泳訓A\t甲教練\t乙教練\t2\t雙教練",
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].period, 3);
  assert.equal(result.rows[0].coachCount, 2);
  assert.equal(result.rows[0].notes, "雙教練");
});

test("reports line-specific validation errors", () => {
  const result = parseScheduleImportText(
    "日期\t節次\t班別\t教練1\t教練2\t教練人數\n2026-02-30\t9\t\t同名\t同名\t3",
  );
  assert.equal(result.rows.length, 0);
  assert.ok(result.errors.some((error) => error.line === 2 && error.message.includes("YYYY-MM-DD")));
  assert.ok(result.errors.some((error) => error.line === 2 && error.message.includes("1 到 7")));
  assert.ok(result.errors.some((error) => error.line === 2 && error.message.includes("班別")));
  assert.ok(result.errors.some((error) => error.line === 2 && error.message.includes("只能是 1 或 2")));
});

test("requires all mandatory headers", () => {
  const result = parseScheduleImportText("日期\t班別\n2026-09-07\tA班");
  assert.equal(result.rows.length, 0);
  assert.ok(result.errors.some((error) => error.line === 1 && error.message.includes("節次")));
});

test("rejects more than the maximum row count", () => {
  const rows = Array.from(
    { length: SCHEDULE_IMPORT_MAX_ROWS + 1 },
    (_, index) => `2026-09-07\t1\t班級${index}`,
  );
  const result = parseScheduleImportText(["日期\t節次\t班別", ...rows].join("\n"));
  assert.equal(result.rows.length, 0);
  assert.ok(result.errors[0].message.includes(String(SCHEDULE_IMPORT_MAX_ROWS)));
});
