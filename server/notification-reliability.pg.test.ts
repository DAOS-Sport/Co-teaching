import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

test("N3 real PostgreSQL atomic jobs, claims, and accepted-before-mark crash", async t => {
  const url = process.env.N3_TEST_DATABASE_URL;
  assert.equal(process.env.N3_TEST_ALLOW_ISOLATED_PG, "1", "Explicit isolated PostgreSQL opt-in is required");
  assert.ok(url, "N3_TEST_DATABASE_URL is required; no environment-file fallback exists");
  const target = new URL(url);
  assert.equal(target.hostname, "127.0.0.1");
  assert.match(target.pathname, /^\/ct_ca3_[a-zA-Z0-9_]+$/);
  assert.ok(target.port && target.port !== "5432", "A task-owned random port is required");
  process.env.DATABASE_URL = url;
  process.env.ENABLE_WEEKLY_PUSH_QUEUE = "1";
  const require = createRequire(import.meta.url);
  const { Pool } = require("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { eq , inArray} = await import("drizzle-orm");
  const schema = await import("../shared/schema");
  const pool = new Pool({ connectionString: url, max: 4 });
  const context = await import("./shared/dbContext");
  const { default: PgBoss } = await import("pg-boss");
  const producer = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, migrate: false, supervise: false, schedule: false });
  const { setQueueProducerForTest } = await import("./infra/queue/boss");
  const { weeklyPushRepo } = await import("./modules/weeklyPush/weeklyPush.repository");
  const { notificationDeliveryStore } = await import("./modules/notification/delivery.repository");
  const { deliverNotification } = await import("./core/notifications/delivery");
  const { createLinePushAdapter } = await import("./modules/notification/lineNotify.adapter");
  const db = drizzle(pool, { schema });
  context.setBaseDbForTest(db);
  setQueueProducerForTest(producer);
  const bundle = (id: string, queue = "notification-delivery") => weeklyPushRepo.createRunBundle({
    id, pushType: "notification", weekStartDate: "2030-01-07", weekEndDate: "2030-01-13", triggerSource: "manual",
    destination: `fixture:${id}`, idempotencyKey: `n3:${id}`, status: "queued", dryRun: false,
  }, [{ id: randomUUID(), runId: id, recipientType: "notification", recipientName: "fixture", lineUserId: "fixture-recipient",
    status: "pending", deliveryKey: `n3:${id}`, lineRetryKey: randomUUID(), payloadJson: { message: "fixture-message" },
  }], queue);
  try {
    await t.test("outer business write, run, recipients and real pg-boss job rollback together", async () => {
      const id = randomUUID();
      const key = `n3-business:${id}`;
      await assert.rejects(context.inTransaction(async () => {
        await context.currentDb().insert(schema.systemSettings).values({ key, value: "fixture" });
        await bundle(id);
        const inside = await context.currentDb().select().from(schema.weeklyPushRecipients).where(eq(schema.weeklyPushRecipients.runId, id));
        assert.equal(inside.length, 1);
        throw new Error("fixture rollback");
      }), /fixture rollback/);
      assert.equal((await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key))).length, 0);
      assert.equal(await weeklyPushRepo.getRunById(id), null);
      assert.equal((await weeklyPushRepo.listRecipientsByRun(id)).length, 0);
      assert.equal((await pool.query("SELECT id FROM pgboss.job WHERE id=$1", [id])).rowCount, 0);
    });
    await t.test("missing queue fails closed and commits none of the bundle", async () => {
      const id = randomUUID();
      await assert.rejects(bundle(id, `missing-${id}`), /queue is unavailable/);
      assert.equal(await weeklyPushRepo.getRunById(id), null);
      assert.equal((await weeklyPushRepo.listRecipientsByRun(id)).length, 0);
    });
    await t.test("commit, repeat enqueue, parallel claim and crash preserve the original request", async () => {
      const id = randomUUID();
      assert.equal((await bundle(id)).created, true);
      assert.equal((await bundle(id)).created, false);
      assert.equal((await pool.query("SELECT id FROM pgboss.job WHERE id=$1", [id])).rowCount, 1);
      const [recipient] = await weeklyPushRepo.listRecipientsByRun(id);
      const now = Date.now();
      const claims = await Promise.all([notificationDeliveryStore.claim(recipient.id, now), notificationDeliveryStore.claim(recipient.id, now)]);
      const claim = claims.find(Boolean)!;
      assert.equal(claims.filter(Boolean).length, 1);
      let clock = now + 30_001;
      let accepted = false;
      const requests: string[] = [];
      const adapter = createLinePushAdapter({ token: "fixture-token", fetch: async (_url, init) => {
        requests.push(JSON.stringify([new Headers(init?.headers).get("X-Line-Retry-Key"), init?.body]));
        if (accepted) return new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "fixture-receipt" } });
        accepted = true; return new Response("{}", { status: 200 });
      } });
      let crash = true;
      const store = { claim: notificationDeliveryStore.claim, async complete(...args: Parameters<typeof notificationDeliveryStore.complete>) {
        if (crash) { crash = false; throw new Error("fixture accepted crash"); }
        return notificationDeliveryStore.complete(...args);
      } };
      const deps = { store, now: () => clock, send: (fixed: typeof claim.fixed) => adapter(fixed.to, fixed.text, fixed.retryKey) };
      await assert.rejects(deliverNotification(recipient.id, deps), /fixture accepted crash/);
      clock += 30_001;
      assert.equal((await deliverNotification(recipient.id, deps)).state, "accepted");
      assert.equal(requests.length, 2);
      assert.equal(requests[0], requests[1]);
      assert.equal((await weeklyPushRepo.getRecipientById(recipient.id))?.status, "accepted");
      assert.equal((await deliverNotification(recipient.id, deps)).state, "unclaimed");
      await assert.rejects(notificationDeliveryStore.complete(claim, { state: "failed", nextRetryAt: null,
        result: { outcome: "rejected", status: 400, errorCode: "fixture", errorMessage: "fixture" } }, clock), /superseded/);
    });

    await t.test("same-day generic identities each persist run recipient and job; replay is immutable", async () => {
      const { enqueueTextNotification } = await import("./modules/notification/delivery.service");
      const suffix = randomUUID();
      const input = { notificationId: `r11-first-${suffix}`, to: "synthetic-first-destination", text: "synthetic-first-body" };
      const first = await enqueueTextNotification(input);
      const firstRecipient = await weeklyPushRepo.getRecipientById(first.notificationId);
      assert.ok(firstRecipient);
      const firstKey = firstRecipient.lineRetryKey;
      const firstPayload = firstRecipient.payloadJson;
      const second = await enqueueTextNotification({ notificationId: `r11-second-${suffix}`, to: "synthetic-second-destination", text: "synthetic-second-body" });
      assert.notEqual(first.runId, second.runId);
      assert.notEqual(first.notificationId, second.notificationId);
      const runIds = [first.runId, second.runId];
      const rows = await db.select().from(schema.weeklyPushRuns).where(inArray(schema.weeklyPushRuns.id, runIds));
      assert.equal(rows.length, 2);
      assert.equal(rows[0].weekStartDate, rows[1].weekStartDate, "both generic operations are for the same day");
      assert.equal(new Set(rows.map(row => row.destination)).size, 2, "delivery tuple partitions distinct notification identities");
      assert.equal((await db.select().from(schema.weeklyPushRecipients).where(inArray(schema.weeklyPushRecipients.runId, runIds))).length, 2);
      const jobs = await pool.query("SELECT id, data FROM pgboss.job WHERE id = ANY($1::uuid[])", [runIds]);
      assert.equal(jobs.rowCount, 2);
      assert.deepEqual(jobs.rows.map(row => row.data.runId).sort(), [...runIds].sort());

      const replay = await enqueueTextNotification(input);
      assert.equal(replay.reused, true);
      assert.equal(replay.runId, first.runId);
      assert.equal(replay.notificationId, first.notificationId);
      await assert.rejects(enqueueTextNotification({ ...input, text: "changed-body" }));
      await assert.rejects(enqueueTextNotification({ ...input, to: "changed-destination", reuseSavedPayload: true }));
      const validAfterRejectedChanges = await enqueueTextNotification(input);
      assert.equal(validAfterRejectedChanges.runId, first.runId, "valid replay remains healthy after both mutation rejections");

      // Persist the first operation as yesterday's record, then enqueue the same identity today.
      const originalDay = rows.find(row => row.id === first.runId)!.weekStartDate;
      const priorDay = new Date(`${originalDay}T00:00:00.000Z`);
      priorDay.setUTCDate(priorDay.getUTCDate() - 1);
      const yesterday = priorDay.toISOString().slice(0, 10);
      await db.update(schema.weeklyPushRuns).set({ weekStartDate: yesterday, weekEndDate: yesterday }).where(eq(schema.weeklyPushRuns.id, first.runId));
      const nextDayReplay = await enqueueTextNotification(input);
      assert.equal(nextDayReplay.reused, true);
      assert.equal(nextDayReplay.runId, first.runId);
      assert.equal(nextDayReplay.notificationId, first.notificationId);
      assert.equal((await weeklyPushRepo.getRunById(first.runId))?.weekStartDate, yesterday, "same identity retains the first run's persisted day");
      const after = await weeklyPushRepo.getRecipientById(first.notificationId);
      assert.equal(after?.lineRetryKey, firstKey);
      assert.deepEqual(after?.payloadJson, firstPayload);
      assert.equal((await db.select().from(schema.weeklyPushRuns).where(inArray(schema.weeklyPushRuns.id, runIds))).length, 2);
      assert.equal((await db.select().from(schema.weeklyPushRecipients).where(inArray(schema.weeklyPushRecipients.runId, runIds))).length, 2);
      assert.equal((await pool.query("SELECT id FROM pgboss.job WHERE id = ANY($1::uuid[])", [runIds])).rowCount, 2);
    });
  } finally {
    setQueueProducerForTest(null);
    await pool.end();
  }
});
