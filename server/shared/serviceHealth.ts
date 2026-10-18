import { fetchWithTimeout } from "./http/fetchWithTimeout";
import { parseRagicBody } from "../ragic.logic";

export type ServiceHealth = {
  status: "ok" | "error" | "timeout" | "disabled" | "misconfigured" | "unknown";
  checkedAt: string;
  code: string;
};

export async function probeHttpService(input: {
  enabled: boolean; configured: boolean; url: string;
  headers?: Record<string, string>;
  kind: "line" | "ragic"; lastError?: unknown;
}, send = fetchWithTimeout): Promise<ServiceHealth> {
  const checkedAt = new Date().toISOString();
  if (!input.enabled) return { status: "disabled", checkedAt, code: "disabled" };
  if (!input.configured) return { status: "misconfigured", checkedAt, code: "missing_configuration" };
  const result = await send(input.url, { headers: input.headers, timeoutMs: 3_000 });
  if (!result.ok) return { status: result.errorCode === "timeout" ? "timeout" : "error", checkedAt, code: result.errorCode ?? "request_failed" };
  const valid = input.kind === "ragic" ? (() => {
    const parsed = parseRagicBody(result.body);
    return parsed.ok && parsed.records.length > 0 && parsed.records.every(r => typeof r._ragicId === "number");
  })() : (() => {
    try { return typeof JSON.parse(result.body).userId === "string"; } catch { return false; }
  })();
  if (!valid) return { status: "error", checkedAt, code: "invalid_response" };
  if (input.lastError) return { status: "error", checkedAt, code: "last_sync_failed" };
  return { status: "ok", checkedAt, code: "connection_verified" };
}
