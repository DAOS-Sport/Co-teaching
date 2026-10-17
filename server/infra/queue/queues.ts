/**
 * Queue name registry for the pg-boss based job pipeline (Task #23).
 *
 * Centralizing the names here means producers and consumers can never
 * disagree on the exact string the queue is published under.
 */
export const queues = {
  notificationDelivery: "notification-delivery",
  notificationWeeklyTrigger: "notification-weekly-trigger",
  notificationDailyTrigger: "notification-daily-trigger",
  notificationReconcile: "notification-reconcile",
  notificationCleanup: "notification-cleanup",
  weeklyPush: "weekly-push",
  weeklyPushRecipient: "weekly-push-recipient",
  weeklyPushReport: "weekly-push-report",
} as const;

export type QueueName = (typeof queues)[keyof typeof queues];
