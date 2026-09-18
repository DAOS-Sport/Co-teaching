/**
 * Thin adapter around the LINE Push API used by the weekly-push
 * worker (Task #23).
 *
 * The legacy `server/line-notify.ts` already owns the cron-triggered
 * push code and an internal `sendLinePushMessage` helper. We do NOT
 * want to rewrite or expose that file's internals, so this adapter
 * re-implements the same minimal POST so the worker has its own
 * boundary for testing and error mapping.
 */
import { env } from "../../config/env";
import { fetchWithTimeout } from "../../shared/http/fetchWithTimeout";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export interface LinePushResult {
  ok: boolean;
  status: number; // HTTP status, or 0 on transport error
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Sends a single text push message to a LINE user/group ID.
 * Never throws — callers branch on `ok` so the worker can record
 * structured failure info on the recipient row.
 *
 * Errors come from `fetchWithTimeout` and are pre-classified:
 *   `timeout` | `network` | `http_4xx` | `http_5xx` | `no_token`.
 * The weekly-push worker uses these to decide retry vs. final-fail
 * (Task #32: 4xx other than 429 is treated as a hard error and is
 * not retried, since LINE 4xx responses won't change on retry).
 */
export async function sendTextMessage(
  to: string,
  text: string,
  retryKey?: string,
): Promise<LinePushResult> {
  const token = env.lineChannelAccessToken;
  if (!token) {
    return {
      ok: false,
      status: 0,
      errorCode: "no_token",
      errorMessage: "LINE_CHANNEL_ACCESS_TOKEN is not set",
    };
  }

  const result = await fetchWithTimeout(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });

  return {
    ok: result.ok,
    status: result.status,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}
