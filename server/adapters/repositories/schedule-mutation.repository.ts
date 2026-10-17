import { ScheduleMutationError, type AssignmentContextQuery, type AssignmentContext,
  type AvailabilityRow, type SchedulePatch, type ScheduleRow, type TimeSlotRow } from "../../core/scheduling/entities";
import type { ScheduleMutationRepository } from "../../core/scheduling/ports";
import type { ScheduleCreateValues } from "../../core/scheduling/create-schedule";

/** The adapter accepts capabilities, not a concrete Drizzle implementation. */
export interface ScheduleMutationStorage {
  getScheduleById(id: string): Promise<ScheduleRow | undefined>;
  getSchedulesByDate(date: string): Promise<(ScheduleRow & { venue?: { name?: string | null } | null })[]>;
  getTimeSlots(): Promise<TimeSlotRow[]>;
  getCoachAvailabilityByWeek(weekStart: string): Promise<AvailabilityRow[]>;
  updateSchedule(id: string, patch: SchedulePatch, expectedVersion?: number): Promise<ScheduleRow>;
  upsertSchedule(values: ScheduleCreateValues): Promise<ScheduleRow>;
}

export class StorageScheduleMutationRepository implements ScheduleMutationRepository {
  constructor(private readonly storage: ScheduleMutationStorage) {}
  getById(id: string) { return this.storage.getScheduleById(id); }
  create(values: ScheduleCreateValues) { return this.storage.upsertSchedule(values); }
  async loadAssignmentContext(query: AssignmentContextQuery): Promise<AssignmentContext> {
    const sameDaySchedules = await this.storage.getSchedulesByDate(query.date);
    const timeSlots = await this.storage.getTimeSlots();
    const weekAvailability = await this.storage.getCoachAvailabilityByWeek(query.weekStart);
    return { sameDaySchedules, timeSlots, weekAvailability };
  }
  async update(id: string, patch: SchedulePatch, expectedVersion: number): Promise<ScheduleRow> {
    try { return await this.storage.updateSchedule(id, patch, expectedVersion); }
    catch (error) {
      if (error instanceof Error && error.name === "ScheduleVersionConflictError") {
        throw new ScheduleMutationError("VERSION_CONFLICT");
      }
      throw error;
    }
  }
}
