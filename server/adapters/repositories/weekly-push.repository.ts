import type { WeeklyPushRepository } from '../../core/weekly-push/ports';
import type { WeeklyPushRun } from '@shared/schema';
import { weeklyPushRepo } from '../../modules/weeklyPush/weeklyPush.repository';
import { queues } from '../../infra/queue/queues';

/** Retains the existing Drizzle/pg-boss same-transaction bundle implementation. */
export const weeklyPushRepository: WeeklyPushRepository<WeeklyPushRun> = {
  findByKey: key => weeklyPushRepo.getRunByIdempotencyKey(key),
  hasLegacyHistory: (start, end) => weeklyPushRepo.hasLegacyWeeklyLogsInWindow(start, end),
  createBundle: (run, recipients) => weeklyPushRepo.createRunBundle(run, recipients, queues.weeklyPush),
  getRun: id => weeklyPushRepo.getRunById(id),
  failedRecipients: id => weeklyPushRepo.listRecipientsByRunAndStatus(id, 'failed'),
  async resetRecipient(id) {
    await weeklyPushRepo.updateRecipient(id, { status: 'pending', completedAt: null,
      nextRetryAt: null, errorCode: null, errorMessage: null });
  },
  async markSending(id) {
    await weeklyPushRepo.updateRun(id, { status: 'sending', completedAt: undefined, errorMessage: null });
  },
};
