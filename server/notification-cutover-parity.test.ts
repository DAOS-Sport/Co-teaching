import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as dates from "date-fns";
import { zhTW } from "date-fns/locale";
import ts from "typescript";

function load(relative: string, imports: Record<string, unknown>): any {
  const module = { exports: {} };
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, Date, Buffer, console,
    require(name: string) { assert.ok(name in imports, `unstubbed dependency ${name}`); return imports[name]; },
  }, { timeout: 5000 });
  return module.exports;
}

const window = { weekStartDate: "2030-01-07", weekEndDate: "2030-01-13" };
const coach = { id: "synthetic-account", name: "synthetic-coach", linkedCoachName: null, lineId: "synthetic-destination" };
const schedule = { date: "2030-01-08", coachName: coach.name, coachName2: null,
  venue: { name: "synthetic-venue" }, timeSlot: { startTime: "09:00", endTime: "10:00", order: 1 }, className: null };

function serviceFixture(options: { legacy?: boolean; existing?: boolean; coaches?: any[]; schedules?: any[] } = {}) {
  const events: string[] = [], bundles: any[] = [];
  let keys = 0;
  const existing = { id: "synthetic-existing", idempotencyKey: "weekly-send:2030-01-07:coaches" };
  const service = load("./modules/weeklyPush/weeklyPush.service.ts", {
    "../../shared/dbContext": {}, "../../infra/queue/transaction": {}, "../../infra/queue/boss": {},
    "@shared/scheduleRules": { isRealCoachName: (name: string) => Boolean(name) },
    "date-fns": dates, "date-fns/locale": { zhTW }, "node:crypto": { randomUUID: () => `synthetic-key-${++keys}` },
    "../../storage": { storage: { getApprovedCoachUsers: async () => options.coaches ?? [coach],
      getSchedulesByDateRange: async (start: string, end: string) => { assert.equal(start, window.weekStartDate); assert.equal(end, window.weekEndDate); return options.schedules ?? [schedule]; } } },
    "../../config/env": { env: { publicOrigin: "https://example.invalid" } },
    "../../infra/queue/queues": { queues: { weeklyPush: "synthetic-weekly" } },
    "./weeklyPush.repository": { weeklyPushRepo: {
      getRunByIdempotencyKey: async () => options.existing ? existing : null,
      hasLegacyWeeklyLogsInWindow: async (start: string, end: string) => {
        assert.equal(start, window.weekStartDate); assert.equal(end, window.weekEndDate); events.push("legacy-read"); return options.legacy ?? false;
      },
      createRunBundle: async (run: any, recipients: any[]) => { bundles.push({ run, recipients }); return { run, created: true, recipientsCreated: recipients.length }; },
    } }, "./weeklyPush.outbox": { dispatchWeeklyPushOutbox: async () => { events.push("outbox"); } },
  });
  return { service, events, bundles, keys: () => keys, existing };
}

test("wet historical weekly log blocks before generating any run or delivery identity", async () => {
  const f = serviceFixture({ legacy: true });
  await assert.rejects(f.service.enqueueWeeklyPush(window), /^Error: weekly_push_legacy_history_blocked$/);
  assert.equal(f.bundles.length, 0); assert.equal(f.keys(), 0); assert.deepEqual(f.events, ["legacy-read"]);
});

test("durable weekly replay wins over legacy history without creating a new identity", async () => {
  const f = serviceFixture({ legacy: true, existing: true });
  const result = await f.service.enqueueWeeklyPush(window);
  assert.equal(result.run, f.existing); assert.equal(result.reused, true);
  assert.equal(f.bundles.length, 0); assert.equal(f.keys(), 0); assert.deepEqual(f.events, []);
});

test("historical dry-run still creates only skipped preview recipients", async () => {
  const f = serviceFixture({ legacy: true });
  await f.service.enqueueWeeklyPush({ ...window, dryRun: true });
  assert.equal(f.bundles.length, 1); assert.equal(f.bundles[0].run.dryRun, true);
  assert.equal(f.bundles[0].recipients[0].status, "skipped"); assert.equal(f.events.includes("legacy-read"), false);
});

for (const lineId of ["synthetic-other-destination", coach.lineId]) {
  test(`scheduled same-name accounts block before new identities even with ${lineId === coach.lineId ? "shared" : "distinct"} LINE destination`, async () => {
    const f = serviceFixture({ coaches: [coach, { ...coach, id: "synthetic-other-account", lineId }] });
    await assert.rejects(f.service.enqueueWeeklyPush(window), /^Error: weekly_push_ambiguous_scheduled_coach$/);
    assert.equal(f.bundles.length, 0); assert.equal(f.keys(), 0);
  });
}

test("linked name and secondary schedule coach participate in ambiguity protection", async () => {
  const f = serviceFixture({ coaches: [coach, { ...coach, id: "synthetic-other-account", name: "synthetic-other-name", linkedCoachName: coach.name }],
    schedules: [{ ...schedule, coachName: "synthetic-unrelated", coachName2: coach.name }] });
  await assert.rejects(f.service.enqueueWeeklyPush({ ...window, dryRun: true }), /weekly_push_ambiguous_scheduled_coach/);
  assert.equal(f.bundles.length, 0); assert.equal(f.keys(), 0);
});

test("ambiguous names with no classes in the requested window do not block other coaches", async () => {
  const f = serviceFixture({ coaches: [coach, { ...coach, id: "synthetic-other-account" },
    { ...coach, id: "synthetic-scheduled-account", name: "synthetic-scheduled" }], schedules: [{ ...schedule, coachName: "synthetic-scheduled" }] });
  await f.service.enqueueWeeklyPush(window);
  assert.equal(f.bundles[0].recipients.length, 1); assert.equal(f.bundles[0].recipients[0].recipientId, "synthetic-scheduled-account");
});

function workerFixture(reportError = false) {
  const events: string[] = [];
  const run = { id: "synthetic-preview", pushType: "weekly", dryRun: true, status: "queued" };
  const recipient = { id: "synthetic-preview-recipient", status: "pending" };
  const worker = load("./modules/weeklyPush/weeklyPush.worker.ts", {
    "../../infra/queue/boss": {}, "../../infra/queue/queues": { queues: { weeklyPush: "synthetic-weekly" } },
    "../../infra/healthchecks/healthchecks.client": { pingStart: async () => { events.push("monitor:start"); },
      pingSuccess: async () => { events.push("monitor:success"); }, pingFail: async () => { events.push("monitor:fail"); } },
    "../notification/delivery.service": { deliverSavedRecipient: async () => { events.push("recipient:http"); return { state: "accepted", retry: false }; } },
    "../notification/notification.service": { pushRunSummary: async () => { events.push("summary:http"); return { configuredCount: 2, status: "accepted" }; } },
    "./weeklyPush.report": { generateAndStoreReport: async () => { events.push("report"); if (reportError) throw new Error("synthetic-report-failure"); } },
    "./weeklyPush.repository": { weeklyPushRepo: {
      getRunById: async () => run, listRecipientsByRun: async () => [recipient],
      updateRun: async (_id: string, patch: object) => Object.assign(run, patch),
      updateRecipient: async (_id: string, patch: object) => Object.assign(recipient, patch),
      countRecipientStatuses: async () => ({ total: 1, success: 0, failed: 0, skipped: 1, pending: 0, sending: 0, retryWait: 0, unknown: 0 }),
    } },
  });
  return { worker, events, run, recipient };
}

for (const handler of ["handleWeeklyPushJob", "handleRecipientJob"] as const) {
  for (const reportError of [false, true]) {
    test(`${handler} preview ${reportError ? "failure" : "success"} has zero recipient/group/watchdog requests`, async () => {
      const f = workerFixture(reportError);
      const job = [{ name: "synthetic-weekly", data: { runId: f.run.id, recipientId: f.recipient.id } }];
      if (reportError) await assert.rejects(f.worker[handler](job), /synthetic-report-failure/);
      else await f.worker[handler](job);
      assert.equal(f.events.includes("report"), true); assert.equal(f.recipient.status, "skipped");
      assert.deepEqual(f.events.filter(event => event !== "report"), []);
    });
  }
}

test("summary service itself suppresses preview with both real group slots configured", async () => {
  let sends = 0;
  const summary = load("./modules/notification/notification.service.ts", {
    "./delivery.service": { notificationIdentity: () => "synthetic-identity", sendDurableText: async () => { sends++; return { accepted: true }; } },
    "../../config/env": { env: { publicOrigin: "https://example.invalid" } },
    "../../config/lineGroups": { lineGroups: { itGroupId: "synthetic-it", xieTongGroupId: "synthetic-xie" } },
  });
  const run = { id: "synthetic-preview", dryRun: true, status: "success", weekStartDate: window.weekStartDate,
    weekEndDate: window.weekEndDate, totalCount: 1, successCount: 0, failureCount: 0, skippedCount: 1 };
  const result = await summary.pushRunSummary({ run, recipients: [] });
  assert.equal(sends, 0); assert.equal(result.itPushed, false); assert.equal(result.xiePushed, false);
});
