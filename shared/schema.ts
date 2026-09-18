import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  text,
  date,
  integer,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role").notNull().default("student"), // admin, coach, student
  coachName: varchar("coach_name"), // For coach role users
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const venues = pgTable("venues", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  color: varchar("color").notNull(),
  order: integer("order").notNull(),
});

export const timeSlots = pgTable("time_slots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  period: varchar("period").notNull(), // 第1節, 第2節, etc.
  startTime: varchar("start_time").notNull(),
  endTime: varchar("end_time").notNull(),
  order: integer("order").notNull(),
});

export const schedules = pgTable("schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  date: date("date").notNull(),
  venueId: varchar("venue_id").notNull().references(() => venues.id),
  timeSlotId: varchar("time_slot_id").notNull().references(() => timeSlots.id),
  className: varchar("class_name"),
  coachName: varchar("coach_name"),
  coachName2: varchar("coach_name_2"),
  coach1IsTeaching: boolean("coach1_is_teaching").notNull().default(true),
  coach2IsTeaching: boolean("coach2_is_teaching").notNull().default(false),
  coachCount: integer("coach_count").notNull().default(1),
  isClassLocked: boolean("is_class_locked").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Hot-path indexes — the schedule table is queried predominantly by
  // date range (week views, daily push) and by coach name (coach
  // portal, statistics, conflict detection across both teaching slots).
  // Without these, sequential scans dominate as the table grows over
  // the semester.
  index("idx_schedules_date").on(table.date),
  index("idx_schedules_coach_name").on(table.coachName),
  index("idx_schedules_coach_name_2").on(table.coachName2),
  uniqueIndex("uniq_schedule_class_in_cell").on(
    table.venueId,
    table.date,
    table.timeSlotId,
    sql`lower(regexp_replace(trim(${table.className}), '\\s+', '', 'g'))`,
  ).where(sql`${table.className} IS NOT NULL AND trim(${table.className}) <> ''`),
]);

// 教練用戶表 - LINE 登入的教練帳號（前台系統）
export const coachUsers = pgTable("coach_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lineId: varchar("line_id").unique("coach_users_line_id_key"),
  name: varchar("name").notNull(),
  phone: varchar("phone"),
  email: varchar("email"),
  employeeId: varchar("employee_id"), // 員工帳號（從 Ragic 同步）
  status: varchar("status").notNull().default("pending"), // pending / approved / rejected
  role: varchar("role").notNull().default("coach"), // admin / coach
  linkedCoachName: varchar("linked_coach_name"), // 對應排課系統中的教練名稱
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 教練登記表 - 存儲對沒有教練課程的登記
export const coachRegistrations = pgTable("coach_registrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scheduleId: varchar("schedule_id").notNull().references(() => schedules.id, { onDelete: 'cascade' }),
  coachName: varchar("coach_name").notNull(),
  registeredAt: timestamp("registered_at").defaultNow(),
});

// 多學校系統表定義
// 教師表 - 各學校的教師清單
export const teachers = pgTable("teachers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherName: varchar("teacher_name").notNull(),
  subject: varchar("subject"), // 科目（可選）
  createdAt: timestamp("created_at").defaultNow(),
});

// 教師回覆表 - 老師對課程的回覆狀態
export const teacherFeedbacks = pgTable("teacher_feedbacks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scheduleId: varchar("schedule_id").notNull().references(() => schedules.id, { onDelete: 'cascade' }),
  teacherId: varchar("teacher_id").references(() => teachers.id),
  teacherName: varchar("teacher_name").notNull(),
  status: varchar("status").notNull(), // need_coop / no_coop / reschedule
  rescheduleDate: date("reschedule_date"), // 調課日期（status=reschedule時必填）
  reschedulePeriod: varchar("reschedule_period"), // 調課節次（status=reschedule時必填）
  comment: text("comment"), // 備註（可選）
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // 同一老師對同一課程只保留最後一次回覆
  unique("teacher_feedbacks_schedule_id_teacher_name_unique").on(table.scheduleId, table.teacherName),
  uniqueIndex("teacher_feedbacks_schedule_id_teacher_id_unique")
    .on(table.scheduleId, table.teacherId)
    .where(sql`${table.teacherId} IS NOT NULL`),
]);

export const teacherAccessTokens = pgTable("teacher_access_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jti: varchar("jti").notNull().unique("teacher_access_tokens_jti_key"),
  tokenHash: varchar("token_hash").notNull().unique("teacher_access_tokens_hash_key"),
  schoolCode: varchar("school_code").notNull(),
  teacherId: varchar("teacher_id").notNull(),
  permissions: jsonb("permissions").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  createdBy: varchar("created_by").notNull().default("admin-password"),
}, (table) => [
  index("idx_teacher_access_tokens_school_teacher").on(table.schoolCode, table.teacherId),
  index("idx_teacher_access_tokens_expires").on(table.expiresAt),
]);

export const teacherAccessAuditLogs = pgTable("teacher_access_audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tokenId: varchar("token_id").references(() => teacherAccessTokens.id, { onDelete: "set null" }),
  schoolCode: varchar("school_code").notNull(),
  teacherId: varchar("teacher_id").notNull(),
  event: varchar("event").notNull(),
  path: text("path"),
  ipAddress: varchar("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [index("idx_teacher_access_audit_token").on(table.tokenId, table.createdAt)]);

// 系統設定表 - 存儲教練守則等設定
export const systemSettings = pgTable("system_settings", {
  key: varchar("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 場館資訊表 - 存儲場館影片連結等資訊
export const venueInfos = pgTable("venue_infos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  venueName: varchar("venue_name").notNull().unique("venue_infos_venue_name_key"),
  videoUrl: text("video_url"),
  description: text("description"),
  mapUrl: text("map_url"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const coachVenuePreferences = pgTable("coach_venue_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  coachName: varchar("coach_name").notNull(),
  venueName: varchar("venue_name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  unique("coach_venue_preferences_coach_name_venue_name_key").on(table.coachName, table.venueName),
]);

export const coachAvailability = pgTable("coach_availability", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  coachName: varchar("coach_name").notNull(),
  weekStart: date("week_start").notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  timeSlotOrder: integer("time_slot_order").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  // 名稱明確指定為 DB 既有 constraint（PG 自動截斷至 63 字元，以 _time_s_key 結尾）
  unique("coach_availability_coach_name_week_start_day_of_week_time_s_key").on(
    table.coachName,
    table.weekStart,
    table.dayOfWeek,
    table.timeSlotOrder,
  ),
]);

// ─── Task #23: Weekly push pipeline (pg-boss) ────────────────────────
// One row per attempted batch run (manual or cron-triggered).
// Status flow: queued → running → success | partial_failed | failed.
export const weeklyPushRuns = pgTable("weekly_push_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pushType: varchar("push_type").notNull(), // 'weekly' (reserved for future variants)
  weekStartDate: date("week_start_date").notNull(),
  weekEndDate: date("week_end_date").notNull(),
  triggerSource: varchar("trigger_source").notNull(), // 'cron' | 'manual' | 'retry'
  destination: varchar("destination").notNull().default("coaches"),
  idempotencyKey: varchar("idempotency_key").notNull(),
  status: varchar("status").notNull(), // queued|preparing|sending|reconciling|success|partial_success|failed|cancelled
  dryRun: boolean("dry_run").notNull().default(false),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  totalCount: integer("total_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  reportPath: text("report_path"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_weekly_push_runs_status").on(table.status),
  index("idx_weekly_push_runs_week").on(table.weekStartDate, table.weekEndDate),
  uniqueIndex("uniq_weekly_push_delivery").on(
    table.pushType,
    table.weekStartDate,
    table.destination,
    table.dryRun,
  ),
  uniqueIndex("uniq_weekly_push_idempotency_key").on(table.idempotencyKey),
]);

// One row per recipient per run; the worker updates each row as it sends.
export const weeklyPushRecipients = pgTable("weekly_push_recipients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull().references(() => weeklyPushRuns.id, { onDelete: 'cascade' }),
  recipientType: varchar("recipient_type").notNull(), // 'coach' (future: 'group')
  recipientId: varchar("recipient_id"), // coachUsers.id when known
  recipientName: varchar("recipient_name").notNull(),
  lineUserId: varchar("line_user_id"), // null when coach has no LINE binding
  status: varchar("status").notNull(), // pending|success|failed|skipped
  deliveryKey: varchar("delivery_key").notNull(),
  lineRetryKey: varchar("line_retry_key").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  nextRetryAt: timestamp("next_retry_at"),
  sentAt: timestamp("sent_at"),
  lineResponseCode: integer("line_response_code"),
  errorCode: varchar("error_code"),
  errorMessage: text("error_message"),
  payloadJson: jsonb("payload_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_weekly_push_recipients_run").on(table.runId),
  index("idx_weekly_push_recipients_status").on(table.runId, table.status),
  uniqueIndex("uniq_weekly_push_recipient_delivery_key").on(table.deliveryKey),
]);

export type WeeklyPushRun = typeof weeklyPushRuns.$inferSelect;
export type InsertWeeklyPushRun = typeof weeklyPushRuns.$inferInsert;
export type WeeklyPushRecipient = typeof weeklyPushRecipients.$inferSelect;
export type InsertWeeklyPushRecipient = typeof weeklyPushRecipients.$inferInsert;

export const weeklyPushOutbox = pgTable("weekly_push_outbox", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull().references(() => weeklyPushRuns.id, { onDelete: "cascade" }),
  queueName: varchar("queue_name").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  status: varchar("status").notNull().default("pending"), // pending|published|failed
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("uniq_weekly_push_outbox_run").on(table.runId),
  index("idx_weekly_push_outbox_pending").on(table.status, table.nextAttemptAt),
]);

export type WeeklyPushOutbox = typeof weeklyPushOutbox.$inferSelect;

export const lineNotifyLogs = pgTable("line_notify_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  coachName: varchar("coach_name").notNull(),
  lineId: varchar("line_id"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  content: text("content").notNull(),
  notifyType: varchar("notify_type").notNull(), // 'weekly' | 'daily' | 'manual'
  scheduleDate: date("schedule_date").notNull(), // the date the notified classes are on
}, (table) => [
  uniqueIndex("uniq_daily_notify").on(table.coachName, table.notifyType, table.scheduleDate),
]);

// 教練前台 session 持久化（伺服器重啟不需重新登入）
export const coachPortalSessions = pgTable("coach_portal_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  token: varchar("token").notNull().unique("coach_portal_sessions_token_key"),
  coachUserId: varchar("coach_user_id").notNull(),
  lineId: varchar("line_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_coach_portal_sessions_coach_user_id").on(table.coachUserId),
  index("idx_coach_portal_sessions_expires_at").on(table.expiresAt),
]);

export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  venue: one(venues, {
    fields: [schedules.venueId],
    references: [venues.id],
  }),
  timeSlot: one(timeSlots, {
    fields: [schedules.timeSlotId],
    references: [timeSlots.id],
  }),
  coachRegistrations: many(coachRegistrations),
  teacherFeedbacks: many(teacherFeedbacks),
}));

export const coachRegistrationsRelations = relations(coachRegistrations, ({ one }) => ({
  schedule: one(schedules, {
    fields: [coachRegistrations.scheduleId],
    references: [schedules.id],
  }),
}));

export const coachUsersRelations = relations(coachUsers, ({ many }) => ({
}));

export const venuesRelations = relations(venues, ({ many }) => ({
  schedules: many(schedules),
}));

export const timeSlotsRelations = relations(timeSlots, ({ many }) => ({
  schedules: many(schedules),
}));

export const teachersRelations = relations(teachers, ({ many }) => ({
  feedbacks: many(teacherFeedbacks),
}));

export const teacherFeedbacksRelations = relations(teacherFeedbacks, ({ one }) => ({
  schedule: one(schedules, {
    fields: [teacherFeedbacks.scheduleId],
    references: [schedules.id],
  }),
}));

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type InsertVenue = typeof venues.$inferInsert;
export type Venue = typeof venues.$inferSelect;
export type InsertTimeSlot = typeof timeSlots.$inferInsert;
export type TimeSlot = typeof timeSlots.$inferSelect;
export type InsertSchedule = typeof schedules.$inferInsert;
export type Schedule = typeof schedules.$inferSelect;
export type InsertCoachRegistration = typeof coachRegistrations.$inferInsert;
export type CoachRegistration = typeof coachRegistrations.$inferSelect;
export type InsertTeacher = typeof teachers.$inferInsert;
export type Teacher = typeof teachers.$inferSelect;
export type InsertTeacherFeedback = typeof teacherFeedbacks.$inferInsert;
export type TeacherFeedback = typeof teacherFeedbacks.$inferSelect;
export type TeacherAccessToken = typeof teacherAccessTokens.$inferSelect;
export type TeacherAccessAuditLog = typeof teacherAccessAuditLogs.$inferSelect;
export type CoachUser = typeof coachUsers.$inferSelect;
export type InsertCoachUser = typeof coachUsers.$inferInsert;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type VenueInfo = typeof venueInfos.$inferSelect;
export type InsertVenueInfo = typeof venueInfos.$inferInsert;

export const insertScheduleSchema = createInsertSchema(schedules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCoachRegistrationSchema = createInsertSchema(coachRegistrations).omit({
  id: true,
  registeredAt: true,
});

export const insertTeacherFeedbackSchema = createInsertSchema(teacherFeedbacks).omit({
  id: true,
  updatedAt: true,
});

export const insertCoachUserSchema = createInsertSchema(coachUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertScheduleType = z.infer<typeof insertScheduleSchema>;
export type InsertUserType = z.infer<typeof insertUserSchema>;
export type InsertCoachRegistrationType = z.infer<typeof insertCoachRegistrationSchema>;
export type InsertTeacherFeedbackType = z.infer<typeof insertTeacherFeedbackSchema>;
export type InsertCoachUserType = z.infer<typeof insertCoachUserSchema>;

export type CoachAvailability = typeof coachAvailability.$inferSelect;
export type InsertCoachAvailability = typeof coachAvailability.$inferInsert;
export type CoachVenuePreference = typeof coachVenuePreferences.$inferSelect;
export type LineNotifyLog = typeof lineNotifyLogs.$inferSelect;
export type InsertLineNotifyLog = typeof lineNotifyLogs.$inferInsert;
