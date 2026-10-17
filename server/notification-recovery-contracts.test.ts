import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(relative: string, imports: Record<string, unknown>): any {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Date, Buffer, console: { log() {}, warn() {}, error() {} }, require(name: string) { assert.ok(name in imports, `unstubbed dependency ${name}`); return imports[name]; } }, { timeout: 5000 });
  return module.exports;
}

function serviceFixture(crashFirst = false) {
  let row: any, calls = 0;
  const requests: { to: string; text: string; retryKey: string }[] = [];
  const repo = { createRunBundle: async (run: any, recipients: any[]) => {
    const created = !row;
    if (created) { row = recipients[0]; row.payloadJson.fixedDelivery = { notificationId: row.id, to: row.lineUserId, text: row.payloadJson.message, retryKey: row.lineRetryKey }; }
    return { created, run };
  }, getRecipientById: async () => row };
  const service = load("./modules/notification/delivery.service.ts", {
    "../../config/featureFlags": { featureFlags: { enableWeeklyPushQueue: true } }, "node:crypto": crypto,
    "../weeklyPush/weeklyPush.repository": { weeklyPushRepo: repo }, "../../infra/queue/queues": { queues: { notificationDelivery: "synthetic-delivery" } },
    "./delivery.repository": { notificationDeliveryStore: {} },
    "./lineNotify.adapter": { sendTextMessage: async (to: string, text: string, retryKey: string) => { requests.push({ to, text, retryKey }); return { accepted: true }; } },
    "../../core/notifications/delivery": { deliverNotification: async (_id: string, deps: any) => {
      if (row.status === "accepted") return { state: "not_ready", retry: false };
      calls++;
      await deps.send(row.payloadJson.fixedDelivery);
      if (crashFirst && calls === 1) { row.status = "processing"; throw new Error("synthetic-after-HTTP-crash"); }
      row.status = "accepted";
      return { state: "accepted", retry: false };
    } },
  });
  return { service, requests, row: () => row };
}

test("actual service opt-in recovery keeps first body/key after crash and never changes destination", async () => {
  const f = serviceFixture(true), input = { notificationId: "synthetic-operation", to: "synthetic-destination", text: "synthetic-first" };
  await assert.rejects(f.service.sendDurableText(input), /after-HTTP-crash/);
  const firstRow = f.row(), key = firstRow.lineRetryKey;
  const recovered = await f.service.sendDurableText({ ...input, text: "synthetic-edited", reuseSavedPayload: true });
  assert.equal(recovered.accepted, true);
  assert.equal(f.row(), firstRow);
  assert.equal(f.row().lineRetryKey, key);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.equal(f.requests[1].text, input.text);
  await f.service.sendDurableText({ ...input, text: "another-edit", reuseSavedPayload: true });
  assert.equal(f.requests.length, 2, "accepted same operation never sends again");
  await assert.rejects(f.service.sendDurableText({ ...input, to: "different-destination", reuseSavedPayload: true }));
  await assert.rejects(f.service.sendDurableText({ ...input, text: "strict-default-rejects-change" }));
  assert.equal(f.requests.length, 2);
});

function dailyFixture(options: { legacy?: boolean; ambiguous?: boolean; storageError?: boolean; crashFirst?: boolean } = {}) {
  const f = serviceFixture(options.crashFirst);
  const source = readFileSync(new URL("./line-notify.ts", import.meta.url), "utf8"), ast = ts.createSourceFile("line-notify.ts", source, 99, true);
  const node = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "sendDailyTomorrowNotifications");
  assert.ok(node);
  let label = "synthetic-class-first", legacy = options.legacy ?? false, logs = 0;
  const errors: string[] = [], coach = { id: "synthetic-account", name: "synthetic-coach", linkedCoachName: "synthetic-coach", lineId: "synthetic-destination" };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source.slice(node.getStart(ast), node.end) + "\nmodule.exports=sendDailyTomorrowNotifications;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, Date, process: { env: { LINE_CHANNEL_ACCESS_TOKEN: "synthetic-token" } }, console: { log() {}, error(message: string) { errors.push(message); } },
    storage: { getSchedulesByDateRange: async () => { if (options.storageError) throw new Error("synthetic-storage-failure"); return [{ coachName: coach.name, coachName2: null, className: label, coach1IsTeaching: true, venue: { name: "synthetic-venue" }, timeSlot: { order: 1, startTime: "09:00", endTime: "10:00" } }]; },
      getApprovedCoachUsers: async () => options.ambiguous ? [coach, { ...coach, id: "synthetic-other-account", lineId: "synthetic-other-destination" }] : [coach] },
    isRealCoachName: (value: unknown) => typeof value === "string" && value.length > 0,
    notificationIdentity: f.service.notificationIdentity, findSavedTextNotification: f.service.findSavedTextNotification, sendDurableText: f.service.sendDurableText,
    dailyLogAlreadyExists: async () => legacy, coachPortalUrl: () => "https://example.invalid/synthetic",
    lineNotifyLogs: { coachName: {}, notifyType: {}, scheduleDate: {} },
    db: { insert: () => ({ values: () => ({ onConflictDoNothing: async () => { logs++; legacy = true; } }) }) },
  }, { timeout: 5000 });
  return { ...f, daily: module.exports as () => Promise<void>, changeLabel: () => { label = "synthetic-class-edited"; }, errors, logs: () => logs };
}

test("actual daily plus service recovers after pre-ack crash with changed source using original body/key", async () => {
  const f = dailyFixture({ crashFirst: true });
  await assert.rejects(f.daily());
  assert.equal(f.logs(), 0, "legacy history is never written before acceptance");
  f.changeLabel();
  await f.daily();
  assert.equal(f.logs(), 1);
  assert.deepEqual(f.requests[0], f.requests[1]);
  await f.daily();
  assert.equal(f.requests.length, 2, "durable accepted record overrides legacy history during recovery");
});

for (const option of ["legacy", "ambiguous", "storageError"] as const) {
  test(`actual daily ${option} fails closed and exposes no new HTTP delivery`, async () => {
    const f = dailyFixture({ [option]: true });
    await assert.rejects(f.daily());
    assert.equal(f.requests.length, 0);
    assert.equal(f.logs(), 0);
    if (option === "legacy") assert.ok(f.errors.some(message => message.includes("unknown_legacy_untracked_operator_review_required")));
    if (option === "ambiguous") assert.ok(f.errors.some(message => message.includes("ambiguous_recipient")));
  });
}

function summaryFixture(groups: Record<string, string>, state = "accepted") {
  const sent: any[] = [];
  const service = load("./modules/notification/notification.service.ts", {
    "../../config/env": { env: { publicOrigin: "https://example.invalid" } },
    "../../config/lineGroups": { lineGroups: groups },
    "./lineNotify.adapter": {},
    "./delivery.service": { notificationIdentity: (purpose: string, values: unknown[]) => crypto.createHash("sha256").update(JSON.stringify([purpose, values])).digest("hex"),
      sendDurableText: async (input: any) => { sent.push(input); return { accepted: state === "accepted", state }; } },
  });
  const params = { run: { id: "synthetic-run", status: "partial_success", pushType: "weekly", weekStartDate: "2026-10-12", weekEndDate: "2026-10-18", totalCount: 2, successCount: 1, failureCount: 1, skippedCount: 0 },
    recipients: [{ id: "synthetic-a", status: "accepted", recipientName: "synthetic-a" }, { id: "synthetic-b", status: "failed", recipientName: "synthetic-b", errorCode: "synthetic-error" }] };
  return { service, sent, params };
}

for (const state of ["accepted", "unknown", "failed", "not_configured"]) {
  test(`actual summary exposes configured ${state} state independently of old booleans`, async () => {
    const f = summaryFixture({ itGroupId: "synthetic-group" }, state), receipt = await f.service.pushRunSummary(f.params);
    assert.equal(receipt.status, state);
    assert.equal(receipt.states.it, state);
    assert.equal(receipt.states.xie, "not_configured");
    assert.equal(receipt.itPushed, state === "accepted");
    assert.equal(receipt.configuredCount, 1);
  });
}

test("summary identities bind stable result versions and absent groups are not configured", async () => {
  const absent = summaryFixture({}), none = await absent.service.pushRunSummary(absent.params);
  assert.equal(none.status, "not_configured"); assert.equal(none.configuredCount, 0); assert.equal(absent.sent.length, 0);
  const f = summaryFixture({ itGroupId: "synthetic-group" });
  await f.service.pushRunSummary(f.params); await f.service.pushRunSummary(f.params);
  assert.equal(f.sent[0].notificationId, f.sent[1].notificationId);
  f.params.run.status = "success"; f.params.run.successCount = 2; f.params.run.failureCount = 0; f.params.recipients[1].status = "accepted";
  await f.service.pushRunSummary(f.params);
  assert.notEqual(f.sent[1].notificationId, f.sent[2].notificationId);
  assert.equal(f.sent.every(input => input.reuseSavedPayload === true), true);
});

function scheduleFixture() {
  const queues = Object.fromEntries(["notificationWeeklyTrigger", "notificationDailyTrigger", "notificationReconcile", "notificationCleanup"].map(name => [name, name]));
  const runtime = load("./infra/queue/runtime.ts", { "../../config/env": { env: {} }, "./boss": {}, "./queues": { queues },
    "../../modules/weeklyPush/weeklyPush.worker": {}, "../../modules/weeklyPush/weeklyPush.service": {}, "../../modules/weeklyPush/weeklyPush.repository": {},
    "../../modules/weeklyPush/weeklyPush.reconcile": {}, "../../modules/weeklyPush/weeklyPush.cleanup": {}, "../../modules/weeklyPush/weeklyPush.outbox": {} });
  const records = new Map(Object.values(queues).map(name => [name, { name, cron: "0 1 * * *", data: {}, options: { tz: "UTC" } }]));
  let mutations = 0;
  const boss = { getSchedules: async () => [...records.values()], unschedule: async (name: string) => { mutations++; records.delete(name); },
    schedule: async (name: string, cron: string, data: any, options: any) => { mutations++; records.set(name, { name, cron, data, options }); } };
  return { runtime, boss, records, mutations: () => mutations };
}

test("scoped schedule receipt restores weekly without dropping three unrelated schedules; empty previous is scoped", async () => {
  const f = scheduleFixture(), before = [...f.records.keys()].sort();
  const previous = await f.runtime.configureNotificationSchedules({ enabled: false, kinds: ["weekly"] }, f.boss);
  const unrelated = [...f.records.keys()].sort(), empty = await f.runtime.configureNotificationSchedules({ enabled: false, kinds: ["weekly"] }, f.boss);
  assert.equal(empty.previous.length, 0);
  await f.runtime.restoreNotificationSchedules(empty, f.boss);
  assert.deepEqual([...f.records.keys()].sort(), unrelated);
  await f.runtime.restoreNotificationSchedules(previous, f.boss);
  assert.deepEqual([...f.records.keys()].sort(), before);
});

test("restore rejects legacy arrays, invalid scopes and outside names before any mutation", async () => {
  const f = scheduleFixture();
  for (const bad of [[], { previous: [], kinds: [] }, { previous: [], kinds: ["invalid"] }, { previous: [{ name: "notificationDailyTrigger" }], kinds: ["weekly"] }]) {
    await assert.rejects(f.runtime.restoreNotificationSchedules(bad, f.boss));
  }
  assert.equal(f.mutations(), 0);
});
