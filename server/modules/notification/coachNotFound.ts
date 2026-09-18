import { randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../../shared/http/fetchWithTimeout";

export type AlertOutcome = {
  eventId: string;
  status: "accepted" | "not_configured" | "failed";
  code: string;
};

export async function notifyCoachNotFound(
  name: string,
  config: { token: string | null; recipient: string | null },
  send = fetchWithTimeout,
): Promise<AlertOutcome> {
  const eventId = randomUUID();
  if (!config.recipient || !config.token) {
    return { eventId, status: "not_configured", code: !config.recipient ? "missing_recipient" : "missing_token" };
  }
  const result = await send("https://api.line.me/v2/bot/message/push", {
    method: "POST", timeoutMs: 8_000,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ to: config.recipient, messages: [{ type: "text", text: `【教練登入通知】\n教練「${name}」查無資料，請確認建檔。\n事件：${eventId}` }] }),
  });
  return { eventId, status: result.ok ? "accepted" : "failed", code: result.ok ? "line_accepted" : result.errorCode ?? "unexpected_response" };
}

export function coachNotFoundMessage(outcome: AlertOutcome): string {
  if (outcome.status === "accepted") return "查無教練資料，通知已由 LINE 接受，請等候管理員處理。";
  if (outcome.status === "not_configured") return "查無教練資料，管理員通知尚未設定，請直接聯繫管理員。";
  return "查無教練資料，管理員通知傳送失敗，請直接聯繫管理員。";
}
