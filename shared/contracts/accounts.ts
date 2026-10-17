import { z } from "zod";
import { jsonTimestampSchema, type JsonTimestamp } from "./primitives";

export interface UserDto {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  role: string;
  coachName: string | null;
  createdAt: JsonTimestamp | null;
  updatedAt: JsonTimestamp | null;
}

export interface CoachUserDto {
  id: string;
  lineId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  employeeId: string | null;
  status: string;
  role: string;
  linkedCoachName: string | null;
  createdAt: JsonTimestamp | null;
  updatedAt: JsonTimestamp | null;
}

// Status/role remain strings because the existing wire contract is open-ended.
export const userDtoSchema = z.object({
  id: z.string(), email: z.string().nullable(), firstName: z.string().nullable(), lastName: z.string().nullable(),
  profileImageUrl: z.string().nullable(), role: z.string(), coachName: z.string().nullable(),
  createdAt: jsonTimestampSchema.nullable(), updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<UserDto>;

export const coachUserDtoSchema = z.object({
  id: z.string(), lineId: z.string().nullable(), name: z.string(), phone: z.string().nullable(),
  email: z.string().nullable(), employeeId: z.string().nullable(), status: z.string(), role: z.string(),
  linkedCoachName: z.string().nullable(), createdAt: jsonTimestampSchema.nullable(), updatedAt: jsonTimestampSchema.nullable(),
}).passthrough() satisfies z.ZodType<CoachUserDto>;
