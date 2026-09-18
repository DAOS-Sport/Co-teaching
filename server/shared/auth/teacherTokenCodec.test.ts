import assert from "node:assert/strict";
import test from "node:test";
import { encodeTeacherToken, isTeacherTokenExpired, verifyTeacherToken } from "./teacherTokenCodec";

const secret = "a-test-secret-that-is-long-enough";
const payload = {
  v: 1 as const,
  jti: "token-id",
  schoolCode: "demo",
  teacherId: "teacher-a",
  permissions: ["feedback:read", "feedback:write"],
  expiresAt: "2026-09-30T15:59:59.000Z",
};

test("signed teacher identity round-trips all bound claims", () => {
  assert.deepEqual(verifyTeacherToken(encodeTeacherToken(payload, secret), secret), payload);
});

test("tampering school or teacher invalidates the signature", () => {
  const token = encodeTeacherToken(payload, secret);
  const [encoded, signature] = token.split(".");
  const changed = { ...payload, schoolCode: "school2", teacherId: "teacher-b" };
  const changedEncoded = Buffer.from(JSON.stringify(changed)).toString("base64url");
  assert.equal(verifyTeacherToken(`${changedEncoded}.${signature}`, secret), null);
  assert.notEqual(encoded, changedEncoded);
});

test("a token signed with another secret is rejected", () => {
  const token = encodeTeacherToken(payload, secret);
  assert.equal(verifyTeacherToken(token, "different-secret"), null);
});

test("expiration is evaluated at the requested instant", () => {
  assert.equal(isTeacherTokenExpired(payload, new Date("2026-09-30T15:59:58Z")), false);
  assert.equal(isTeacherTokenExpired(payload, new Date("2026-09-30T15:59:59Z")), true);
});
