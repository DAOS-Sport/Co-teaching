import assert from "node:assert/strict";
import test from "node:test";
import {
  type CoachLike,
  compareCoachPriority,
  decideVenue,
  field,
  indexCoachUsersByLineId,
  indexCoachUsersByName,
  isCoachRole,
  normalizeLineId,
  parseRagicBody,
} from "./ragic.logic";

// Synthetic LINE user id (real ones are "U" + 32 hex chars).
const LINE_A = "U" + "0123456789abcdef".repeat(2);
const LINE_B = "U" + "fedcba9876543210".repeat(2);

const kindOf = (r: ReturnType<typeof parseRagicBody>): string => (r.ok ? "ok" : r.kind);

test("parseRagicBody: a record map yields the records in key order", () => {
  const body = JSON.stringify({
    "37": { _ragicId: 37, 部門名稱: "永樂國小" },
    "38": { _ragicId: 38, 部門名稱: "士林國中" },
  });
  const r = parseRagicBody(body);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.records.map((x) => x["部門名稱"]), ["永樂國小", "士林國中"]);
});

test("parseRagicBody: Ragic's error envelope is an api_error, not zero records", () => {
  const r = parseRagicBody('{"status":"ERROR","msg":"This sheet is access right protected."}');
  assert.deepEqual(r, { ok: false, kind: "api_error", message: "ERROR: This sheet is access right protected." });
  assert.deepEqual(parseRagicBody('{"status":"INVALID"}'), { ok: false, kind: "api_error", message: "INVALID" });
});

test("parseRagicBody: empty, malformed and non-object bodies are classified", () => {
  assert.deepEqual(parseRagicBody(""), { ok: false, kind: "empty", message: "empty response body" });
  assert.equal(kindOf(parseRagicBody("   ")), "empty");
  assert.equal(kindOf(parseRagicBody("<html>")), "malformed");
  assert.equal(kindOf(parseRagicBody("[1,2]")), "malformed");
  assert.equal(kindOf(parseRagicBody("null")), "malformed");
});

test("parseRagicBody: an empty sheet is ok with zero records; stray non-record values are dropped", () => {
  const empty = parseRagicBody("{}");
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.records.length, 0);
  const mixed = parseRagicBody('{"1":{"_ragicId":1},"note":"x","2":[1]}');
  assert.equal(mixed.ok, true);
  if (mixed.ok) assert.deepEqual(mixed.records, [{ _ragicId: 1 }]);
});

test("field: trims strings and tolerates missing or non-string values", () => {
  const rec = { _ragicId: 1, 姓名: "  陳沛衡 ", 手機: null, 應徵職務: ["教練"] };
  assert.equal(field(rec, "姓名"), "陳沛衡");
  assert.equal(field(rec, "手機"), "");
  assert.equal(field(rec, "應徵職務"), "");
  assert.equal(field(rec, "不存在"), "");
});

test("decideVenue: blocklist, internal units, aliases, existing and new", () => {
  const existing = new Set(["福林國小", "新北高中"]);
  assert.deepEqual(decideVenue({ name: "", operationType: "OT" }, existing), { action: "skip", reason: "unnamed" });
  assert.deepEqual(decideVenue({ name: "建成國中", operationType: "勞務採購" }, existing), { action: "skip", reason: "excluded" });
  assert.deepEqual(decideVenue({ name: "營運長室", operationType: "內勤單位" }, existing), { action: "skip", reason: "internal" });
  assert.deepEqual(decideVenue({ name: "新北高中", operationType: "OT" }, existing), { action: "exists" });
  assert.deepEqual(decideVenue({ name: "勞務-福林國小", operationType: "勞務採購" }, existing), { action: "skip", reason: "labor-alias" });
  // A 勞務- entry with no un-prefixed twin is still governed by the blocklist / created normally.
  assert.deepEqual(decideVenue({ name: "勞務-民生國中", operationType: "勞務採購" }, existing), { action: "skip", reason: "excluded" });
  assert.deepEqual(decideVenue({ name: "勞務-某新校", operationType: "勞務採購" }, existing), { action: "create" });
  assert.deepEqual(decideVenue({ name: "永樂國小", operationType: "勞務採購" }, existing), { action: "create" });
  assert.deepEqual(decideVenue({ name: " 永樂國小 ", operationType: " 勞務採購 " }, existing), { action: "create" });
});

const user = (o: Partial<CoachLike> & { id: string }): CoachLike => ({
  name: "X",
  status: "approved",
  lineId: null,
  employeeId: null,
  createdAt: new Date("2026-02-23T00:00:00Z"),
  ...o,
});

test("indexCoachUsersByName: approved beats rejected regardless of row order", () => {
  const rejected = user({ id: "r", name: "潘思蒓", status: "rejected", createdAt: new Date("2026-02-23T00:00:00Z") });
  const approved = user({ id: "a", name: "潘思蒓", status: "approved", lineId: LINE_A, createdAt: new Date("2026-02-25T00:00:00Z") });
  assert.equal(indexCoachUsersByName([rejected, approved]).get("潘思蒓")?.id, "a");
  assert.equal(indexCoachUsersByName([approved, rejected]).get("潘思蒓")?.id, "a");
  const pending = user({ id: "p", name: "潘思蒓", status: "pending", lineId: LINE_B });
  assert.equal(indexCoachUsersByName([pending, rejected]).get("潘思蒓")?.id, "p");
});

test("indexCoachUsersByName: same status → the one holding a LINE ID, then the oldest", () => {
  const noLine = user({ id: "n", createdAt: new Date("2026-01-01T00:00:00Z") });
  const withLine = user({ id: "l", lineId: LINE_A, createdAt: new Date("2026-03-01T00:00:00Z") });
  assert.equal(indexCoachUsersByName([noLine, withLine]).get("X")?.id, "l");
  const older = user({ id: "o", createdAt: new Date("2025-12-01T00:00:00Z") });
  assert.equal(indexCoachUsersByName([noLine, older]).get("X")?.id, "o");
  const undated = user({ id: "u", createdAt: null });
  assert.equal(indexCoachUsersByName([undated, older]).get("X")?.id, "o");
});

test("indexCoachUsersByName: keys are trimmed and blank names are dropped", () => {
  const m = indexCoachUsersByName([user({ id: "1", name: " 陳沛衡 " }), user({ id: "2", name: "   " })]);
  assert.deepEqual([...m.keys()], ["陳沛衡"]);
  assert.equal(m.get("陳沛衡")?.id, "1");
});

test("indexCoachUsersByLineId: only accounts with a LINE ID are indexed", () => {
  const m = indexCoachUsersByLineId([user({ id: "1", lineId: LINE_A }), user({ id: "2" }), user({ id: "3", lineId: LINE_B })]);
  assert.deepEqual([...m.keys()].sort(), [LINE_A, LINE_B].sort());
  assert.equal(m.get(LINE_A)?.id, "1");
});

test("compareCoachPriority: approved < pending < rejected < unknown", () => {
  const order = ["approved", "pending", "rejected", "whatever"].map((status, i) => user({ id: String(i), status }));
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareCoachPriority(order[i], order[i + 1]) < 0, `${order[i].status} should rank above ${order[i + 1].status}`);
  }
  assert.equal(compareCoachPriority(order[0], order[0]), 0);
});

test("isCoachRole: string and array 應徵職務 both work", () => {
  assert.equal(isCoachRole({ _ragicId: 1, 應徵職務: "游泳教練" }), true);
  assert.equal(isCoachRole({ _ragicId: 1, 應徵職務: ["救生員", "教練"] }), true);
  assert.equal(isCoachRole({ _ragicId: 1, 應徵職務: ["救生員"] }), false);
  assert.equal(isCoachRole({ _ragicId: 1, 應徵職務: [42] }), false);
  assert.equal(isCoachRole({ _ragicId: 1 }), false);
});

test("normalizeLineId: accepts only real LINE user ids", () => {
  assert.equal(normalizeLineId(LINE_A), LINE_A);
  assert.equal(normalizeLineId(` ${LINE_A} `), LINE_A);
  assert.equal(normalizeLineId(LINE_A.toUpperCase()), LINE_A.toUpperCase());
  assert.equal(normalizeLineId("U123"), null);
  assert.equal(normalizeLineId("蘇允湛"), null);
  assert.equal(normalizeLineId(""), null);
  assert.equal(normalizeLineId("X" + "0".repeat(32)), null);
});
