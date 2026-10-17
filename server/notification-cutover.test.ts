import assert from "node:assert/strict";
import test from "node:test";
import { assertNotificationSchema } from "./infra/queue/preflight";
import { notificationSchemaContract } from "./infra/queue/schema-contract";
import { startNotificationApplication, notificationEntryConfig } from "./infra/queue/application";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

function database(missing = "", version = 24) {
  const calls: string[] = [];
  return { calls, query: async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("SHOW")) return { rows: [{ transaction_read_only: "on" }] };
    if (sql.includes("pg_attribute a JOIN pg_class")) return { rows: Object.entries(notificationSchemaContract).flatMap(([relation, columns]) => Object.entries(columns).filter(([c]) => c !== missing).map(([column,[type,required]]) => ({ relation,column,type,required }))) };
    if (sql.includes("to_regprocedure")) return { rows: [{ ready:true, states:["created","retry","active","completed","cancelled","failed"] }] };
    if (sql.includes("to_regclass")) return { rows: [{ version: "pgboss.version" }] };
    if (sql.includes("pgboss.version")) return { rows: [{ version }] };
    if (sql.includes("pg_index")) return { rows: [
      ["line_notify_logs", ["coach_name", "notify_type", "schedule_date"]],
      ["weekly_push_runs", ["idempotency_key"]],
      ["weekly_push_runs", ["push_type", "week_start_date", "destination", "dry_run"]],
      ["weekly_push_recipients", ["delivery_key"]], ["weekly_push_outbox", ["run_id"]],
    ].map(([table_name, columns]) => ({ table_name, columns })) };
    return { rows: [] };
  } };
}

test("cutover preflight uses one read-only transaction and rolls back without starting a worker", async () => {
  const db = database(); await assertNotificationSchema(db);
  assert.equal(db.calls[0], "BEGIN READ ONLY");
  assert.equal(db.calls.at(-1), "ROLLBACK");
  assert.ok(db.calls.every(sql => /^(BEGIN READ ONLY|SHOW|SELECT|ROLLBACK)/.test(sql)));
});
for (const column of ["idempotency_key", "line_retry_key", "next_retry_at", "published_at"]) {
  test(`cutover rejects missing ${column} before any worker or DDL`, async () => {
    const db = database(column); await assert.rejects(assertNotificationSchema(db), /NOTIFICATION_SCHEMA_NOT_READY/);
    assert.equal(db.calls.at(-1), "ROLLBACK");
  });
}
test("cutover rejects an unreviewed pg-boss schema version", async () => {
  await assert.rejects(assertNotificationSchema(database("", 25)), /NOTIFICATION_QUEUE_VERSION/);
});
const optIn = { NOTIFICATION_RUNTIME_MODE: "always-on", ENABLE_WEEKLY_PUSH_QUEUE: "1", ENABLE_WEEKLY_PUSH_WORKER: "1" };
test("notification entry requires explicit always-on and queue/worker configuration", () => {
  for (const e of [{}, { ...optIn, NOTIFICATION_RUNTIME_MODE: "autoscale" }, { ...optIn, ENABLE_WEEKLY_PUSH_WORKER: "0" }, { ...optIn, ENABLE_LINE_NOTIFY: "off" }]) assert.throws(() => notificationEntryConfig(e));
  assert.equal(notificationEntryConfig(optIn).weeklyCron, "0 12 * * 0");
  assert.equal(notificationEntryConfig(optIn).timezone, "Asia/Taipei");
  assert.throws(() => notificationEntryConfig({ ...optIn, WEEKLY_PUSH_CRON:"invalid" }), /CRON_INVALID/);
  assert.throws(() => notificationEntryConfig({ ...optIn, WEEKLY_PUSH_TIMEZONE:"invalid" }), /TIMEZONE_INVALID/);
});
test("entry fails closed before importing HTTP or worker when preflight fails", async () => {
  const calls: string[] = [];
  await assert.rejects(startNotificationApplication(notificationEntryConfig(optIn), {
    preflight: async () => { calls.push("preflight"); throw Error("schema missing"); },
    startWeb: async () => { calls.push("web"); }, startWorkers: async () => { calls.push("workers"); },
    configureSchedules: async () => { calls.push("schedules"); return {}; }, stopWorkers: async () => { calls.push("stopWorkers"); },
    stopWeb: async () => { calls.push("stopWeb"); }, captureSchedules: async () => ({}), restoreSchedules: async () => { calls.push("restore"); },
  }), /schema missing/);
  assert.deepEqual(calls, ["preflight"]);
});
for (const fail of ["workers", "schedules", "none"]) test(`entry ${fail}: explicit same-process lifecycle preserves scope and drains`, async () => {
  const calls: string[] = []; let options: unknown;
  const start = startNotificationApplication(notificationEntryConfig(optIn), {
    preflight: async () => { calls.push("preflight"); }, startWeb: async () => { calls.push("web"); },
    startWorkers: async () => { calls.push("workers"); if (fail === "workers") throw Error(fail); },
    captureSchedules: async () => ({}), configureSchedules: async input => { calls.push("schedules"); options=input; if (fail === "schedules") throw Error(fail); return {}; },
    stopWorkers: async () => { calls.push("stopWorkers"); }, stopWeb: async () => { calls.push("stopWeb"); },
    restoreSchedules: async () => { calls.push("restore"); },
  });
  if (fail !== "none") { await assert.rejects(start); assert.deepEqual(calls.slice(-2), ["stopWorkers", "stopWeb"]); assert.equal(calls.includes("restore"), fail === "schedules"); }
  else {
    const app = await start; assert.deepEqual(calls, ["preflight", "web", "workers", "schedules"]);
    assert.deepEqual(options, { enabled:true, weeklyCron:"0 12 * * 0", timezone:"Asia/Taipei", kinds:["weekly","daily","reconcile"] });
    await Promise.all([app.stop(), app.stop()]);
    assert.deepEqual(calls.slice(-2), ["stopWorkers", "stopWeb"]);
    assert.ok(!calls.includes("restore"), "restart must preserve durable schedule definitions");
  }
});

for (const code of ["weekly_push_legacy_history_blocked", "weekly_push_ambiguous_scheduled_coach"]) test(`HTTP enqueue explains ${code} as a conflict without a false success`, async () => {
  const source = readFileSync(new URL("./modules/weeklyPush/weeklyPush.routes.ts", import.meta.url), "utf8");
  const module = { exports: {} as any }, handlers = new Map<string, Function>();
  const imports: Record<string, unknown> = {
    "../notificationWake/wake-readiness": {externalWakeConfigured:()=>false},
    "../notificationWake/wake-intake": {},
    zod: { z }, "../../shared/auth/adminPassword": { requireAdminPassword() {} },
    "./weeklyPush.repository": { weeklyPushRepo: {} },
    "./weeklyPush.service": { enqueueWeeklyPush: async () => { throw Error(code); } },
    "../../infra/files/reportStorage": {}, "./weeklyPush.report": {},
    "../../config/featureFlags": { featureFlags: { enableWeeklyPushQueue: true, enableWeeklyPushWorker: true } },
    "./weeklyPush.worker": { areWeeklyPushWorkersReady: () => true }, "./weeklyPush.reconcile": {},
    "../../shared/audit": { recordTriggerAudit() { throw Error("Blocked enqueue must not audit a completed trigger"); } },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports:module.exports, require: (name:string) => { assert.ok(name in imports, name); return imports[name]; }, console, Error }, { timeout:5000 });
  module.exports.registerWeeklyPushRoutes({ get() {}, post(path:string,...callbacks:Function[]) { handlers.set(path, callbacks.at(-1)!); } });
  let status=200, body:any;
  const response = { status(value:number) { status=value; return this; }, json(value:any) { body=value; return this; } };
  await handlers.get("/api/admin/weekly-push/enqueue")!({ body:{} }, response);
  assert.equal(status,409); assert.equal(body.code,code); assert.match(body.message,/請先/);
});
