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
  const { eq } = await import("drizzle-orm");
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
    destination: "fixture", idempotencyKey: `n3:${id}`, status: "queued", dryRun: false,
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
  } finally {
    setQueueProducerForTest(null);
    await pool.end();
  }
});
