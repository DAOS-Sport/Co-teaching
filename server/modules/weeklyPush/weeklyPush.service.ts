/** Compatibility entry points used by existing HTTP, worker and wake callers.
 * Business decisions live in core/weekly-push; infrastructure assembles its ports.
 */
import { weeklyPushUseCases } from "../../infrastructure/weekly-push/composition";
import { weeklyPushQueue } from "../../adapters/services/weekly-push-queue";
export { computeDefaultWeekRange } from "../../adapters/services/weekly-push-calendar";
export { buildCoachWeeklyMessage } from "../../adapters/presenters/weekly-push-message";
export { RECIPIENT_RETRY_LIMIT, RECIPIENT_RETRY_DELAY_SECONDS } from "../../adapters/services/weekly-push-queue";
export const enqueueWeeklyPush = weeklyPushUseCases.enqueue;
export const buildRecipientsForWeek = weeklyPushUseCases.buildRecipients;
export const retryFailedRecipients = weeklyPushUseCases.retryFailed;
export const enqueueRecipientJob = weeklyPushQueue.enqueueRecipient;
export function expectedRecipientsToSend<T extends { status: string }>(recipients: T[]): T[] {
  return recipients.filter(recipient => recipient.status === "pending");
}
