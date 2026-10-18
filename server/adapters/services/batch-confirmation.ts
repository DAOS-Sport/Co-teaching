import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
export function createBatchConfirmation(key: string, now: () => number = Date.now) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(ordered(JSON.parse(JSON.stringify(value))))).digest("hex");
  const sign = (value: string) => createHmac("sha256", key).update(`schedule-batch:v1:${value}`).digest();
  return {
    issue(context: unknown): string {
      const body = Buffer.from(JSON.stringify({ digest: digest(context), expiresAt: now() + 300_000 })).toString("base64url");
      return `${body}.${sign(body).toString("base64url")}`;
    },
    verify(token: unknown, context: unknown): boolean {
      if (typeof token !== "string" || token.length > 2048) return false;
      try {
        const parts = token.split(".");
        if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return false;
        const signature = Buffer.from(parts[1], "base64url"), expected = sign(parts[0]);
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
        const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), time = now();
        return data.digest === digest(context) && Number.isSafeInteger(data.expiresAt) && data.expiresAt > time && data.expiresAt <= time + 300_000;
      } catch { return false; }
    },
  };
}
