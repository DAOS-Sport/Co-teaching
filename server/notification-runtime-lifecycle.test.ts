import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(relative: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, Date, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name: string) { assert.ok(name in imports, `unstubbed dependency ${name}`); return imports[name]; }, ...globals,
  }, { timeout: 5000 });
  return module.exports;
}

function reconciliation(countsPatch: Record<string, number>, reportError = false) {
  const run: Record<string, unknown> = { id: "synthetic-run", status: "sending", pushType: "weekly" };
  const counts = { total: 1, success: 0, failed: 0, unknown: 0, skipped: 0, pending: 0, sending: 0, retryWait: 0, ...countsPatch };
  let reportCalls = 0, summaryCalls = 0, enqueued = 0;
  const pings: string[] = [];
  const repo = { getRunById: async () => run, listRecipientsByRun: async () => [{ id: "synthetic-accepted", status: "accepted", nextRetryAt: null }],
    countRecipientStatuses: async () => counts,
    updateRun: async (_id: string, patch: Record<string, unknown>) => { Object.assign(run, patch); return run; } };
  const worker = load("./modules/weeklyPush/weeklyPush.worker.ts", {
    "../../infra/queue/boss": {}, "../../infra/queue/queues": { queues: {} },
    "../../infra/healthchecks/healthchecks.client": { pingStart: async () => { pings.push("start"); }, pingSuccess: async () => { pings.push("success"); }, pingFail: async () => { pings.push("fail"); } }, "../notification/delivery.service": {},
    "../notification/notification.service": { pushRunSummary: async () => { summaryCalls++; return { status: "accepted", configuredCount: 1 }; } },
    "./weeklyPush.repository": { weeklyPushRepo: repo },
    "./weeklyPush.report": { generateAndStoreReport: async () => { reportCalls++; if (reportError) throw new Error("synthetic-report-failure"); run.reportPath = "synthetic-report"; return "synthetic-report"; } },
  });
  const reconcile = load("./modules/weeklyPush/weeklyPush.reconcile.ts", {
    "./weeklyPush.repository": { weeklyPushRepo: repo }, "./weeklyPush.outbox": {},
    "./weeklyPush.service": { enqueueRecipientJob: async () => { enqueued++; } },
    "./weeklyPush.worker": worker,
  });
  return { run, pings, reconcile: () => reconcile.reconcileWeeklyPushRun("synthetic-run"), stats: () => ({ reportCalls, summaryCalls, enqueued }) };
}

for (const [name, counts, expected] of [
  ["all failed", { failed: 1 }, "failed"],
  ["partial", { total: 2, success: 1, failed: 1 }, "partial_success"],
  ["unknown", { unknown: 1 }, "unknown"],
  ["accepted", { success: 1 }, "success"],
] as const) {
  test(`actual reconciliation ${name} uses worker finalization and report gate`, async () => {
    const f = reconciliation(counts);
    await f.reconcile();
    assert.equal(f.run.status, expected);
    assert.deepEqual(f.stats(), { reportCalls: 1, summaryCalls: 1, enqueued: 0 });
  });
}

test("actual reconciliation report failure rejects and preserves failed run without completion", async () => {
  const f = reconciliation({ success: 1 }, true);
  await assert.rejects(f.reconcile(), /synthetic-report-failure/);
  assert.equal(f.run.status, "failed");
  assert.equal(f.run.completedAt, null);
  assert.equal(f.stats().enqueued, 0);
});

test("completed reconciliation is idempotent and generic notifications never create weekly reports", async () => {
  const weekly = reconciliation({ success: 1 });
  await weekly.reconcile();
  await weekly.reconcile();
  assert.deepEqual(weekly.stats(), { reportCalls: 1, summaryCalls: 1, enqueued: 0 });
  assert.deepEqual(weekly.pings, ["start", "success"]);
  const generic = reconciliation({ success: 1 });
  generic.run.pushType = "notification";
  await generic.reconcile();
  assert.deepEqual(generic.stats(), { reportCalls: 0, summaryCalls: 0, enqueued: 0 });
  assert.deepEqual(generic.pings, []);
});

for (const failure of ["delete", "clear-reference"] as const) {
  test(`actual cleanup propagates ${failure} failure for queue retry`, async () => {
    let clearCalls = 0;
    const cleanup = load("./modules/weeklyPush/weeklyPush.cleanup.ts", {
      "./weeklyPush.repository": { weeklyPushRepo: { listRunsWithExpiredReports: async () => [{ id: "synthetic-run", reportPath: "synthetic-report" }],
        updateRun: async () => { clearCalls++; if (failure === "clear-reference") throw new Error("synthetic-clear-failure"); } } },
      "../../infra/files/reportStorage": { deleteReport: async () => { if (failure === "delete") throw new Error("synthetic-delete-failure"); return true; } },
    });
    await assert.rejects(cleanup.cleanupOldReports());
    assert.equal(clearCalls, failure === "delete" ? 0 : 1);
  });
}

test("actual stopBoss retains live instance after failure and can retry the same instance", async () => {
  let live = false, stops = 0, instances = 0;
  class FakeBoss {
    constructor() { instances++; }
    on() {}
    async start() { live = true; }
    async stop() { stops++; if (stops === 1) throw new Error("synthetic-stop-failure"); live = false; }
  }
  const boss = load("./infra/queue/boss.ts", { "pg-boss": FakeBoss, "../../config/env": { env: { databaseUrl: "synthetic-no-network" } } }, { process: { once() {} } });
  const started = await boss.startBoss();
  await assert.rejects(boss.stopBoss(), /synthetic-stop-failure/);
  assert.equal(live, true);
  assert.equal(boss.getBoss(), started);
  await boss.stopBoss();
  assert.equal(live, false);
  assert.equal(stops, 2);
  assert.equal(instances, 1);
  assert.throws(() => boss.getBoss());
});

test("actual concurrent stopBoss requests share one stop and clear reference after success", async () => {
  let release!: () => void, stops = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class FakeBoss { on() {} async start() {} async stop() { stops++; await gate; } }
  const boss = load("./infra/queue/boss.ts", { "pg-boss": FakeBoss, "../../config/env": { env: { databaseUrl: "synthetic-no-network" } } }, { process: { once() {} } });
  const started = await boss.startBoss();
  const first = boss.stopBoss(), second = boss.stopBoss();
  assert.equal(boss.getBoss(), started, "reference remains available until actual stop completes");
  release();
  await Promise.all([first, second]);
  assert.equal(stops, 1);
  assert.throws(() => boss.getBoss());
});
