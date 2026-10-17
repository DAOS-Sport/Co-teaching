import { createLinePushAdapter } from "./lineNotify.adapter";
import { notificationIdentity, sendDurableText } from "./delivery.service";
import { randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../../shared/http/fetchWithTimeout";

export type AlertOutcome = {
  eventId: string;
  status: "accepted" | "not_configured" | "failed";
  code: string;
};

export async function notifyCoachNotFound(name: string, config: { recipient: string | null; token: string | null }, send?: typeof fetchWithTimeout): Promise<AlertOutcome> {
  const eventId = notificationIdentity("coach-not-found-day", [new Date().toISOString().slice(0, 10), name, config.recipient]);
  if (!config.recipient || !config.token) return { eventId, status: "not_configured", code: !config.recipient ? "MISSING_RECIPIENT" : "MISSING_TOKEN" };
  const text = `【教練登入通知】\n教練「${name}」查無資料，請確認建檔。\n事件：${eventId}`;
  if (send) {
    // Preserve the existing isolated HTTP adapter seam. Runtime callers do not supply it.
    const adapter = createLinePushAdapter({ token: config.token, timeoutMs: 8000, fetch: async (url, init) => {
      const result = await send(String(url), { ...init, timeoutMs: 8000 });
      if (!result.status) throw new Error("Transport result unknown");
      return new Response(result.body, { status: result.status });
    } });
    const result = await adapter(config.recipient, text, randomUUID());
    return { eventId, status: result.ok ? "accepted" : "failed", code: result.ok ? "LINE_ACCEPTED" : result.errorCode ?? "LINE_REQUEST_FAILED" };
  }
  const result = await sendDurableText({ notificationId: eventId, to: config.recipient, text });
  return { eventId, status: result.state === "not_configured" ? "not_configured" : result.accepted ? "accepted" : "failed",
    code: result.state === "not_configured" ? "QUEUE_NOT_CONFIGURED" : result.accepted ? "LINE_ACCEPTED" : "LINE_ACCEPTANCE_UNKNOWN" };
}

export function coachNotFoundMessage(outcome: AlertOutcome): string {
  if (outcome.status === "accepted") return "查無教練資料，通知已由 LINE 接受，請等候管理員處理。";
  if (outcome.status === "not_configured") return "查無教練資料，管理員通知尚未設定，請直接聯繫管理員。";
  return "查無教練資料，管理員通知傳送失敗，請直接聯繫管理員。";
}
