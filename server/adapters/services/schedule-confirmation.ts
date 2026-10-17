import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ConfirmationContext } from "../../core/scheduling/entities";
import type { ScheduleConfirmation } from "../../core/scheduling/ports";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Only a context digest and expiry are encoded; no coach names are in the token. */
export function createScheduleConfirmation(key: string, now: () => number = Date.now): ScheduleConfirmation {
  const lifetimeMs = 5 * 60_000;
  const digest = (context: ConfirmationContext) => createHash("sha256").update(canonical(context)).digest("hex");
  const sign = (encoded: string) => createHmac("sha256", key).update(`schedule-warning:v1:${encoded}`).digest();
  return {
    issue(context) {
      const encoded = Buffer.from(JSON.stringify({ version: 1, context: digest(context), expiresAt: now() + lifetimeMs })).toString("base64url");
      return `${encoded}.${sign(encoded).toString("base64url")}`;
    },
    verify(token, context) {
      try {
        const parts = token.split(".");
        if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
        const supplied = Buffer.from(parts[1], "base64url"), expected = sign(parts[0]);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
        const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        const time = now();
        return data.version === 1 && data.context === digest(context)
          && Number.isSafeInteger(data.expiresAt) && data.expiresAt > time && data.expiresAt <= time + lifetimeMs;
      } catch { return false; }
    },
  };
}
