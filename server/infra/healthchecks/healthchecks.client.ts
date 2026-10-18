/**
 * Healthchecks.io watchdog client for the weekly push (Task #23).
 *
 * Three lifecycle pings per run:
 *   - `pingStart()`   — `${BASE}/start`  before any work
 *   - `pingSuccess()` — `${BASE}`        on clean completion
 *   - `pingFail(err)` — `${BASE}/fail`   on unrecoverable failure
 *
 * If `HEALTHCHECKS_WEEKLY_PUSH_URL` is unset OR
 * `HEALTHCHECKS_WEEKLY_PUSH_ENABLED` is false, we deliberately do
 * NOT throw — we only emit a warn-level log. The push itself must
 * still run; the watchdog is observability, not a precondition.
 */
import { env } from "../../config/env";
import { currentOperation, remainingOperationMs } from '../../shared/http/operationScope';

const TIMEOUT_MS = 5_000;

function baseUrl(): string | null {
  if (!env.healthchecksWeeklyPushEnabled) return null;
  return env.healthchecksWeeklyPushUrl;
}

async function safeGet(url: string, body?: string): Promise<void> {
  const ctrl = new AbortController();
  const parent=currentOperation()?.signal;
  if(parent?.aborted || remainingOperationMs(TIMEOUT_MS,1500)<1) return;
  const abort=()=>ctrl.abort(); parent?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => ctrl.abort(), remainingOperationMs(TIMEOUT_MS,1500));
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      body,
      headers: body ? { "Content-Type": "text/plain" } : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[healthchecks] ping HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[healthchecks] ping failed');
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort',abort);
  }
}

export async function pingStart(): Promise<void> {
  const url = baseUrl();
  if (!url) {
    console.warn("[healthchecks] start ping skipped — URL not configured");
    return;
  }
  await safeGet(`${url}/start`);
}

export async function pingSuccess(message?: string): Promise<void> {
  const url = baseUrl();
  if (!url) {
    console.warn("[healthchecks] success ping skipped — URL not configured");
    return;
  }
  await safeGet(url, message);
}

export async function pingFail(error: unknown): Promise<void> {
  const url = baseUrl();
  if (!url) {
    console.warn("[healthchecks] fail ping skipped — URL not configured");
    return;
  }
  const body = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  await safeGet(`${url}/fail`, body.slice(0, 10_000));
}
