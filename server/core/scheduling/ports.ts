import type {
  AssignmentContext, AssignmentContextQuery, ConfirmationContext,
  ScheduleAuditEntry, SchedulePatch, ScheduleRow,
} from "./entities";

export interface ScheduleMutationRepository {
  getById(id: string): Promise<ScheduleRow | undefined>;
  loadAssignmentContext(query: AssignmentContextQuery): Promise<AssignmentContext>;
  /** Atomic compare-and-write; throw ScheduleMutationError(VERSION_CONFLICT) on a lost CAS. */
  update(id: string, patch: SchedulePatch, expectedVersion: number): Promise<ScheduleRow>;
}

export interface UnitOfWork {
  /** Repository, locks and audit participate in this same transaction. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface ScheduleLocks {
  /** Transaction-scoped locks. Core supplies unique keys in deterministic order. */
  acquire(keys: readonly string[]): Promise<void>;
}

export interface ScheduleAudit {
  record(entry: ScheduleAuditEntry): Promise<void>;
}

export interface ScheduleConfirmation {
  issue(context: ConfirmationContext): string | Promise<string>;
  verify(token: string, context: ConfirmationContext): boolean | Promise<boolean>;
}

export interface ScheduleUseCaseDependencies {
  repository: ScheduleMutationRepository;
  unitOfWork: UnitOfWork;
  locks: ScheduleLocks;
  audit: ScheduleAudit;
  confirmation: ScheduleConfirmation;
}
