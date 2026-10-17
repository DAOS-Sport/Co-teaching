import { env } from "../../config/env";
import { isRetryKey, type PushOutcome } from "../../core/notifications/delivery";
import { assertOperationActive, currentOperation, remainingOperationMs } from '../../shared/http/operationScope';

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
export interface LinePushResult extends PushOutcome { ok: boolean }
export async function sendTextMessage(to: string, text: string, retryKey: string): Promise<LinePushResult> {
  return createLinePushAdapter({ token: env.lineChannelAccessToken ?? "", timeoutMs: env.outboundHttpTimeoutMs })(to, text, retryKey);
}
export function createLinePushAdapter(options: { token: string; timeoutMs?: number; fetch?: typeof fetch }) {
  return async (to: string, text: string, retryKey: string): Promise<LinePushResult> => {
    if (!options.token || !isRetryKey(retryKey)) {
      return { ok: false, outcome: "rejected", status: 0, errorCode: "CONFIG_ERROR", errorMessage: "A configured token and saved retry key are required" };
    }
    const controller = new AbortController();
    assertOperationActive(1500);
    const parent = currentOperation()?.signal;
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, {once:true});
    if(parent?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), remainingOperationMs(options.timeoutMs ?? 10_000,1500));
    try {
      const response = await (options.fetch ?? globalThis.fetch)(LINE_PUSH_URL, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}`, "X-Line-Retry-Key": retryKey },
        body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      });
      const requestId = response.headers.get("x-line-request-id") ?? undefined;
      const acceptedRequestId = response.headers.get("x-line-accepted-request-id") ?? undefined;
      if (response.ok || (response.status === 409 && acceptedRequestId)) {
        return { ok: true, outcome: "accepted", status: response.status, requestId, acceptedRequestId, errorCode: null, errorMessage: null };
      }
      const unknown = response.status >= 500 || response.status === 408 || response.status === 409;
      return { ok: false, outcome: unknown ? "unknown" : "rejected", status: response.status, requestId, acceptedRequestId,
        errorCode: unknown ? "LINE_ACCEPTANCE_UNKNOWN" : "HTTP_4XX", errorMessage: unknown ? "Platform acceptance is unknown" : "Platform rejected the request" };
    } catch {
      return { ok: false, outcome: "unknown", status: 0, errorCode: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", errorMessage: "Platform acceptance is unknown" };
    } finally { clearTimeout(timer); parent?.removeEventListener('abort',abort); }
  };
}
