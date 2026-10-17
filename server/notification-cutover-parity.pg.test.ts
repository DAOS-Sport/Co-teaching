import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// No environment-file fallback, automatic provisioning, or production target.
test("B05 real PostgreSQL legacy parity and preview zero-outbound", async t => {
  const url = process.env.N3_TEST_DATABASE_URL;
  assert.equal(process.env.N3_TEST_ALLOW_ISOLATED_PG, "1", "Explicit isolated PostgreSQL opt-in is required");
  assert.ok(url, "N3_TEST_DATABASE_URL is required");
  const target = new URL(url);
  assert.equal(target.hostname, "127.0.0.1");
  assert.match(target.pathname, /^\/ct_ca3_[a-zA-Z0-9_]+$/);
  assert.ok(target.port && target.port !== "5432", "A task-owned random port is required");
  process.env.DATABASE_URL = url;
  process.env.ENABLE_WEEKLY_PUSH_QUEUE = "1";

  const require = createRequire(import.meta.url);
  const { Pool } = require("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const schema = await import("../shared/schema");
  const context = await import("./shared/dbContext");
  const { default: PgBoss } = await import("pg-boss");
  const { setQueueProducerForTest } = await import("./infra/queue/boss");
  const { queues } = await import("./infra/queue/queues");
  const { storage } = await import("./storage");
  const { weeklyPushRepo } = await import("./modules/weeklyPush/weeklyPush.repository");
  const { enqueueWeeklyPush } = await import("./modules/weeklyPush/weeklyPush.service");
  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  const producer = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) },
    migrate: false, supervise: false, schedule: false });
  context.setBaseDbForTest(db);
  setQueueProducerForTest(producer);

  const originalApproved = storage.getApprovedCoachUsers;
  const originalSchedules = storage.getSchedulesByDateRange;
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("Unexpected fixture outbound request"); };
  const coach = { id: "b05-parity-account", name: "synthetic-b05-coach", linkedCoachName: null, lineId: "synthetic-b05-line" };
  let ambiguous = false;
  storage.getApprovedCoachUsers = async () => (ambiguous
    ? [coach, { ...coach, id: "b05-parity-other-account" }] : [coach]) as any;
  storage.getSchedulesByDateRange = async () => [{ date: "2040-01-03", coachName: coach.name, coachName2: null,
    venue: { name: "synthetic-venue" }, timeSlot: { startTime: "09:00", endTime: "10:00", order: 1 }, className: null }] as any;
  const window = { weekStartDate: "2040-01-02", weekEndDate: "2040-01-08" };
  const fixedRunId = "00000000-0000-4000-8000-00000000b051";
  const wetKey = `weekly-send:${window.weekStartDate}:coaches`;
  const rollback = new Error("b05 parity fixture rollback");
  const counts = async () => (await context.currentDb().execute(sql`
    SELECT (SELECT count(*)::int FROM weekly_push_runs) runs,
      (SELECT count(*)::int FROM weekly_push_recipients) recipients,
      (SELECT count(*)::int FROM weekly_push_outbox) outbox,
      (SELECT count(*)::int FROM line_notify_logs) logs,
      (SELECT count(*)::int FROM pgboss.job) jobs`)).rows[0];
  const isolate = async (body: () => Promise<void>) => {
    await assert.rejects(context.inTransaction(async () => { await body(); throw rollback; }), error => error === rollback);
  };
  const history = () => context.currentDb().insert(schema.lineNotifyLogs).values({
    id: "b05-parity-legacy-fixed", coachName: coach.name, lineId: coach.lineId,
    content: "synthetic-existing-history", notifyType: "weekly", scheduleDate: "2040-01-03",
  });
  function load(relative: string, imports: Record<string, unknown>): any {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText, { module, exports: module.exports, Date, Buffer, console,
      require(name: string) { assert.ok(name in imports, `unstubbed dependency ${name}`); return imports[name]; },
    }, { timeout: 5000 });
    return module.exports;
  }

  try {
    // An isolated fixture's pre-provisioned schema is required; never start boss.
    await producer.createQueue(queues.weeklyPush);
    await t.test("Tuesday legacy history blocks before real run/recipient/outbox/job mutations", () => isolate(async () => {
      await history();
      const before = await counts();
      await assert.rejects(enqueueWeeklyPush(window), /^Error: weekly_push_legacy_history_blocked$/);
      assert.deepEqual(await counts(), before);
      assert.equal(await weeklyPushRepo.getRunByIdempotencyKey(wetKey), null);
      assert.equal(outbound, 0);
      assert.equal(await weeklyPushRepo.hasLegacyWeeklyLogsInWindow("2040-01-03", "2040-01-03"), true);
      assert.equal(await weeklyPushRepo.hasLegacyWeeklyLogsInWindow("2040-01-04", "2040-01-08"), false);
    }));
    await t.test("fixed durable historical identity is reused without replacing its saved state", () => isolate(async () => {
      await history();
      await context.currentDb().insert(schema.weeklyPushRuns).values({ id: fixedRunId, pushType: "weekly", ...window,
        destination: "coaches", idempotencyKey: wetKey, triggerSource: "manual", status: "unknown", dryRun: false });
      const before = await counts(), saved = await weeklyPushRepo.getRunById(fixedRunId);
      const replay = await enqueueWeeklyPush(window);
      assert.equal(replay.reused, true); assert.equal(replay.run.id, fixedRunId); assert.equal(replay.run.status, "unknown");
      assert.deepEqual(await weeklyPushRepo.getRunById(fixedRunId), saved); assert.deepEqual(await counts(), before);
      assert.equal(outbound, 0);
    }));
    await t.test("ambiguous scheduled accounts block before real persistence", () => isolate(async () => {
      ambiguous = true;
      try {
        const before = await counts();
        await assert.rejects(enqueueWeeklyPush(window), /^Error: weekly_push_ambiguous_scheduled_coach$/);
        assert.deepEqual(await counts(), before); assert.equal(outbound, 0);
      } finally { ambiguous = false; }
    }));
    await t.test("history preview persists skipped recipients and real job, with zero outbound on success and report failure", () => isolate(async () => {
      await history();
      const result = await enqueueWeeklyPush({ ...window, dryRun: true });
      assert.equal(result.reused, false); assert.equal(result.recipientsCreated, 1);
      const [recipient] = await weeklyPushRepo.listRecipientsByRun(result.run.id);
      assert.equal(recipient.status, "skipped");
      const savedKey = recipient.lineRetryKey, savedPayload = recipient.payloadJson;
      const job = await context.currentDb().execute(sql`SELECT id FROM pgboss.job WHERE id=${result.run.id}::uuid`);
      assert.equal(job.rows.length, 1);
      let reports = 0, reportError = false;
      const forbidden = async () => { outbound++; throw new Error("Unexpected preview outbound"); };
      const summary = load("./modules/notification/notification.service.ts", {
        "./delivery.service": { notificationIdentity: () => "synthetic-summary-identity", sendDurableText: forbidden },
        "../../config/env": { env: { publicOrigin: "https://example.invalid" } },
        "../../config/lineGroups": { lineGroups: { itGroupId: "synthetic-it", xieTongGroupId: "synthetic-xie" } },
      });
      const worker = load("./modules/weeklyPush/weeklyPush.worker.ts", {
        "../../infra/queue/boss": {}, "../../infra/queue/queues": { queues },
        "../../infra/healthchecks/healthchecks.client": { pingStart: forbidden, pingSuccess: forbidden, pingFail: forbidden },
        "../notification/delivery.service": { deliverSavedRecipient: forbidden },
        "../notification/notification.service": summary,
        "./weeklyPush.repository": { weeklyPushRepo },
        "./weeklyPush.report": { generateAndStoreReport: async () => { reports++; if (reportError) throw new Error("synthetic-report-failure"); } },
      });
      const jobs = [{ name: queues.weeklyPush, data: { runId: result.run.id, recipientId: recipient.id } }];
      await worker.handleWeeklyPushJob(jobs);
      assert.equal((await weeklyPushRepo.getRunById(result.run.id))?.status, "success");
      reportError = true;
      await assert.rejects(worker.handleWeeklyPushJob(jobs), /synthetic-report-failure/);
      await assert.rejects(worker.handleRecipientJob(jobs), /synthetic-report-failure/);
      await summary.pushRunSummary({ run: await weeklyPushRepo.getRunById(result.run.id), recipients: [recipient] });
      const current = await weeklyPushRepo.getRecipientById(recipient.id);
      assert.equal(current?.status, "skipped"); assert.equal(current?.lineRetryKey, savedKey);
      assert.deepEqual(current?.payloadJson, savedPayload); assert.equal(reports, 3); assert.equal(outbound, 0);
    }));
  } finally {
    storage.getApprovedCoachUsers = originalApproved;
    storage.getSchedulesByDateRange = originalSchedules;
    globalThis.fetch = originalFetch;
    context.setBaseDbForTest(null);
    setQueueProducerForTest(null);
    await pool.end();
  }
});
