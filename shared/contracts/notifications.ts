import { z } from "zod";
import { dateOnlySchema, jsonTimestampSchema, jsonValueSchema, type DateOnly, type JsonTimestamp, type JsonValue } from "./primitives";

export interface WeeklyPushRunDto {
  id: string;
  pushType: string;
  weekStartDate: DateOnly;
  weekEndDate: DateOnly;
  triggerSource: string;
  destination: string;
  idempotencyKey: string;
  status: string;
  dryRun: boolean;
  startedAt: JsonTimestamp | null;
  completedAt: JsonTimestamp | null;
  totalCount: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  reportPath: string | null;
  errorMessage: string | null;
  createdAt: JsonTimestamp | null;
  updatedAt: JsonTimestamp | null;
}

export interface WeeklyPushRecipientDto {
  id: string;
  runId: string;
  recipientType: string;
  recipientId: string | null;
  recipientName: string;
  lineUserId: string | null;
  status: string;
  deliveryKey: string;
  lineRetryKey: string;
  attemptCount: number;
  startedAt: JsonTimestamp | null;
  completedAt: JsonTimestamp | null;
  nextRetryAt: JsonTimestamp | null;
  sentAt: JsonTimestamp | null;
  lineResponseCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  payloadJson: JsonValue;
  createdAt: JsonTimestamp | null;
  updatedAt: JsonTimestamp | null;
}

export interface WeeklyPushRunsResponseDto { runs: WeeklyPushRunDto[] }
export interface WeeklyPushRunDetailResponseDto { run: WeeklyPushRunDto; recipients: WeeklyPushRecipientDto[] }

export const weeklyPushRunDtoSchema = z.object({
  id: z.string(), pushType: z.string(), weekStartDate: dateOnlySchema, weekEndDate: dateOnlySchema,
  triggerSource: z.string(), destination: z.string(), idempotencyKey: z.string(), status: z.string(), dryRun: z.boolean(),
  startedAt: jsonTimestampSchema.nullable(), completedAt: jsonTimestampSchema.nullable(), totalCount: z.number().int(),
  successCount: z.number().int(), failureCount: z.number().int(), skippedCount: z.number().int(),
  reportPath: z.string().nullable(), errorMessage: z.string().nullable(),
  createdAt: jsonTimestampSchema.nullable(), updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<WeeklyPushRunDto>;

export const weeklyPushRecipientDtoSchema = z.object({
  id: z.string(), runId: z.string(), recipientType: z.string(), recipientId: z.string().nullable(), recipientName: z.string(),
  lineUserId: z.string().nullable(), status: z.string(), deliveryKey: z.string(), lineRetryKey: z.string(), attemptCount: z.number().int(),
  startedAt: jsonTimestampSchema.nullable(), completedAt: jsonTimestampSchema.nullable(), nextRetryAt: jsonTimestampSchema.nullable(),
  sentAt: jsonTimestampSchema.nullable(), lineResponseCode: z.number().int().nullable(), errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(), payloadJson: jsonValueSchema,
  createdAt: jsonTimestampSchema.nullable(), updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<WeeklyPushRecipientDto>;

export const weeklyPushRunsResponseDtoSchema = z.object({ runs: z.array(weeklyPushRunDtoSchema) }).passthrough() satisfies z.ZodType<WeeklyPushRunsResponseDto>;
export const weeklyPushRunDetailResponseDtoSchema = z.object({
  run: weeklyPushRunDtoSchema, recipients: z.array(weeklyPushRecipientDtoSchema),
}).passthrough() satisfies z.ZodType<WeeklyPushRunDetailResponseDto>;
