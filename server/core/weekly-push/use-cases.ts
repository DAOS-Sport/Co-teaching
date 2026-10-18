import type { EnqueueWeeklyParams, NewWeeklyRecipient, WeeklyEnqueueResult, WeeklyRun } from './entities';
import type { WeeklyPushDependencies } from './ports';
import { buildWeeklyRecipients } from './roster';

export function createWeeklyPushUseCases<Run extends WeeklyRun>(deps: WeeklyPushDependencies<Run>) {
  const buildRecipients = (start: string, end: string) => buildWeeklyRecipients(deps, start, end);
  const enqueue = async (params: EnqueueWeeklyParams = {}): Promise<WeeklyEnqueueResult<Run>> => {
    const { weekStartDate, weekEndDate } = params.weekStartDate && params.weekEndDate
      ? { weekStartDate: params.weekStartDate, weekEndDate: params.weekEndDate } : deps.clock.defaultWeek();
    const dryRun = params.dryRun === true;
    const idempotencyKey = `${dryRun ? 'weekly-preview' : 'weekly-send'}:${weekStartDate}:coaches`;
    const existing = await deps.repository.findByKey(idempotencyKey);
    if (existing) return { run: existing, reused: true, recipientsCreated: 0 };
    if (!dryRun && await deps.repository.hasLegacyHistory(weekStartDate, weekEndDate)) {
      throw Error('weekly_push_legacy_history_blocked');
    }
    const built = await buildRecipients(weekStartDate, weekEndDate);
    const runId = deps.newId();
    const recipients: NewWeeklyRecipient[] = built.map(recipient => ({
      runId, recipientType: 'coach', recipientId: recipient.recipientId,
      recipientName: recipient.recipientName, lineUserId: recipient.lineUserId,
      status: dryRun ? 'skipped' : 'pending',
      deliveryKey: `${dryRun ? 'weekly-preview' : 'weekly'}:${weekStartDate}:${recipient.recipientId}`,
      lineRetryKey: deps.newId(),
      payloadJson: { ...recipient.payload, messageVersion: 1, capturedAt: new Date(deps.clock.now()).toISOString() },
    }));
    if (params.latestCreateAt !== undefined && (!Number.isFinite(params.latestCreateAt) || deps.clock.now() >= params.latestCreateAt)) {
      throw Error('weekly_push_slot_expired');
    }
    const bundle = await deps.repository.createBundle({ id: runId, pushType: 'weekly', weekStartDate, weekEndDate,
      triggerSource: params.triggerSource ?? 'manual', destination: 'coaches', idempotencyKey,
      status: 'queued', dryRun, totalCount: 0 }, recipients);
    if (bundle.created) await deps.queue.flushCommitted();
    return { run: bundle.run, reused: !bundle.created, recipientsCreated: bundle.recipientsCreated };
  };
  const retryFailed = (sourceRunId: string): Promise<WeeklyEnqueueResult<Run>> => deps.transaction.run(async () => {
    const source = await deps.repository.getRun(sourceRunId);
    if (!source) throw Error(`run ${sourceRunId} not found`);
    const failed = await deps.repository.failedRecipients(sourceRunId);
    if (failed.length === 0) throw Error('no failed recipients to retry');
    for (const recipient of failed) {
      await deps.repository.resetRecipient(recipient.id);
      await deps.queue.enqueueRecipient(source.id, recipient.id, true);
    }
    await deps.repository.markSending(source.id);
    return { run: (await deps.repository.getRun(source.id))!, reused: true, recipientsCreated: failed.length };
  });
  return { enqueue, buildRecipients, retryFailed };
}
