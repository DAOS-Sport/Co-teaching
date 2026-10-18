import assert from "node:assert/strict";
import test from "node:test";
import { fanoutWeeklyRun, handleBoundedRecipient } from "./notification-batch";

function fixture(count = 400, dryRun = false) {
  const rows = Array.from({ length: count }, (_, n) => ({ id: `recipient-${String(n).padStart(4, "0")}`, runId: "saved-run", status: "pending", nextRetryAt: null as Date | null, lineRetryKey: `saved-key-${n}`, payloadJson: { message: `saved-body-${n}` } }));
  const calls: string[] = [];
  const run = { id: "saved-run", dryRun };
  const deps = {
    getRunById: async () => run,
    listRecipientsByRun: async () => [...rows].reverse(),
    getRecipientById: async (id: string) => rows.find(r => r.id === id) ?? null,
    enqueueRecipientJob: async (runId: string, id: string) => { assert.equal(runId, run.id); calls.push(`enqueue:${id}`); },
    updateRecipient: async (id: string, patch: { status: string }) => { calls.push(`skip:${id}`); Object.assign(rows.find(r => r.id === id)!, patch); },
    deliverSavedRecipient: async (id: string) => { calls.push(`deliver:${id}`); return { state: "accepted", retry: false }; },
  };
  return { rows, calls, run, deps };
}

test("400 saved recipients fan out in two finite steps without delivery or new identities", async () => {
  const f = fixture(), before = structuredClone(f.rows);
  const first = await fanoutWeeklyRun("saved-run", f.deps, { limit: 200 });
  assert.equal(first.queued, 200);
  assert.equal(first.complete, false);
  const second = await fanoutWeeklyRun("saved-run", f.deps, { limit: 200, cursor: first.nextCursor });
  assert.equal(second.queued, 200);
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set(f.calls).size, 400);
  assert.ok(f.calls.every(call => call.startsWith("enqueue:")));
  assert.deepEqual(f.rows, before, "fanout does not replace saved retry key, body, status or IDs");
});

test("abort during enqueue awaits that write then saves cursor and stops the next unit", async () => {
  const f = fixture(5), controller = new AbortController();
  let finished = false;
  f.deps.enqueueRecipientJob = async (_runId: string, id: string) => { controller.abort(); await Promise.resolve(); finished = true; f.calls.push(id); };
  const result = await fanoutWeeklyRun("saved-run", f.deps, { signal: controller.signal, limit: 5 });
  assert.equal(finished, true);
  assert.equal(result.queued, 1);
  assert.equal(result.nextCursor, f.rows[0].id);
  assert.equal(result.complete, false);
});

test("deadline and pre-abort cannot start a read or delivery", async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(2);
  f.deps.getRunById = async () => { throw new Error("must not read"); };
  assert.equal((await fanoutWeeklyRun("saved-run", f.deps, { signal: controller.signal })).complete, false);
  assert.equal((await handleBoundedRecipient({ runId: "saved-run", recipientId: "recipient-0000" }, f.deps, { deadlineMs: 10, now: () => 10 })).stopped, true);
  assert.equal(f.calls.length, 0);
});

test("dry-run skips recipients with zero enqueue and zero send", async () => {
  const f = fixture(3, true);
  const result = await fanoutWeeklyRun("saved-run", f.deps, { limit: 3 });
  assert.equal(result.complete, true);
  assert.equal(result.queued, 0);
  assert.ok(f.rows.every(row => row.status === "skipped"));
  await handleBoundedRecipient({ runId: "saved-run", recipientId: f.rows[0].id }, f.deps);
  assert.ok(f.calls.every(call => call.startsWith("skip:")));
});

test("one recipient preserves existing payload and key; never finalizes its run", async () => {
  const f = fixture(2), before = structuredClone(f.rows);
  const result = await handleBoundedRecipient({ runId: "saved-run", recipientId: f.rows[0].id }, f.deps);
  assert.equal(result.settled, true);
  assert.deepEqual(f.calls, [`deliver:${f.rows[0].id}`]);
  assert.deepEqual(f.rows, before);
});

test("future retry_wait and terminal unknown do not send; unclaimed remains retryable", async () => {
  const f = fixture(1), row = f.rows[0];
  row.status = "retry_wait"; row.nextRetryAt = new Date(500);
  const future = await handleBoundedRecipient({ runId: row.runId, recipientId: row.id }, f.deps, { now: () => 100 });
  assert.equal(future.retry, true); assert.equal(future.settled, false);
  row.status = "unknown"; row.nextRetryAt = null;
  const unknown = await handleBoundedRecipient({ runId: row.runId, recipientId: row.id }, f.deps);
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.settled, true);
  assert.equal(f.calls.length, 0);
  row.status = "processing";
  f.deps.deliverSavedRecipient = async () => ({ state: "unclaimed", retry: false });
  const unclaimed = await handleBoundedRecipient({ runId: row.runId, recipientId: row.id }, f.deps);
  assert.equal(unclaimed.retry, true); assert.equal(unclaimed.settled, false);
});

test("mismatched run fence and delivery completion fence errors cannot acknowledge success", async () => {
  const f = fixture(1);
  f.rows[0].runId = "other-run";
  await assert.rejects(handleBoundedRecipient({ runId: "saved-run", recipientId: f.rows[0].id }, f.deps), /recipient_run_mismatch/);
  assert.equal(f.calls.length, 0);
  f.rows[0].runId = "saved-run";
  f.deps.deliverSavedRecipient = async () => { throw new Error("claim was superseded"); };
  await assert.rejects(handleBoundedRecipient({ runId: "saved-run", recipientId: f.rows[0].id }, f.deps), /superseded/);
});
