import { randomUUID } from 'node:crypto';
import { storage } from '../../storage';
import { inTransaction } from '../../shared/dbContext';
import { createWeeklyPushUseCases } from '../../core/weekly-push/use-cases';
import { weeklyPushRepository } from '../../adapters/repositories/weekly-push.repository';
import { weeklyPushQueue } from '../../adapters/services/weekly-push-queue';
import { buildCoachWeeklyMessage } from '../../adapters/presenters/weekly-push-message';
import { computeDefaultWeekRange } from '../../adapters/services/weekly-push-calendar';

/** The only assembly point: core never imports storage, environment, or pg-boss. */
export const weeklyPushUseCases = createWeeklyPushUseCases({
  repository: weeklyPushRepository,
  roster: { approvedCoaches: () => storage.getApprovedCoachUsers(),
    schedules: (start, end) => storage.getSchedulesByDateRange(start, end) },
  transaction: { run: inTransaction }, queue: weeklyPushQueue,
  clock: { now: () => Date.now(), defaultWeek: () => computeDefaultWeekRange() },
  newId: randomUUID, message: buildCoachWeeklyMessage,
});
