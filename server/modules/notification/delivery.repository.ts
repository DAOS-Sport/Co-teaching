import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { weeklyPushRecipients, type InsertWeeklyPushRecipient } from "@shared/schema";
import { currentDb, inTransaction } from "../../shared/dbContext";
import { DELIVERY_LEASE_MS, type DeliveryStore, type FixedDelivery } from "../../core/notifications/delivery";

interface SavedEnvelope {
  message?: string;
  fixedDelivery?: FixedDelivery;
  delivery?: { firstAttemptAt?: number; claimToken?: string; claimedAt?: number; requestId?: string; acceptedRequestId?: string; acceptance?: string };
  [key: string]: unknown;
}
function envelope(value: unknown): SavedEnvelope {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SavedEnvelope : {};
}
export function prepareSavedDelivery(input: InsertWeeklyPushRecipient): InsertWeeklyPushRecipient {
  const id = input.id ?? randomUUID();
  const payload = envelope(input.payloadJson);
  const fixed: FixedDelivery = {
    notificationId: id, to: input.lineUserId ?? "", text: typeof payload.message === "string" ? payload.message : "", retryKey: input.lineRetryKey,
  };
  return { ...input, id, payloadJson: { ...payload, fixedDelivery: fixed } };
}

export const notificationDeliveryStore: DeliveryStore = {
  async claim(id, now) {
    return inTransaction(async () => {
      const tx = currentDb();
      const [row] = await tx.select().from(weeklyPushRecipients).where(eq(weeklyPushRecipients.id, id)).for("update");
      if (!row || ["accepted", "success", "failed", "skipped"].includes(row.status)) return null;
      if (!["pending", "processing", "sending", "retry_wait", "unknown"].includes(row.status)) return null;
      const payload = envelope(row.payloadJson);
      const metadata = payload.delivery ?? {};
      if (["processing", "sending"].includes(row.status) && now < (metadata.claimedAt ?? row.updatedAt?.getTime() ?? now) + DELIVERY_LEASE_MS) return null;
      if (row.status === "unknown" && !row.nextRetryAt) return null;
      if (row.nextRetryAt && now < row.nextRetryAt.getTime()) return null;
      const fixed = payload.fixedDelivery ?? {
        notificationId: row.id, to: row.lineUserId ?? "", text: typeof payload.message === "string" ? payload.message : "", retryKey: row.lineRetryKey,
      };
      const claimToken = randomUUID();
      // Legacy startedAt was overwritten per attempt. Its creation time is a conservative
      // lower bound; never restart a legacy retry window from its latest attempt.
      const firstAttemptAt = metadata.firstAttemptAt ?? (payload.fixedDelivery && row.attemptCount === 0 ? now : row.createdAt?.getTime() ?? 0);
      const attemptCount = row.attemptCount + 1;
      await tx.update(weeklyPushRecipients).set({ status: "processing", attemptCount, startedAt: new Date(firstAttemptAt), nextRetryAt: null,
        payloadJson: { ...payload, fixedDelivery: fixed, delivery: { ...metadata, firstAttemptAt, claimToken, claimedAt: now } }, updatedAt: new Date(now),
      }).where(eq(weeklyPushRecipients.id, id));
      return { id, fixed, attemptCount, firstAttemptAt, claimToken };
    });
  },
  async complete(record, completion, now) {
    await inTransaction(async () => {
      const tx = currentDb();
      const [row] = await tx.select().from(weeklyPushRecipients).where(eq(weeklyPushRecipients.id, record.id)).for("update");
      const payload = envelope(row?.payloadJson);
      if (!row || payload.delivery?.claimToken !== record.claimToken) throw new Error("Notification delivery claim was superseded");
      const [saved] = await tx.update(weeklyPushRecipients).set({
        status: completion.state, nextRetryAt: completion.nextRetryAt === null ? null : new Date(completion.nextRetryAt),
        completedAt: completion.nextRetryAt === null ? new Date(now) : null,
        // Compatibility field means platform acceptance only; it is not a delivery receipt.
        sentAt: completion.state === "accepted" ? new Date(now) : null,
        lineResponseCode: completion.result.status, errorCode: completion.result.errorCode, errorMessage: completion.result.errorMessage,
        payloadJson: { ...payload, delivery: { ...payload.delivery, acceptance: completion.result.outcome, requestId: completion.result.requestId, acceptedRequestId: completion.result.acceptedRequestId } },
        updatedAt: new Date(now),
      }).where(and(eq(weeklyPushRecipients.id, record.id), sql`${weeklyPushRecipients.payloadJson}->'delivery'->>'claimToken' = ${record.claimToken}`)).returning({ id: weeklyPushRecipients.id });
      if (!saved) throw new Error("Notification delivery result was not saved");
    });
  },
};
