import { validate } from "node-cron";
/** The opt-in entry validates before loading HTTP or workers. */
export function notificationEntryConfig(environment: Record<string, string | undefined>) {
  const on = (value: string | undefined) => ["1", "true", "on", "yes"].includes(value?.toLowerCase().trim() ?? "");
  if (environment.NOTIFICATION_RUNTIME_MODE !== "always-on" || !on(environment.ENABLE_WEEKLY_PUSH_QUEUE) || !on(environment.ENABLE_WEEKLY_PUSH_WORKER) || ["0", "false", "off", "no"].includes(environment.ENABLE_LINE_NOTIFY?.toLowerCase().trim() ?? "")) throw Error("NOTIFICATION_EXPLICIT_RUNTIME_REQUIRED");
  const weeklyCron = environment.WEEKLY_PUSH_CRON || "0 12 * * 0", timezone = environment.WEEKLY_PUSH_TIMEZONE || "Asia/Taipei";
  if (!validate(weeklyCron)) throw Error("NOTIFICATION_CRON_INVALID");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw Error("NOTIFICATION_TIMEZONE_INVALID"); }
  return { weeklyCron, timezone };
}
type ScheduleOptions = ReturnType<typeof notificationEntryConfig> & { enabled: true; kinds: ("weekly" | "daily" | "reconcile")[] };
type Dependencies<Snapshot> = {
  preflight(): Promise<void>; startWeb(): Promise<unknown>; stopWeb(): Promise<unknown>;
  startWorkers(): Promise<unknown>; stopWorkers(): Promise<unknown>;
  captureSchedules(): Promise<Snapshot>; configureSchedules(options: ScheduleOptions): Promise<unknown>; restoreSchedules(snapshot: Snapshot): Promise<unknown>;
};
export async function startNotificationApplication<Snapshot>(config: ReturnType<typeof notificationEntryConfig>, dependencies: Dependencies<Snapshot>, signal?: AbortSignal) {
  const checkAbort = () => { if (signal?.aborted) throw Error("NOTIFICATION_START_ABORTED"); };
  checkAbort();
  await dependencies.preflight();
  checkAbort();
  let web = false, workers = false, snapshot: Snapshot | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    // Drain workers before closing HTTP. Persist definitions across an ordinary restart.
    try { if (workers) await dependencies.stopWorkers(); }
    finally { if (web) await dependencies.stopWeb(); }
  })();
  try {
    web = true; await dependencies.startWeb();
    checkAbort();
    workers = true; await dependencies.startWorkers();
    checkAbort();
    snapshot = await dependencies.captureSchedules();
    checkAbort();
    await dependencies.configureSchedules({ ...config, enabled: true, kinds: ["weekly", "daily", "reconcile"] });
    checkAbort();
    return { stop };
  } catch (error) {
    const failures = [error];
    if (snapshot !== undefined) { try { await dependencies.restoreSchedules(snapshot); } catch (restoreError) { failures.push(restoreError); } }
    try { await stop(); } catch (stopError) { failures.push(stopError); }
    if (failures.length > 1) throw new AggregateError(failures, "NOTIFICATION_START_ROLLBACK_FAILED");
    throw error;
  }
}
