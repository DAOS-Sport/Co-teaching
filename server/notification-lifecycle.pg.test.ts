import test from "node:test";
import assert from "node:assert/strict";
const target = process.env.N3_TEST_DATABASE_URL;
if (!target || process.env.N3_TEST_ALLOW_ISOLATED_PG !== "1" || !/^\/ct_ca3_[a-z0-9_]+$/.test(new URL(target).pathname) || new URL(target).hostname !== "127.0.0.1" || new URL(target).port === "5432") throw new Error("Explicit isolated PostgreSQL target required");
process.env.DATABASE_URL = target; process.env.ENABLE_WEEKLY_PUSH_QUEUE = "1"; process.env.ENABLE_WEEKLY_PUSH_WORKER = "1";

test("single explicit pg-boss runtime: concurrent start, schedule, disable and restore", { timeout: 40_000 }, async () => {
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("No external delivery in lifecycle test"); };
  const { startNotificationRuntime, configureNotificationSchedules, stopNotificationSchedules, restoreNotificationSchedules } = await import("./infra/queue/runtime");
  const { getBoss, stopBoss } = await import("./infra/queue/boss");
  try {
    const started = await Promise.all([startNotificationRuntime(), startNotificationRuntime()]);
    assert.ok(started.every(x => x.workersReady && !x.schedulesRequested));
    const boss = getBoss(), before = await boss.getSchedules();
    const installed = await configureNotificationSchedules({ enabled: true });
    await configureNotificationSchedules({ enabled: true });
    const active = await boss.getSchedules();
    const names = active.filter(s => !before.some(b => b.name === s.name)).map(s => s.name);
    assert.equal(new Set(active.map(s => s.name)).size, active.length, "No duplicate trigger names");
    assert.equal(names.length, 4);
    const weeklyDisabled = await configureNotificationSchedules({ enabled: false, kinds: ["weekly"] });
    const unrelatedBefore = (await boss.getSchedules()).filter(s => !weeklyDisabled.previous.some(p => p.name === s.name));
    const emptyWeekly = await configureNotificationSchedules({ enabled: false, kinds: ["weekly"] });
    assert.equal(emptyWeekly.previous.length, 0);
    await restoreNotificationSchedules(emptyWeekly);
    assert.deepEqual((await boss.getSchedules()).map(s => s.name).sort(), unrelatedBefore.map(s => s.name).sort());
    await restoreNotificationSchedules(weeklyDisabled);
    assert.deepEqual((await boss.getSchedules()).map(s => s.name).sort(), active.map(s => s.name).sort());
    await stopNotificationSchedules();
    assert.equal((await boss.getSchedules()).filter(s => names.includes(s.name)).length, 0);
    await restoreNotificationSchedules({ previous: active, kinds: installed.kinds });
    const restored = await boss.getSchedules();
    assert.deepEqual(restored.map(s => [s.name, s.cron, s.options]).sort(), active.map(s => [s.name, s.cron, s.options]).sort());
    await restoreNotificationSchedules(installed);
    assert.deepEqual((await boss.getSchedules()).map(s => s.name).sort(), before.map(s => s.name).sort());
    assert.equal(outbound, 0);
  } finally { await stopBoss(); globalThis.fetch = originalFetch; }
});
