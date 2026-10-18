import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedTeacherTokenPayload = {
  v: 1;
  jti: string;
  schoolCode: string;
  teacherId: string;
  permissions: string[];
  expiresAt: string;
};

const signatureFor = (encoded: string, secret: string) =>
  createHmac("sha256", secret).update(encoded).digest("base64url");

export function encodeTeacherToken(payload: SignedTeacherTokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signatureFor(encoded, secret)}`;
}

export function verifyTeacherToken(token: string, secret: string): SignedTeacherTokenPayload | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(signatureFor(encoded, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.v !== 1 || !payload.jti || !payload.schoolCode || !payload.teacherId ||
        !Array.isArray(payload.permissions) || Number.isNaN(Date.parse(payload.expiresAt))) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isTeacherTokenExpired(payload: SignedTeacherTokenPayload, now = new Date()): boolean {
  return now.getTime() >= Date.parse(payload.expiresAt);
}
