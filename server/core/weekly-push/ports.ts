import type {
  NewWeeklyRun, NewWeeklyRecipient, WeeklyCoach, WeeklyMessageItem, WeeklyRun, WeeklySchedule, WeekRange,
} from './entities';
export type { WeeklyRun } from './entities';

export interface WeeklyPushRepository<Run extends WeeklyRun> {
  findByKey(key: string): Promise<Run | null>;
  hasLegacyHistory(start: string, end: string): Promise<boolean>;
  /** All run/recipient rows and the orchestrator job must commit in one transaction. */
  createBundle(run: NewWeeklyRun, recipients: NewWeeklyRecipient[]): Promise<{ run: Run; created: boolean; recipientsCreated: number }>;
  getRun(id: string): Promise<Run | null>;
  failedRecipients(runId: string): Promise<{ id: string }[]>;
  resetRecipient(id: string): Promise<void>;
  markSending(runId: string): Promise<void>;
}
export interface WeeklyRecipientQueue {
  /** Participates in the active retry transaction; must reject on publish failure. */
  enqueueRecipient(runId: string, recipientId: string, manualRetry?: boolean): Promise<void>;
  flushCommitted(): Promise<void>;
}
export interface WeeklyPushDependencies<Run extends WeeklyRun> {
  repository: WeeklyPushRepository<Run>;
  roster: { approvedCoaches(): Promise<WeeklyCoach[]>; schedules(start: string, end: string): Promise<WeeklySchedule[]> };
  transaction: { run<T>(work: () => Promise<T>): Promise<T> };
  queue: WeeklyRecipientQueue;
  clock: { now(): number; defaultWeek(): WeekRange };
  newId(): string;
  message(name: string, items: WeeklyMessageItem[], start: string, end: string): string;
}
