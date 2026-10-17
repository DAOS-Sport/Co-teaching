export type DeliveryState = "pending" | "processing" | "accepted" | "retry_wait" | "failed" | "unknown";
export interface FixedDelivery { notificationId: string; to: string; text: string; retryKey: string }
export interface DeliveryRecord { id: string; fixed: FixedDelivery; attemptCount: number; firstAttemptAt: number; claimToken: string }
export interface PushOutcome {
  outcome: "accepted" | "rejected" | "unknown";
  status: number;
  requestId?: string;
  acceptedRequestId?: string;
  errorCode: string | null;
  errorMessage: string | null;
}
export interface DeliveryCompletion { state: DeliveryState; nextRetryAt: number | null; result: PushOutcome }
export interface DeliveryStore {
  claim(id: string, now: number): Promise<DeliveryRecord | null>;
  complete(record: DeliveryRecord, completion: DeliveryCompletion, now: number): Promise<void>;
}
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_DELIVERY_ATTEMPTS = 4;
export const DELIVERY_LEASE_MS = 30_000;
export function isRetryKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function deliveryCompletion(record: DeliveryRecord, result: PushOutcome, now: number): DeliveryCompletion {
  if (result.outcome === "accepted") return { state: "accepted", result, nextRetryAt: null };
  if (result.outcome === "rejected") return { state: "failed", result, nextRetryAt: null };
  const next = now + 60_000 * 2 ** Math.max(0, record.attemptCount - 1);
  const canRetry = record.attemptCount < MAX_DELIVERY_ATTEMPTS && next < record.firstAttemptAt + RETRY_WINDOW_MS;
  return { state: canRetry ? "retry_wait" : "unknown", result, nextRetryAt: canRetry ? next : null };
}
/** The store commits a claim before the request; a crashed sender reuses its saved identity. */
export async function deliverNotification(id: string, dependencies: {
  store: DeliveryStore; send: (fixed: FixedDelivery) => Promise<PushOutcome>; now: () => number;
}): Promise<{ state: DeliveryState | "unclaimed"; retry: boolean }> {
  const record = await dependencies.store.claim(id, dependencies.now());
  if (!record) return { state: "unclaimed", retry: false };
  const now = dependencies.now();
  let result: PushOutcome;
  if (!isRetryKey(record.fixed.retryKey) || !record.fixed.to || !record.fixed.text) {
    result = { outcome: "rejected", status: 0, errorCode: "INVALID_SAVED_DELIVERY", errorMessage: "Saved delivery is incomplete" };
  } else if (record.attemptCount > MAX_DELIVERY_ATTEMPTS) {
    result = { outcome: "unknown", status: 0, errorCode: "ATTEMPTS_EXHAUSTED", errorMessage: "Acceptance remains unknown after the attempt limit" };
  } else if (!Number.isFinite(record.firstAttemptAt) || now >= record.firstAttemptAt + RETRY_WINDOW_MS) {
    result = { outcome: "unknown", status: 0, errorCode: "RETRY_WINDOW_EXPIRED", errorMessage: "Acceptance cannot be determined after the retry window" };
  } else {
    try { result = await dependencies.send(record.fixed); }
    catch { result = { outcome: "unknown", status: 0, errorCode: "TRANSPORT_UNKNOWN", errorMessage: "Request acceptance is unknown" }; }
  }
  const completion = deliveryCompletion(record, result, dependencies.now());
  if (result.errorCode === "RETRY_WINDOW_EXPIRED") completion.nextRetryAt = null;
  await dependencies.store.complete(record, completion, dependencies.now());
  return { state: completion.state, retry: completion.nextRetryAt !== null };
}
