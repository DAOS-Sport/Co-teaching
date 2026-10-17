import { featureFlags } from "../../config/featureFlags";
import { createHash, randomUUID } from "node:crypto";
import { deliverNotification } from "../../core/notifications/delivery";
import { weeklyPushRepo } from "../weeklyPush/weeklyPush.repository";
import { queues } from "../../infra/queue/queues";
import { notificationDeliveryStore } from "./delivery.repository";
import { sendTextMessage } from "./lineNotify.adapter";

function identityUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function notificationIdentity(purpose: string, values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([purpose, ...values])).digest("hex");
}
export async function enqueueTextNotification(input: { notificationId: string; to: string; text: string; reuseSavedPayload?: boolean; latestCreateAt?:number;}) {
  if (!featureFlags.enableWeeklyPushQueue) return { notificationId: "", runId: "", reused: false, state: "not_configured" as const };
  const runId = identityUuid(`notification-run:${input.notificationId}`);
  const recipientId = textNotificationRecipientId(input.notificationId);
  const day = new Date().toISOString().slice(0, 10);
  if(input.latestCreateAt!==undefined&&(!Number.isFinite(input.latestCreateAt)||Date.now()>=input.latestCreateAt))throw Error('notification_slot_expired');
  const result = await weeklyPushRepo.createRunBundle({ id: runId, pushType: "notification", weekStartDate: day, weekEndDate: day,
    triggerSource: "manual", destination: `notification:${runId}`, idempotencyKey: `notification:${input.notificationId}`, status: "queued", dryRun: false,
  }, [{ id: recipientId, runId, recipientType: "notification", recipientName: "notification", lineUserId: input.to, status: "pending",
    deliveryKey: `notification:${input.notificationId}`, lineRetryKey: randomUUID(), payloadJson: { message: input.text },
  }], queues.notificationDelivery);
  if (!result.created) {
    const existing = await weeklyPushRepo.getRecipientById(recipientId);
    const saved = existing?.payloadJson as { fixedDelivery?: { to?: string; text?: string } } | null;
    if (!saved?.fixedDelivery || saved.fixedDelivery.to !== input.to || (!input.reuseSavedPayload && saved.fixedDelivery.text !== input.text)) throw new Error("Notification identity already belongs to a different saved request");
  }
  // Existing identity always keeps the original recipient/body/key, even when a caller supplies new content.
  return { notificationId: recipientId, runId: result.run.id, reused: !result.created, state: result.created ? "pending" as const : "existing" as const };
}
export async function deliverSavedRecipient(id: string) {
  return deliverNotification(id, { store: notificationDeliveryStore, now: Date.now,
    send: fixed => sendTextMessage(fixed.to, fixed.text, fixed.retryKey),
  });
}
export async function sendDurableText(input: { notificationId: string; to: string; text: string; reuseSavedPayload?: boolean;}) {
  const queued = await enqueueTextNotification(input);
  if (queued.state === "not_configured") return { ...queued, ok: false, accepted: false, errorCode: "QUEUE_NOT_CONFIGURED", errorMessage: "Notification queue is not configured" };
  await deliverSavedRecipient(queued.notificationId);
  const recipient = await weeklyPushRepo.getRecipientById(queued.notificationId);
  return { ...queued, state: recipient?.status ?? "unknown", errorCode: recipient?.errorCode ?? null, errorMessage: recipient?.errorMessage ?? null,
    ok: recipient?.status === "accepted" || recipient?.status === "success", accepted: recipient?.status === "accepted" || recipient?.status === "success" };
}

function textNotificationRecipientId(notificationId: string): string { return identityUuid(`notification-recipient:${notificationId}`); }
export async function findSavedTextNotification(notificationId: string) { return weeklyPushRepo.getRecipientById(textNotificationRecipientId(notificationId)); }
