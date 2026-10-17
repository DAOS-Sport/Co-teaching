import { notificationEntryConfig, startNotificationApplication } from "./infra/queue/application";
import { assertNotificationSchema } from "./infra/queue/preflight";
import type { Server } from "node:http";
import type { NotificationScheduleSnapshot } from "./infra/queue/runtime";

// Kept out of normal npm start/dev. Selecting this entry requires an approved
// always-on deployment; it cannot wake an Autoscale server that has stopped.
const shutdown = new AbortController();
let starting: Promise<{ stop(): Promise<void> }> | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  const deadline = setTimeout(() => process.exit(1), 35_000); deadline.unref();
  void (async () => { try { await (await starting)?.stop(); process.exit(0); } catch { process.exit(1); } })();
});
void (async () => { try {
  const config = notificationEntryConfig(process.env);
  const { pool } = await import("./db");
  let server: Server | undefined;
  let ragicSchedule: ReturnType<typeof import("./ragic")["startRagicDailySchedule"]> | undefined;
  let runtime: typeof import("./infra/queue/runtime") | undefined;
  starting = startNotificationApplication<NotificationScheduleSnapshot>(config, {
    preflight: async () => {
      const connection = await pool.connect();
      try { await assertNotificationSchema(connection); } finally { connection.release(); }
    },
    startWeb: async () => {
      server = await (await import("./index")).webServerReady;
      if ((await import("./config/featureFlags")).featureFlags.enableRagicSync) ragicSchedule = (await import("./ragic")).startRagicDailySchedule();
    },
    stopWeb: async () => {
      await ragicSchedule?.destroy();
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await pool.end();
    },
    startWorkers: async () => { runtime = await import("./infra/queue/runtime"); await runtime.startNotificationRuntime({ schedules: false }); },
    stopWorkers: async () => { await (await import("./infra/queue/boss")).stopBoss(); },
    captureSchedules: async () => {
      const { getBoss } = await import("./infra/queue/boss");
      const kinds = ["weekly", "daily", "reconcile"] as const;
      const names = ["notification-weekly-trigger", "notification-daily-trigger", "notification-reconcile"];
      return { previous: (await getBoss().getSchedules()).filter(s => names.includes(s.name)), kinds: [...kinds] };
    },
    configureSchedules: options => runtime!.configureNotificationSchedules(options),
    restoreSchedules: snapshot => runtime!.restoreNotificationSchedules(snapshot),
  }, shutdown.signal);
  await starting;
  console.log("[notification-runtime] workers and three persistent schedules ready");
} catch (error) {
  // Driver errors may include connection strings or payloads. Keep stderr safe.
  const code = error instanceof Error && /^NOTIFICATION_[A-Z_]+$/.test(error.message) ? error.message : "NOTIFICATION_START_FAILED";
  console.error(`[notification-runtime] ${code}; no implicit schema repair`);
  process.exit(1);
} })();
