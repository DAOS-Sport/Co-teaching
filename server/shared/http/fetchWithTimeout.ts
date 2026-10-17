/**
 * Common wrapper around `fetch()` for all outbound HTTP calls
 * (LINE Messaging API, LINE OAuth, Ragic, ...). (Task #32)
 *
 * Why: every outbound call without an `AbortController` can wedge an
 * Express request handler or a pg-boss worker indefinitely if the
 * remote stalls. We previously had no upper bound — only a remote
 * TCP / TLS timeout. This helper enforces a per-call timeout
 * (default 8s, overridable via env `OUTBOUND_HTTP_TIMEOUT_MS` —
 * surfaced through `server/config/env.ts` — or per-call
 * `timeoutMs`) and returns a small structured result so
 * callers can branch on `errorCode` instead of `try/catch`-ing a
 * grab-bag of failure shapes.
 *
 * Error classification (used by the weekly-push worker to decide
 * retry vs. final-fail):
 *   - `timeout`   — AbortController fired (remote stalled).      Transient.
 *   - `network`   — DNS/TLS/connection refused.                  Transient.
 *   - `http_5xx`  — Remote returned 5xx.                          Transient.
 *   - `http_4xx`  — Remote returned 4xx.                          Hard error
 *                   (with the lone exception of 429, which is rate
 *                    limiting — callers may treat that one as transient).
 */

import { env } from "../../config/env";
import { currentOperation, remainingOperationMs, assertOperationActive } from './operationScope';

const DEFAULT_TIMEOUT_MS = env.outboundHttpTimeoutMs;

export type HttpErrorCode = "timeout" | "network" | "http_4xx" | "http_5xx";

export interface FetchResult {
  ok: boolean;
  /** HTTP status; 0 on transport error (timeout/network). */
  status: number;
  /** Raw text body, may be empty on transport error. */
  body: string;
  errorCode: HttpErrorCode | null;
  errorMessage: string | null;
}

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Per-call timeout in ms; falls back to `OUTBOUND_HTTP_TIMEOUT_MS` env or 8000. */
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutOptions = {},
): Promise<FetchResult> {
  assertOperationActive(1500);
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: explicitSignal, ...init } = opts;
  const callerSignal=explicitSignal ?? currentOperation()?.signal;
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), remainingOperationMs(timeoutMs,1500));
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text().catch(() => "");
    if (res.ok) {
      return { ok: true, status: res.status, body, errorCode: null, errorMessage: null };
    }
    const errorCode: HttpErrorCode = res.status >= 500 ? "http_5xx" : "http_4xx";
    return {
      ok: false,
      status: res.status,
      body,
      errorCode,
      errorMessage: body.slice(0, 500),
    };
  } catch (err) {
    const aborted =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err as { name?: string } | null)?.name === "AbortError";
    const isTimeout = aborted && !callerSignal?.aborted;
    return {
      ok: false,
      status: 0,
      body: "",
      errorCode: isTimeout ? "timeout" : "network",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Convenience: parse the body as JSON when the call succeeded.
 * Returns the parsed value, or `null` if the body was empty / unparseable.
 */
export function parseJsonBody<T = unknown>(result: FetchResult): T | null {
  if (!result.body) return null;
  try {
    return JSON.parse(result.body) as T;
  } catch {
    return null;
  }
}
