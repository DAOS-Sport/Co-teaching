import { z } from "zod";

/** JSON calendar date, YYYY-MM-DD; never a JavaScript Date instance. */
export type DateOnly = string;
/** Timestamp as serialized in an HTTP JSON response. */
export type JsonTimestamp = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date");

export const jsonTimestampSchema = z.string().datetime({ offset: true });
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema),
]));
