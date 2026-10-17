import { env } from "../../config/env";
import { getBoss, stopBoss } from "./boss";
import { queues } from "./queues";
import { startWeeklyPushWorkers, handleWeeklyPushJob } from "../../modules/weeklyPush/weeklyPush.worker";
import { enqueueWeeklyPush } from "../../modules/weeklyPush/weeklyPush.service";
import { weeklyPushRepo } from "../../modules/weeklyPush/weeklyPush.repository";
import { reconcileWeeklyPushRun } from "../../modules/weeklyPush/weeklyPush.reconcile";
import { cleanupOldReports } from "../../modules/weeklyPush/weeklyPush.cleanup";
import { dispatchWeeklyPushOutbox } from "../../modules/weeklyPush/weeklyPush.outbox";
import type PgBoss from "pg-boss";

type ScheduleKind = "weekly" | "daily" | "reconcile" | "cleanup";
const scheduleNames = { weekly: queues.notificationWeeklyTrigger, daily: queues.notificationDailyTrigger,
  reconcile: queues.notificationReconcile, cleanup: queues.notificationCleanup } as const;
let registeredBoss: PgBoss | null = null;
let registrationPromise: Promise<void> | null = null;

/** Explicit maintenance/worker entry. Importing this module or booting HTTP never calls it. */
export async function startNotificationRuntime(options: { schedules?: boolean } = {}) {
  await startWeeklyPushWorkers();
  const boss = getBoss();
  if (registeredBoss !== boss) {
    if (!registrationPromise) registrationPromise = (async () => {
    try {
    for (const name of [queues.notificationDelivery, ...Object.values(scheduleNames)]) await boss.createQueue(name);
    await boss.work<{ runId: string }>(queues.notificationDelivery, { batchSize: 1 }, handleWeeklyPushJob);
    await boss.work(queues.notificationWeeklyTrigger, async () => { await enqueueWeeklyPush({ triggerSource: "cron" }); });
    await boss.work(queues.notificationDailyTrigger, async () => { const { sendDailyTomorrowNotifications } = await import("../../line-notify"); await sendDailyTomorrowNotifications(); });
    await boss.work(queues.notificationReconcile, async () => {
      await dispatchWeeklyPushOutbox();
      for (const run of await weeklyPushRepo.listRunsByStatuses(["queued", "preparing", "sending", "unknown", "failed"])) await reconcileWeeklyPushRun(run.id);
    });
    await boss.work(queues.notificationCleanup, async () => { await cleanupOldReports(); });
    registeredBoss = boss;
    } catch (error) { registeredBoss = null; await stopBoss(); throw error; }
    })();
    try { await registrationPromise; } finally { registrationPromise = null; }
  }
  if (options.schedules === true) await configureNotificationSchedules({ enabled: true });
  return { workersReady: true, schedulesRequested: options.schedules === true };
}

/** A reversible, explicit schedule mutation; no call is made by app boot. */
export type NotificationScheduleSnapshot = { previous: Awaited<ReturnType<PgBoss["getSchedules"]>>; kinds: ScheduleKind[] };
function validateScheduleKinds(kinds: ScheduleKind[]): ScheduleKind[] {
  if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length || kinds.some(kind => !Object.prototype.hasOwnProperty.call(scheduleNames, kind))) {
    throw new Error("notification_schedule_scope_invalid");
  }
  return [...kinds];
}
export async function configureNotificationSchedules(options: { enabled: boolean; weeklyCron?: string; timezone?: string; kinds?: ScheduleKind[] }, boss: Pick<PgBoss, "getSchedules" | "schedule" | "unschedule"> = getBoss()) {
  const kinds = validateScheduleKinds(options.kinds ?? ["weekly", "daily", "reconcile", "cleanup"]);
  const previous = (await boss.getSchedules()).filter(item => kinds.some(kind => scheduleNames[kind] === item.name));
  const specs = {
    weekly: { cron: options.weeklyCron ?? env.weeklyPushCron, tz: options.timezone ?? env.weeklyPushTimezone },
    daily: { cron: "0 19 * * *", tz: "Asia/Taipei" },
    reconcile: { cron: "*/5 * * * *", tz: "Asia/Taipei" },
    cleanup: { cron: "30 3 * * *", tz: "Asia/Taipei" },
  };
  for (const kind of kinds) {
    if (options.enabled) await boss.schedule(scheduleNames[kind], specs[kind].cron, {}, { tz: specs[kind].tz });
    else await boss.unschedule(scheduleNames[kind]);
  }
  return { previous, enabled: options.enabled, kinds };
}
export async function stopNotificationSchedules() { return configureNotificationSchedules({ enabled: false }); }
export async function restoreNotificationSchedules(snapshot: NotificationScheduleSnapshot, boss: PgBoss = getBoss()) {
  if (!snapshot || Array.isArray(snapshot) || !Array.isArray(snapshot.previous)) throw new Error("notification_schedule_snapshot_invalid");
  const kinds = validateScheduleKinds(snapshot.kinds);
  const names = new Set<string>(kinds.map(kind => scheduleNames[kind]));
  if (snapshot.previous.some(item => !item || !names.has(item.name)) || new Set(snapshot.previous.map(item => item.name)).size !== snapshot.previous.length) {
    throw new Error("notification_schedule_snapshot_outside_scope");
  }
  await configureNotificationSchedules({ enabled: false, kinds }, boss);
  for (const item of snapshot.previous) await boss.schedule(item.name, item.cron, item.data, item.options);
}
export function resetNotificationRuntimeForTest() { registeredBoss = null; }
