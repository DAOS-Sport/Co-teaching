import { createHash, randomBytes } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { env } from "../../config/env";
import { teacherAccessAuditLogs, teacherAccessTokens } from "@shared/schema";
import * as schoolRepo from "../../modules/school.repo";
import { encodeTeacherToken, isTeacherTokenExpired, verifyTeacherToken } from "./teacherTokenCodec";

export const TEACHER_PERMISSIONS = ["feedback:read", "feedback:write"] as const;
export type TeacherPermission = (typeof TEACHER_PERMISSIONS)[number];

type TeacherTokenPayload = {
  v: 1;
  jti: string;
  schoolCode: string;
  teacherId: string;
  permissions: TeacherPermission[];
  expiresAt: string;
};

export type TeacherIdentity = {
  tokenId: string;
  schoolCode: string;
  teacherId: string;
  teacherName: string;
  permissions: TeacherPermission[];
  expiresAt: string;
};

export type TeacherIdentityRequest = Request & { teacherIdentity?: TeacherIdentity };

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function parseAndVerify(token: string): TeacherTokenPayload | null {
  const payload = verifyTeacherToken(token, env.teacherTokenSecret);
  if (!payload || !payload.permissions.every((permission) =>
    TEACHER_PERMISSIONS.includes(permission as TeacherPermission))) return null;
  return payload as TeacherTokenPayload;
}

export async function createTeacherAccessToken(input: {
  schoolCode: string;
  teacherId: string;
  permissions: TeacherPermission[];
  expiresAt: Date;
}) {
  const teacher = await schoolRepo.getTeacherById(input.schoolCode, input.teacherId);
  if (!teacher) throw new Error("teacher not found in school");
  if (input.expiresAt.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");
  const payload: TeacherTokenPayload = {
    v: 1,
    jti: randomBytes(18).toString("base64url"),
    schoolCode: input.schoolCode,
    teacherId: input.teacherId,
    permissions: Array.from(new Set(input.permissions)),
    expiresAt: input.expiresAt.toISOString(),
  };
  const token = encodeTeacherToken(payload, env.teacherTokenSecret);
  const [record] = await db.insert(teacherAccessTokens).values({
    jti: payload.jti,
    tokenHash: tokenHash(token),
    schoolCode: payload.schoolCode,
    teacherId: payload.teacherId,
    permissions: payload.permissions,
    expiresAt: input.expiresAt,
  }).returning();
  await db.insert(teacherAccessAuditLogs).values({
    tokenId: record.id,
    schoolCode: record.schoolCode,
    teacherId: record.teacherId,
    event: "created",
  });
  return { token, record, teacher };
}

export async function revokeTeacherAccessToken(id: string): Promise<boolean> {
  const [record] = await db.update(teacherAccessTokens)
    .set({ revokedAt: new Date() })
    .where(eq(teacherAccessTokens.id, id))
    .returning();
  if (!record) return false;
  await db.insert(teacherAccessAuditLogs).values({
    tokenId: record.id,
    schoolCode: record.schoolCode,
    teacherId: record.teacherId,
    event: "revoked",
  });
  return true;
}

export async function listTeacherAccessTokens(schoolCode: string) {
  return db.select({
    id: teacherAccessTokens.id,
    schoolCode: teacherAccessTokens.schoolCode,
    teacherId: teacherAccessTokens.teacherId,
    permissions: teacherAccessTokens.permissions,
    expiresAt: teacherAccessTokens.expiresAt,
    revokedAt: teacherAccessTokens.revokedAt,
    lastUsedAt: teacherAccessTokens.lastUsedAt,
    createdAt: teacherAccessTokens.createdAt,
  }).from(teacherAccessTokens)
    .where(eq(teacherAccessTokens.schoolCode, schoolCode))
    .orderBy(desc(teacherAccessTokens.createdAt));
}

export async function listTeacherAccessAuditLogs(schoolCode: string, limit = 200) {
  return db.select().from(teacherAccessAuditLogs)
    .where(eq(teacherAccessAuditLogs.schoolCode, schoolCode))
    .orderBy(desc(teacherAccessAuditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

function readToken(req: Request): string | null {
  const header = req.headers["x-teacher-token"];
  if (typeof header === "string" && header) return header;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const query = req.query.token;
  return typeof query === "string" && query ? query : null;
}

export function requireTeacherIdentity(permission: TeacherPermission) {
  return async (req: TeacherIdentityRequest, res: Response, next: NextFunction) => {
    const token = readToken(req);
    const payload = token ? parseAndVerify(token) : null;
    if (!token || !payload) {
      return res.status(401).json({ code: "teacher_token_invalid", message: "教師連結無效" });
    }
    if (isTeacherTokenExpired(payload)) {
      return res.status(401).json({ code: "teacher_token_expired", message: "教師連結已過期" });
    }
    if (req.params.schoolCode !== payload.schoolCode) {
      return res.status(403).json({ code: "teacher_school_mismatch", message: "此連結不屬於該學校" });
    }
    if (!payload.permissions.includes(permission)) {
      return res.status(403).json({ code: "teacher_permission_denied", message: "此連結沒有操作權限" });
    }
    const [record] = await db.select().from(teacherAccessTokens).where(and(
      eq(teacherAccessTokens.jti, payload.jti),
      eq(teacherAccessTokens.tokenHash, tokenHash(token)),
    )).limit(1);
    if (!record || record.revokedAt) {
      return res.status(401).json({ code: "teacher_token_revoked", message: "教師連結已撤銷" });
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ code: "teacher_token_expired", message: "教師連結已過期" });
    }
    if (record.schoolCode !== payload.schoolCode || record.teacherId !== payload.teacherId) {
      return res.status(403).json({ code: "teacher_identity_mismatch", message: "教師身分不一致" });
    }
    const teacher = await schoolRepo.getTeacherById(payload.schoolCode, payload.teacherId);
    if (!teacher) return res.status(401).json({ code: "teacher_not_found", message: "教師資料不存在" });
    req.teacherIdentity = {
      tokenId: record.id,
      schoolCode: payload.schoolCode,
      teacherId: payload.teacherId,
      teacherName: teacher.teacherName,
      permissions: payload.permissions,
      expiresAt: payload.expiresAt,
    };
    await Promise.all([
      db.update(teacherAccessTokens).set({ lastUsedAt: new Date() }).where(eq(teacherAccessTokens.id, record.id)),
      db.insert(teacherAccessAuditLogs).values({
        tokenId: record.id,
        schoolCode: payload.schoolCode,
        teacherId: payload.teacherId,
        event: `used:${permission}`,
        path: req.originalUrl.split("?")[0],
        ipAddress: req.ip || null,
      }),
    ]);
    next();
  };
}
