import test from "node:test";
import assert from "node:assert/strict";
import { deliverNotification, deliveryCompletion, RETRY_WINDOW_MS, type DeliveryStore, type DeliveryRecord, type DeliveryCompletion, type FixedDelivery } from "./core/notifications/delivery";

process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/notification_fixture";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "fixture-token";

test("LINE accepted retry keeps its identity and reports platform acceptance", async () => {
  const { sendTextMessage } = await import("./modules/notification/lineNotify.adapter");
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {});
    return new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "fixture-accepted" } });
  };
  try {
    const result = await sendTextMessage("fixture-recipient", "fixture-message", "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(result.ok, true);
    assert.equal((result as { outcome?: string }).outcome, "accepted");
    assert.equal((result as { acceptedRequestId?: string }).acceptedRequestId, "fixture-accepted");
    assert.equal(new Headers(requests[0].headers).get("X-Line-Retry-Key"), "123e4567-e89b-42d3-a456-426614174000");
  } finally {
    globalThis.fetch = original;
  }
});

const saved: FixedDelivery = { notificationId: "fixture-notification", to: "fixture-recipient", text: "fixture-message", retryKey: "123e4567-e89b-42d3-a456-426614174000" };

test("LINE classification retains unknown acceptance and never invents a retry key", async () => {
  const { createLinePushAdapter } = await import("./modules/notification/lineNotify.adapter");
  for (const [status, outcome] of [[200, "accepted"], [400, "rejected"], [409, "unknown"], [429, "rejected"], [503, "unknown"]] as const) {
    const adapter = createLinePushAdapter({ token: "fixture-token", fetch: async () => new Response("{}", { status }) });
    assert.equal((await adapter(saved.to, saved.text, saved.retryKey)).outcome, outcome);
  }
  let calls = 0;
  const invalid = createLinePushAdapter({ token: "fixture-token", fetch: async () => { calls++; return new Response("{}"); } });
  assert.equal((await invalid(saved.to, saved.text, "")).outcome, "rejected");
  assert.equal(calls, 0);
  const timeout = createLinePushAdapter({ token: "fixture-token", timeoutMs: 1, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("fixture", "AbortError")), { once: true });
  }) });
  assert.equal((await timeout(saved.to, saved.text, saved.retryKey)).outcome, "unknown");
});

function memoryStore(start = 1_000) {
  let now = start;
  let state = "pending";
  let attempt = 0;
  let first: number | null = null;
  let leaseUntil = 0;
  let next: number | null = null;
  let claim = "";
  let crash = false;
  const completions: DeliveryCompletion[] = [];
  const store: DeliveryStore = {
    async claim(id, instant) {
      if (["accepted", "failed"].includes(state) || (state === "unknown" && next === null) || instant < leaseUntil || (next !== null && instant < next)) return null;
      state = "processing"; leaseUntil = instant + 30_000; first ??= instant; claim = `claim-${++attempt}`;
      return { id, fixed: saved, attemptCount: attempt, firstAttemptAt: first, claimToken: claim };
    },
    async complete(record, completion) {
      if (crash) { crash = false; throw new Error("fixture accepted-before-mark crash"); }
      assert.equal(record.claimToken, claim);
      state = completion.state; next = completion.nextRetryAt; leaseUntil = 0; completions.push(completion);
    },
  };
  return { store, now: () => now, advance: (ms: number) => { now += ms; }, crashOnce: () => { crash = true; }, completions };
}

test("accepted-before-mark crash and duplicate use the same saved request and recover from 409", async () => {
  const { createLinePushAdapter } = await import("./modules/notification/lineNotify.adapter");
  const fixture = memoryStore();
  const requests: { key: string | null; body: unknown }[] = [];
  let platformAccepted = 0;
  const adapter = createLinePushAdapter({ token: "fixture-token", fetch: async (_url, init) => {
    requests.push({ key: new Headers(init?.headers).get("X-Line-Retry-Key"), body: init?.body });
    if (platformAccepted++) return new Response("{}", { status: 409, headers: { "x-line-accepted-request-id": "fixture-accepted" } });
    return new Response("{}", { status: 200 });
  } });
  const send = (request: FixedDelivery) => adapter(request.to, request.text, request.retryKey);
  fixture.crashOnce();
  await assert.rejects(deliverNotification(saved.notificationId, { ...fixture, send }), /accepted-before-mark/);
  assert.equal((await deliverNotification(saved.notificationId, { ...fixture, send })).state, "unclaimed");
  fixture.advance(30_001);
  assert.equal((await deliverNotification(saved.notificationId, { ...fixture, send })).state, "accepted");
  assert.equal((await deliverNotification(saved.notificationId, { ...fixture, send })).state, "unclaimed");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(fixture.completions[0].result.acceptedRequestId, "fixture-accepted");
});

test("timeout retries within the saved window; expiry and exhausted attempts remain unknown", async () => {
  const fixture = memoryStore();
  let calls = 0;
  const send = async () => { calls++; return { outcome: "unknown" as const, status: 0, errorCode: "TIMEOUT", errorMessage: "fixture" }; };
  assert.deepEqual(await deliverNotification(saved.notificationId, { ...fixture, send }), { state: "retry_wait", retry: true });
  assert.equal((await deliverNotification(saved.notificationId, { ...fixture, send })).state, "unclaimed");
  fixture.advance(RETRY_WINDOW_MS);
  assert.deepEqual(await deliverNotification(saved.notificationId, { ...fixture, send }), { state: "unknown", retry: false });
  assert.equal(calls, 1);
  const record: DeliveryRecord = { id: "fixture", fixed: saved, attemptCount: 4, firstAttemptAt: 1000, claimToken: "fixture" };
  assert.equal(deliveryCompletion(record, await send(), 2000).nextRetryAt, null);
});

test("pg-boss transaction SQL binds repeated values and preserves SQL quoted placeholders", async () => {
  const { queueTransactionDb } = await import("./infra/queue/transaction");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  let captured: { sql: string; params: unknown[] } | undefined;
  const adapter = queueTransactionDb({ async execute(query) { captured = new PgDialect().sqlToQuery(query); return { rows: [] }; } });
  await adapter.executeSql("SELECT $2, '$1', $1, $2 -- $3\n, $$ $4 $$", ["first", "second"]);
  assert.deepEqual(captured?.params, ["second", "first", "second"]);
  assert.match(captured!.sql, /'\$1'/);
  assert.match(captured!.sql, /\$\$ \$4 \$\$/);
});

test("pg-boss undefined defaults remain bound SQL NULL and job JSON remains one value", async () => {
  const { queueTransactionDb } = await import("./infra/queue/transaction");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  let captured: { sql: string; params: unknown[] } | undefined;
  const adapter = queueTransactionDb({ async execute(query) { captured = new PgDialect().sqlToQuery(query); return { rows: [] }; } });
  await adapter.executeSql("SELECT $1::int AS retry_limit, $2::jsonb AS data, $1::int AS retry_default", [undefined, { fixture: "job-payload", nested: { value: 1 } }]);
  assert.equal(captured!.sql, "SELECT $1::int AS retry_limit, $2::jsonb AS data, $3::int AS retry_default");
  assert.deepEqual(captured!.params, [null, JSON.stringify({ fixture: "job-payload", nested: { value: 1 } }), null]);
});

test("installed pg-boss producer sends only through supplied executor without starting a runtime", async () => {
  const { getQueueProducer } = await import("./infra/queue/boss");
  let statements = 0;
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const result = await getQueueProducer().send("fixture-queue", { runId: id }, { db: { async executeSql(text, values) {
    statements++;
    assert.match(text, /INSERT INTO/);
    assert.equal(values[1], "fixture-queue");
    return { rows: [{ id }] };
  } } });
  assert.equal(result, id);
  assert.equal(statements, 1);
});

test("schedule cutover captures rollback state and restores only owned schedules", async () => {
  const { configureNotificationSchedules, restoreNotificationSchedules } = await import("./infra/queue/runtime");
  const initial = { name: "notification-weekly-trigger", cron: "0 3 * * 0", data: { fixture: true }, options: { tz: "UTC" } };
  const schedules = new Map<string, typeof initial>([[initial.name, initial], ["unrelated-fixture", { ...initial, name: "unrelated-fixture" }]]);
  const fake = {
    async getSchedules() { return Array.from(schedules.values()); },
    async schedule(name: string, cron: string, data = {}, options = {}) { schedules.set(name, { name, cron, data: data as typeof initial.data, options: options as typeof initial.options }); },
    async unschedule(name: string) { schedules.delete(name); },
  };
  const changed = await configureNotificationSchedules({ enabled: true, weeklyCron: "0 4 * * 0", timezone: "UTC" }, fake);
  assert.equal(changed.previous.length, 1);
  assert.equal(schedules.size, 5);
  assert.equal(schedules.get(initial.name)?.cron, "0 4 * * 0");
  await restoreNotificationSchedules(changed, fake);
  assert.deepEqual(schedules.get(initial.name), initial);
  assert.equal(schedules.size, 2);
  assert.ok(schedules.has("unrelated-fixture"));
});
