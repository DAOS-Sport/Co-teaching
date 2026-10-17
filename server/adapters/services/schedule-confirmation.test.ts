import test from "node:test";
import assert from "node:assert/strict";
import { createScheduleConfirmation } from "./schedule-confirmation";
import type { ConfirmationContext } from "../../core/scheduling/entities";

const context = (): ConfirmationContext => ({
  kind: "updateSchedule", scheduleId: "synthetic-schedule", version: 3,
  canonicalPatch: { coachName: "Synthetic Coach A", notes: null },
  warningSnapshot: { schedules: [], timeSlot: { id: "slot", order: 1 }, availability: [] },
  warnings: [{ code: "COACH_CONFLICT", coachName: "Synthetic Coach A", message: "synthetic conflict" }],
});

test("warning token binds all business context and contains no person details", async () => {
  const codec = createScheduleConfirmation("synthetic-test-key", () => 1_000);
  const data = context(), token = await codec.issue(data);
  assert.equal(await codec.verify(token, data), true);
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.deepEqual(Object.keys(payload).sort(), ["context", "expiresAt", "version"]);
  assert.equal(JSON.stringify(payload).includes("Synthetic Coach"), false);
  assert.equal(await codec.verify(token, { ...data, version: 4 }), false);
  assert.equal(await codec.verify(token, { ...data, scheduleId: "other" }), false);
  assert.equal(await codec.verify(token, { ...data, kind: "assignCoach" }), false);
  assert.equal(await codec.verify(token, { ...data, canonicalPatch: { ...data.canonicalPatch, notes: "changed" } }), false);
  assert.equal(await codec.verify(token, { ...data, warningSnapshot: { ...data.warningSnapshot, timeSlot: { id: "slot", order: 2 } } }), false);
  assert.equal(await codec.verify(token, { ...data, warnings: [] }), false);
  const reordered = { ...data, canonicalPatch: { notes: null, coachName: "Synthetic Coach A" } };
  assert.equal(await codec.verify(token, reordered), true);
});

test("warning token rejects tampering, other key, malformed values and exact expiry", async () => {
  let now = 1_000;
  const codec = createScheduleConfirmation("synthetic-test-key", () => now), data = context();
  const token = await codec.issue(data);
  for (const value of ["", ".", "a.b.c", "!.a", `${token}x`, `x${token}`]) {
    assert.equal(await codec.verify(value, data), false);
  }
  assert.equal(await createScheduleConfirmation("other-key", () => now).verify(token, data), false);
  now = 300_999;
  assert.equal(await codec.verify(token, data), true);
  now = 301_000;
  assert.equal(await codec.verify(token, data), false);
  now = 0;
  assert.equal(await codec.verify(token, data), false, "clock rollback must not extend lifetime");
});
