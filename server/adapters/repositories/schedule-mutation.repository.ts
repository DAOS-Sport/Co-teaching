import { ScheduleMutationError, type AssignmentContextQuery, type AssignmentContext,
  type AvailabilityRow, type SchedulePatch, type ScheduleRow, type TimeSlotRow } from "../../core/scheduling/entities";
import type { ScheduleMutationRepository } from "../../core/scheduling/ports";

/** The adapter accepts capabilities, not a concrete Drizzle implementation. */
export interface ScheduleMutationStorage {
  getScheduleById(id: string): Promise<ScheduleRow | undefined>;
  getSchedulesByDate(date: string): Promise<(ScheduleRow & { venue?: { name?: string | null } | null })[]>;
  getTimeSlots(): Promise<TimeSlotRow[]>;
  getCoachAvailabilityByWeek(weekStart: string): Promise<AvailabilityRow[]>;
  updateSchedule(id: string, patch: SchedulePatch, expectedVersion?: number): Promise<ScheduleRow>;
}

export class StorageScheduleMutationRepository implements ScheduleMutationRepository {
  constructor(private readonly storage: ScheduleMutationStorage) {}
  getById(id: string) { return this.storage.getScheduleById(id); }
  async loadAssignmentContext(query: AssignmentContextQuery): Promise<AssignmentContext> {
    const [sameDaySchedules, timeSlots, weekAvailability] = await Promise.all([
      this.storage.getSchedulesByDate(query.date), this.storage.getTimeSlots(),
      this.storage.getCoachAvailabilityByWeek(query.weekStart),
    ]);
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
