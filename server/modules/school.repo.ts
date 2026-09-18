/**
 * Repository wrapping all per-school SQL access.
 *
 * Routes never touch raw SQL or `getSchoolDb` directly — they call into
 * this module so the unsafe parts (string concatenation around schema
 * names, dynamic table targets) are isolated and validated here.
 *
 * `schoolCode` must pass `assertSchool` (regex + whitelist) before any
 * identifier is interpolated into SQL.
 */
import { sql, and, eq, gte, lte, or, type SQL } from "drizzle-orm";
import { schedules, insertScheduleSchema } from "@shared/schema";
import {
  getSchoolDb,
  assertSchoolCode,
  schoolSchemaName,
} from "../multi-school-db";

/**
 * Task #33 — local alias kept for source-diff readability. All SQL
 * identifier construction goes through `sql.identifier(schoolSchemaName(code))`
 * so the schema name is BOTH validated (regex + whitelist via
 * assertSchoolCode) AND properly quoted by drizzle.
 */
function assertSchool(schoolCode: string): void {
  assertSchoolCode(schoolCode);
}

export type SchoolTeacher = {
  id: string;
  teacherName: string;
  subject: string | null;
  createdAt: string | null;
};

type TeacherRow = {
  id: string;
  teacher_name: string;
  subject: string | null;
  created_at: string | null;
};

export async function listTeachers(
  schoolCode: string
): Promise<SchoolTeacher[]> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const schemaIdent = sql.identifier(schoolSchemaName(schoolCode));
  const result = await db.execute(sql`
    SELECT id, teacher_name, subject, created_at
    FROM ${schemaIdent}.teachers
    ORDER BY teacher_name
  `);
  return (result.rows as TeacherRow[]).map((row) => ({
    id: row.id,
    teacherName: row.teacher_name,
    subject: row.subject,
    createdAt: row.created_at,
  }));
}

export async function getTeacherById(
  schoolCode: string,
  teacherId: string,
): Promise<SchoolTeacher | null> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const schemaIdent = sql.identifier(schoolSchemaName(schoolCode));
  const result = await db.execute(sql`
    SELECT id, teacher_name, subject, created_at
    FROM ${schemaIdent}.teachers
    WHERE id = ${teacherId}
    LIMIT 1
  `);
  const row = result.rows[0] as TeacherRow | undefined;
  return row ? { id: row.id, teacherName: row.teacher_name, subject: row.subject, createdAt: row.created_at } : null;
}

export async function listSchedules(
  schoolCode: string,
  filters: { teacher?: string; startDate?: string; endDate?: string }
) {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);

  const whereConditions: SQL[] = [];
  if (filters.teacher) {
    whereConditions.push(or(eq(schedules.coachName, filters.teacher), eq(schedules.coachName2, filters.teacher))!);
  }
  if (filters.startDate && filters.endDate) {
    whereConditions.push(
      and(
        gte(schedules.date, filters.startDate),
        lte(schedules.date, filters.endDate)
      )!
    );
  }

  return whereConditions.length > 0
    ? await db.select().from(schedules).where(and(...whereConditions))
    : await db.select().from(schedules);
}

export type SchoolFeedback = Record<string, unknown>;

export async function listFeedbacks(
  schoolCode: string,
  filters: { teacherId?: string; scheduleId?: string }
): Promise<SchoolFeedback[]> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);

  const conditions: SQL[] = [];
  if (filters.teacherId) {
    conditions.push(sql`teacher_id = ${filters.teacherId}`);
  }
  if (filters.scheduleId) {
    conditions.push(sql`schedule_id = ${filters.scheduleId}`);
  }

  const whereClause =
    conditions.length > 0
      ? sql` WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

  const schemaIdent = sql.identifier(schoolSchemaName(schoolCode));
  const result = await db.execute(sql`
    SELECT * FROM ${schemaIdent}.teacher_feedbacks
    ${whereClause}
    ORDER BY updated_at DESC
  `);

  return (result.rows ?? []) as SchoolFeedback[];
}

export type FeedbackInput = {
  scheduleId: string;
  teacherId: string;
  teacherName: string;
  status: string;
  rescheduleDate?: string | null;
  reschedulePeriod?: string | null;
  comment?: string | null;
};

export async function upsertFeedback(
  schoolCode: string,
  data: FeedbackInput
): Promise<SchoolFeedback> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const schemaIdent = sql.identifier(schoolSchemaName(schoolCode));
  const result = await db.execute(sql`
    INSERT INTO ${schemaIdent}.teacher_feedbacks
      (schedule_id, teacher_id, teacher_name, status, reschedule_date, reschedule_period, comment, updated_at)
    VALUES (
      ${data.scheduleId},
      ${data.teacherId},
      ${data.teacherName},
      ${data.status},
      ${data.rescheduleDate || null},
      ${data.reschedulePeriod || null},
      ${data.comment || null},
      NOW()
    )
    ON CONFLICT (schedule_id, teacher_id) WHERE teacher_id IS NOT NULL
    DO UPDATE SET
      status = EXCLUDED.status,
      reschedule_date = EXCLUDED.reschedule_date,
      reschedule_period = EXCLUDED.reschedule_period,
      comment = EXCLUDED.comment,
      updated_at = NOW()
    RETURNING *
  `);
  if (!result.rows || result.rows.length === 0) {
    throw new Error("Database insert failed - no rows returned");
  }
  return result.rows[0] as SchoolFeedback;
}

export async function teacherCanAccessSchedule(
  schoolCode: string,
  scheduleId: string,
  teacherName: string,
): Promise<boolean> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const [row] = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(
      eq(schedules.id, scheduleId),
      or(eq(schedules.coachName, teacherName), eq(schedules.coachName2, teacherName)),
    ))
    .limit(1);
  return !!row;
}

export async function createSchoolSchedule(
  schoolCode: string,
  rawBody: unknown
) {
  assertSchool(schoolCode);
  const validation = insertScheduleSchema.safeParse(rawBody);
  if (!validation.success) {
    return { ok: false as const, errors: validation.error.issues };
  }
  const db = await getSchoolDb(schoolCode);
  const inserted = await db
    .insert(schedules)
    .values({
      ...validation.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return { ok: true as const, schedule: inserted[0] };
}

export async function deleteSchoolSchedule(
  schoolCode: string,
  scheduleId: string
) {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const deleted = await db
    .delete(schedules)
    .where(eq(schedules.id, scheduleId))
    .returning();
  return deleted.length > 0;
}

export async function pingSchoolDb(schoolCode: string): Promise<boolean> {
  assertSchool(schoolCode);
  const db = await getSchoolDb(schoolCode);
  const result = await db.execute(sql`SELECT 1 as test`);
  return result.rows.length > 0;
}
