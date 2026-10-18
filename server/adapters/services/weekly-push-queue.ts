import { randomUUID } from 'node:crypto';
import { currentDb } from '../../shared/dbContext';
import { queueTransactionDb } from '../../infra/queue/transaction';
import { getQueueProducer } from '../../infra/queue/boss';
import { queues } from '../../infra/queue/queues';
import type { WeeklyRecipientQueue } from '../../core/weekly-push/ports';

export const RECIPIENT_RETRY_LIMIT = 3;
export const RECIPIENT_RETRY_DELAY_SECONDS = 60;
export const weeklyPushQueue: WeeklyRecipientQueue = {
  async enqueueRecipient(runId, recipientId, manualRetry = false) {
    await getQueueProducer().send(queues.weeklyPushRecipient, { runId, recipientId }, {
      singletonKey: `${runId}:${recipientId}:${manualRetry ? randomUUID() : 'initial'}`,
      retryLimit: RECIPIENT_RETRY_LIMIT, retryDelay: RECIPIENT_RETRY_DELAY_SECONDS,
      retryBackoff: true, db: queueTransactionDb(currentDb()),
    });
  },
  async flushCommitted() {
    const { dispatchWeeklyPushOutbox } = await import('../../modules/weeklyPush/weeklyPush.outbox');
    await dispatchWeeklyPushOutbox();
  },
};
