/**
 * Weekly-push business logic (Task #23).
 *
 * Responsibilities:
 *   - Compute the target week range (default = next Mon..Sun in TST).
 *   - Build the recipient roster from approved coaches with LINE.
 *   - Enforce idempotency on (pushType, weekStart, weekEnd).
 *   - Format the LINE message body for one coach (kept here so the
 *     legacy `server/line-notify.ts` does not need to be rewritten).
 *   - Enqueue the orchestrator job onto pg-boss.
 *
 * The service is queue-aware but DB access goes through the
 * repository; the routes never touch either layer directly.
 */
import { addDays, format, startOfWeek } from "date-fns";
import { randomUUID } from "node:crypto";
import { zhTW } from "date-fns/locale";
import { storage } from "../../storage";
import { env } from "../../config/env";
import { getBoss } from "../../infra/queue/boss";
import { queues } from "../../infra/queue/queues";
import { weeklyPushRepo } from "./weeklyPush.repository";
import type {
  WeeklyPushTriggerSource,
  WeeklyPushJobData,
  WeeklyPushRecipientJobData,
} from "./types";
import type {
  WeeklyPushRun,
  WeeklyPushRecipient,
  InsertWeeklyPushRecipient,
} from "@shared/schema";

const PUSH_TYPE = "weekly";
const DAY_NAMES = ["", "一", "二", "三", "四", "五", "六", "日"];

interface ScheduleItem {
  date: string;
  venueName: string;
  timeSlotLabel: string;
  className: string | null;
  timeSlotOrder: number;
}

/**
 * Returns the Mon..Sun range for the target week.
 * Uses the same heuristic as the legacy weekly cron: shift by +1 day
 * before computing `startOfWeek` so a Sunday cron tick targets the
 * upcoming week, while a Mon..Sat manual trigger targets the current.
 */
export function computeDefaultWeekRange(now: Date = new Date()): {
  weekStartDate: string;
  weekEndDate: string;
} {
  const monday = startOfWeek(addDays(now, 1), { weekStartsOn: 1 });
  const sunday = addDays(monday, 6);
  return {
    weekStartDate: format(monday, "yyyy-MM-dd"),
    weekEndDate: format(sunday, "yyyy-MM-dd"),
  };
}

/**
 * Builds the per-coach message body. Format intentionally mirrors the
 * legacy `sendWeeklyScheduleNotifications` output so coaches see the
 * same notification when the queue takes over.
 */
export function buildCoachWeeklyMessage(
  coachName: string,
  schedules: ScheduleItem[],
  weekStartDate: string,
  weekEndDate: string,
): string {
  const monday = new Date(`${weekStartDate}T00:00:00`);
  const sunday = new Date(`${weekEndDate}T00:00:00`);

  const byDay = new Map<string, ScheduleItem[]>();
  for (const s of schedules) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date)!.push(s);
  }
  const sortedDates = Array.from(byDay.keys()).sort();

  let msg = "📋 下週課程通知\n";
  msg += `${format(monday, "M/d", { locale: zhTW })}(一) ~ ${format(sunday, "M/d", { locale: zhTW })}(日)\n\n`;
  msg += `${coachName} 老師，您好!\n`;
  msg += `您下週共有 ${schedules.length} 堂課:\n`;

  for (const dateKey of sortedDates) {
    const d = new Date(`${dateKey}T00:00:00`);
    const dow = d.getDay();
    const dayName = DAY_NAMES[dow === 0 ? 7 : dow];
    msg += `\n📅 ${format(d, "M/d")}(${dayName})\n`;

    const items = byDay
      .get(dateKey)!
      .sort((a, b) => a.timeSlotOrder - b.timeSlotOrder);
    for (const item of items) {
      msg += `  🏊 ${item.venueName}\n`;
      msg += `  ⏰ ${item.timeSlotLabel}`;
      if (item.className) msg += ` - ${item.className}`;
      msg += "\n";
    }
  }

  msg += "\n---\n請教練務必於課前準時抵達場館,主動向授課老師致意,並請確實熟悉「教練守則」。\n\n";
  msg += "自本學期起,協同課程費用修正如下:\n• 單節課 250元\n• 兩節課合併 500元";
  msg += `\n\n📌 課表如有異動請以系統為主：\n${env.publicOrigin}/coach-portal`;
  return msg;
}

interface BuiltRecipient {
  recipientName: string;
  recipientId: string | null;
  lineUserId: string | null;
  scheduleCount: number;
  payload: { message: string; scheduleCount: number };
}

/**
 * Compute the roster for a week: every approved coach with a LINE
 * binding who has at least one schedule in the target window.
 * Coaches without LINE or without classes are intentionally excluded
 * (they would have nothing to notify).
 */
export async function buildRecipientsForWeek(
  weekStartDate: string,
  weekEndDate: string,
): Promise<BuiltRecipient[]> {
  const approved = await storage.getApprovedCoachUsers();
  const coachesWithLine = approved.filter(
    (c) => c.lineId && (c.linkedCoachName || c.name),
  );
  if (coachesWithLine.length === 0) return [];

  const weekSchedules = await storage.getSchedulesByDateRange(
    weekStartDate,
    weekEndDate,
  );

  const out: BuiltRecipient[] = [];
  for (const coach of coachesWithLine) {
    const coachName = (coach.linkedCoachName || coach.name)!;
    const mine = weekSchedules.filter(
      (s) => s.coachName === coachName || s.coachName2 === coachName,
    );
    if (mine.length === 0) continue;

    const items: ScheduleItem[] = mine.map((s) => ({
      date: s.date,
      venueName: s.venue.name,
      timeSlotLabel: `${s.timeSlot.startTime}-${s.timeSlot.endTime}`,
      className: s.className,
      timeSlotOrder: s.timeSlot.order,
    }));

    const message = buildCoachWeeklyMessage(
      coachName,
      items,
      weekStartDate,
      weekEndDate,
    );

    out.push({
      recipientName: coachName,
      recipientId: coach.id,
      lineUserId: coach.lineId!,
      scheduleCount: mine.length,
      payload: { message, scheduleCount: mine.length },
    });
  }
  return out;
}

interface EnqueueParams {
  weekStartDate?: string;
  weekEndDate?: string;
  dryRun?: boolean;
  triggerSource?: WeeklyPushTriggerSource;
}

interface EnqueueResult {
  run: WeeklyPushRun;
  reused: boolean;
  recipientsCreated: number;
}

/**
 * Idempotent entry-point for both the cron schedule and the manual
 * admin endpoint. Creates a run, populates recipients, enqueues the
 * orchestrator job — or returns the existing run if a non-failed run
 * for the same week already exists.
 */
export async function enqueueWeeklyPush(
  params: EnqueueParams = {},
): Promise<EnqueueResult> {
  const { weekStartDate, weekEndDate } =
    params.weekStartDate && params.weekEndDate
      ? {
          weekStartDate: params.weekStartDate,
          weekEndDate: params.weekEndDate,
        }
      : computeDefaultWeekRange();

  const dryRun = params.dryRun === true;
  const triggerSource: WeeklyPushTriggerSource =
    params.triggerSource ?? "manual";
  const destination = "coaches";
  const idempotencyKey = `${dryRun ? "weekly-preview" : "weekly-send"}:${weekStartDate}:${destination}`;

  const existing = await weeklyPushRepo.getRunByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { run: existing, reused: true, recipientsCreated: 0 };
  }

  const runId = randomUUID();
  const built = await buildRecipientsForWeek(weekStartDate, weekEndDate);
  const recipientRows: InsertWeeklyPushRecipient[] = built.map((b) => ({
    runId,
    recipientType: "coach",
    recipientId: b.recipientId,
    recipientName: b.recipientName,
    lineUserId: b.lineUserId,
    status: dryRun ? "skipped" : "pending",
    deliveryKey: `${dryRun ? "weekly-preview" : "weekly"}:${weekStartDate}:${b.recipientId ?? b.lineUserId}`,
    lineRetryKey: randomUUID(),
    payloadJson: { ...b.payload, messageVersion: 1, capturedAt: new Date().toISOString() },
  }));

  const bundle = await weeklyPushRepo.createRunBundle({
    id: runId,
    pushType: PUSH_TYPE,
    weekStartDate,
    weekEndDate,
    triggerSource,
    destination,
    idempotencyKey,
    status: "queued",
    dryRun,
    totalCount: 0,
  }, recipientRows, queues.weeklyPush);

  if (bundle.created) {
    const { dispatchWeeklyPushOutbox } = await import("./weeklyPush.outbox");
    await dispatchWeeklyPushOutbox();
  }
  return {
    run: bundle.run,
    reused: !bundle.created,
    recipientsCreated: bundle.recipientsCreated,
  };
}

/**
 * Re-runs only the failed recipients of a previous run by creating a
 * brand-new run row (so history is preserved) and enqueueing per-recipient
 * jobs for each failed entry. Successful recipients are NOT re-pushed.
 */
export async function retryFailedRecipients(
  sourceRunId: string,
): Promise<EnqueueResult> {
  const source = await weeklyPushRepo.getRunById(sourceRunId);
  if (!source) throw new Error(`run ${sourceRunId} not found`);

  const failed = await weeklyPushRepo.listRecipientsByRunAndStatus(
    sourceRunId,
    "failed",
  );
  if (failed.length === 0) {
    throw new Error("no failed recipients to retry");
  }

  for (const recipient of failed) {
    await weeklyPushRepo.updateRecipient(recipient.id, {
      status: "pending",
      completedAt: null,
      nextRetryAt: null,
      errorCode: null,
      errorMessage: null,
    });
    await enqueueRecipientJob(source.id, recipient.id, true);
  }
  await weeklyPushRepo.updateRun(source.id, {
    status: "sending",
    completedAt: undefined,
    errorMessage: null,
  });
  return { run: (await weeklyPushRepo.getRunById(source.id))!, reused: true, recipientsCreated: failed.length };
}

/**
 * Per-recipient retry policy — three retries with 60s backoff
 * doubling per attempt, so the worst case is roughly
 * 60 + 120 + 240 = 7 minutes before a recipient lands in `failed`.
 * Centralized here so `enqueueRecipientJob` and the orchestrator's
 * timeout stay in agreement.
 */
export const RECIPIENT_RETRY_LIMIT = 3;
export const RECIPIENT_RETRY_DELAY_SECONDS = 60;

/**
 * Enqueue a per-recipient send job. Wet-run only — dry-run paths
 * never reach this function because the orchestrator sets all
 * recipients to `skipped` up-front.
 *
 * Retry options are attached on the publish so transient LINE/API
 * failures are auto-retried by pg-boss without intervention. The
 * worker handler treats `retrycount === RETRY_LIMIT` as the final
 * attempt and stops throwing.
 */
export async function enqueueRecipientJob(
  runId: string,
  recipientId: string,
  manualRetry = false,
): Promise<void> {
  const boss = getBoss();
  const data: WeeklyPushRecipientJobData = { runId, recipientId };
  await boss.send(queues.weeklyPushRecipient, data, {
    singletonKey: `${runId}:${recipientId}:${manualRetry ? randomUUID() : "initial"}`,
    retryLimit: RECIPIENT_RETRY_LIMIT,
    retryDelay: RECIPIENT_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  });
}

/** Convenience used by the worker when it needs to fan out. */
export function expectedRecipientsToSend(
  recipients: WeeklyPushRecipient[],
): WeeklyPushRecipient[] {
  return recipients.filter((r) => r.status === "pending");
}
