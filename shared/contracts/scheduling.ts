import { z } from "zod";
import { dateOnlySchema, jsonTimestampSchema, type DateOnly, type JsonTimestamp } from "./primitives";

export interface VenueDto {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface TimeSlotDto {
  id: string;
  period: string;
  startTime: string;
  endTime: string;
  order: number;
}

/** Full schedule JSON row. Nullable DB values remain required, nullable fields. */
export interface ScheduleDto {
  id: string;
  date: DateOnly;
  venueId: string;
  timeSlotId: string;
  className: string | null;
  coachName: string | null;
  coachName2: string | null;
  coach1IsTeaching: boolean;
  coach2IsTeaching: boolean;
  coachCount: number;
  isClassLocked: boolean;
  notes: string | null;
  createdAt: JsonTimestamp | null;
  updatedAt: JsonTimestamp | null;
  version: number;
}

export interface ScheduleWithRelationsDto extends ScheduleDto {
  venue: VenueDto;
  timeSlot: TimeSlotDto;
}

export interface VenueInfoDto {
  id: string;
  venueName: string;
  videoUrl: string | null;
  description: string | null;
  mapUrl: string | null;
  updatedAt: JsonTimestamp | null;
}

export interface CoachAvailabilityDto {
  id: string;
  coachName: string;
  weekStart: DateOnly;
  dayOfWeek: number;
  timeSlotOrder: number;
  createdAt: JsonTimestamp | null;
}

export interface TeacherFeedbackDto {
  id: string;
  scheduleId: string;
  teacherId: string | null;
  teacherName: string;
  status: string;
  rescheduleDate: DateOnly | null;
  reschedulePeriod: string | null;
  comment: string | null;
  updatedAt: JsonTimestamp | null;
}

// Passthrough preserves additional response fields; these parsers never strip
// transport extensions or turn wire timestamps into Date objects.
export const venueDtoSchema = z.object({
  id: z.string(), name: z.string(), color: z.string(), order: z.number().int(),
}).passthrough() satisfies z.ZodType<VenueDto>;

export const timeSlotDtoSchema = z.object({
  id: z.string(), period: z.string(), startTime: z.string(), endTime: z.string(), order: z.number().int(),
}).passthrough() satisfies z.ZodType<TimeSlotDto>;

export const scheduleDtoSchema = z.object({
  id: z.string(), date: dateOnlySchema, venueId: z.string(), timeSlotId: z.string(),
  className: z.string().nullable(), coachName: z.string().nullable(), coachName2: z.string().nullable(),
  coach1IsTeaching: z.boolean(), coach2IsTeaching: z.boolean(), coachCount: z.number().int(),
  isClassLocked: z.boolean(), notes: z.string().nullable(),
  createdAt: jsonTimestampSchema.nullable(), updatedAt: jsonTimestampSchema.nullable(), version: z.number().int(),
}).passthrough() satisfies z.ZodType<ScheduleDto>;

export const scheduleWithRelationsDtoSchema = scheduleDtoSchema.extend({
  venue: venueDtoSchema, timeSlot: timeSlotDtoSchema,
}).passthrough() satisfies z.ZodType<ScheduleWithRelationsDto>;

export const venueInfoDtoSchema = z.object({
  id: z.string(), venueName: z.string(), videoUrl: z.string().nullable(), description: z.string().nullable(),
  mapUrl: z.string().nullable(), updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<VenueInfoDto>;

export const coachAvailabilityDtoSchema = z.object({
  id: z.string(), coachName: z.string(), weekStart: dateOnlySchema, dayOfWeek: z.number().int(),
  timeSlotOrder: z.number().int(), createdAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<CoachAvailabilityDto>;

export const teacherFeedbackDtoSchema = z.object({
  id: z.string(), scheduleId: z.string(), teacherId: z.string().nullable(), teacherName: z.string(), status: z.string(),
  rescheduleDate: dateOnlySchema.nullable(), reschedulePeriod: z.string().nullable(), comment: z.string().nullable(),
  updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<TeacherFeedbackDto>;
