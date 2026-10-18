import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ScheduleMutationError, type AssignmentContext, type AvailabilityRow,
  type ConfirmationContext, type ScheduleAuditEntry, type ScheduleMutationErrorCode,
  type ScheduleMutationInput, type SchedulePatch, type ScheduleRow,
} from "./core/scheduling/entities";
import type { ScheduleUseCaseDependencies } from "./core/scheduling/ports";
import { createScheduleUseCases } from "./core/scheduling/use-cases";
import { placementLockKeys } from "./core/scheduling/policies";

const fixture = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "s1", date: "2026-10-19", venueId: "v1", timeSlotId: "t1", className: "Class-A",
  coachName: null, coachName2: null, coach1IsTeaching: true, coach2IsTeaching: false,
  coachCount: 2, isClassLocked: false, notes: "keep", createdAt: null, updatedAt: null, version: 1,
  ...overrides,
});

interface Transaction {
  writes: Map<string, ScheduleRow>;
  audits: ScheduleAuditEntry[];
  releases: (() => void)[];
}

/** Transaction/lock stand-in only. It is not PostgreSQL atomicity evidence. */
function harness(initial: ScheduleRow[] = [fixture()]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const auditEntries: ScheduleAuditEntry[] = [];
  const events: string[] = [];
  const contextStore = new AsyncLocalStorage<Transaction>();
  const lockTails = new Map<string, Promise<void>>();
  const tokens = new Map<string, string>();
  const state = {
    availability: [] as AvailabilityRow[],
    auditFailure: false,
    beforeUpdate: undefined as (() => void) | undefined,
    loadContext: undefined as (() => void) | undefined,
    issuedContexts: [] as ConfirmationContext[],
  };
  let tokenSequence = 0;
  const tx = (): Transaction => {
    const current = contextStore.getStore();
    assert.ok(current, "port called outside UnitOfWork");
    return current;
  };
  const deps: ScheduleUseCaseDependencies = {
    unitOfWork: {
      async run(work) {
        const current: Transaction = { writes: new Map(), audits: [], releases: [] };
        return contextStore.run(current, async () => {
          events.push("begin");
          try {
            const result = await work();
            for (const [id, row] of current.writes) rows.set(id, row);
            auditEntries.push(...current.audits);
            events.push("commit");
            return result;
          } catch (error) {
            events.push("rollback");
            throw error;
          } finally {
            for (const release of current.releases.reverse()) release();
          }
        });
      },
    },
    locks: {
      async acquire(keys) {
        const current = tx();
        assert.deepEqual([...keys], [...new Set(keys)].sort(), "locks must be unique and sorted");
        for (const key of keys) {
          const prior = lockTails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          lockTails.set(key, held);
          await prior;
          events.push(`lock:${key}`);
          current.releases.push(() => {
            release();
            if (lockTails.get(key) === held) lockTails.delete(key);
          });
        }
      },
    },
    repository: {
      async getById(id) {
        events.push(`read:${id}`);
        const row = tx().writes.get(id) ?? rows.get(id);
        return row ? { ...row } : undefined;
      },
      async loadAssignmentContext(query): Promise<AssignmentContext> {
        tx();
        events.push("context");
        state.loadContext?.();
        return {
          sameDaySchedules: [...rows.values()].filter((row) => row.date === query.date)
            .map((row) => ({ ...row, venue: { name: `Venue-${row.venueId}` } })),
          timeSlots: [{ id: "t1", order: 1 }, { id: "t2", order: 2 }],
          weekAvailability: state.availability.map((slot) => ({ ...slot })),
        };
      },
      async update(id, patch, expectedVersion) {
        const current = tx();
        events.push("update");
        state.beforeUpdate?.();
        const before = rows.get(id);
        if (!before || before.version !== expectedVersion) throw new ScheduleMutationError("VERSION_CONFLICT");
        const updated = { ...before, ...patch, version: before.version + 1 };
        current.writes.set(id, updated);
        return { ...updated };
      },
    },
    audit: {
      async record(entry) {
        events.push("audit");
        if (state.auditFailure) throw new Error("synthetic audit failure");
        tx().audits.push(entry);
      },
    },
    confirmation: {
      issue(context) {
        state.issuedContexts.push(context);
        const token = `test-token-${++tokenSequence}`;
        tokens.set(token, JSON.stringify(context));
        return token;
      },
      verify(token, context) { return tokens.get(token) === JSON.stringify(context); },
    },
  };
  return { rows, auditEntries, events, state, deps, cases: createScheduleUseCases(deps), lockTails };
}

const input = (patch: SchedulePatch = { coachName: "Coach-A" }, extra: Partial<ScheduleMutationInput> = {}): ScheduleMutationInput => ({
  scheduleId: "s1", expectedVersion: 1, patch,
  auditContext: { actor: "test-admin", requestId: "request-a", reason: "synthetic" }, ...extra,
});

async function failure(work: () => Promise<unknown>, code: ScheduleMutationErrorCode) {
  try { await work(); } catch (error) {
    assert.ok(error instanceof ScheduleMutationError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected ${code}`);
}

const conflict = (overrides: Partial<ScheduleRow> = {}) => fixture({
  id: "s2", venueId: "v2", coachName: "Coach-A", ...overrides,
});

test("missing or invalid versions refuse all writes for both entry use cases", async () => {
  for (const name of ["updateSchedule", "assignCoach"] as const) {
    for (const version of [undefined, null, 0, -1, 1.5, NaN, Infinity]) {
      const h = harness();
      await failure(() => h.cases[name](input({}, { expectedVersion: version })), "VERSION_REQUIRED");
      assert.equal(h.rows.get("s1")?.version, 1);
      assert.equal(h.events.includes("update"), false);
      assert.equal(h.auditEntries.length, 0);
    }
  }
});

test("stale version refuses update before warning queries", async () => {
  const h = harness([fixture({ version: 2 })]);
  await failure(() => h.cases.updateSchedule(input()), "VERSION_CONFLICT");
  assert.equal(h.events.includes("context"), false);
  assert.equal(h.events.includes("update"), false);
});

test("missing schedule reports the domain not-found code", async () => {
  const h = harness([]);
  await failure(() => h.cases.updateSchedule(input()), "SCHEDULE_NOT_FOUND");
  assert.equal(h.events.includes("update"), false);
});

test("unconfirmed warnings return current warnings and token with no write", async () => {
  const h = harness([fixture(), conflict()]);
  const error = await failure(() => h.cases.assignCoach(input()), "CONFIRM_REQUIRED");
  assert.deepEqual(error.warnings?.map((warning) => warning.code), ["COACH_CONFLICT"]);
  assert.ok(error.confirmationToken);
  assert.equal(h.rows.get("s1")?.coachName, null);
  assert.equal(h.events.includes("update"), false);
});

test("warning codes alone cannot authorize a write", async () => {
  const h = harness([fixture(), conflict()]);
  await failure(() => h.cases.updateSchedule(input(undefined, { confirmWarnings: ["COACH_CONFLICT"] })), "CONFIRM_REQUIRED");
  assert.equal(h.events.includes("update"), false);
});

test("valid token plus all current warning codes permits exactly one CAS and audit", async () => {
  const h = harness([fixture(), conflict()]);
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  const saved = await h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  }));
  assert.equal(saved.coachName, "Coach-A");
  assert.equal(saved.version, 2);
  assert.equal(h.auditEntries.length, 1);
  assert.equal(h.auditEntries[0].before.coachName, null);
  assert.equal(h.auditEntries[0].after.coachName, "Coach-A");
  assert.equal(h.auditEntries[0].kind, "updateSchedule");
  assert.equal(h.events.filter((event) => event === "update").length, 1);
});

test("changed conflict dependency invalidates an old token despite the same warning code", async () => {
  const h = harness([fixture(), conflict()]);
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  h.rows.set("s2", conflict({ className: "Changed-Class", version: 2 }));
  const next = await failure(() => h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  })), "CONFIRM_REQUIRED");
  assert.notEqual(next.confirmationToken, first.confirmationToken);
  assert.match(next.warnings?.[0].message ?? "", /Changed-Class/);
  assert.equal(h.events.includes("update"), false);
});

test("changed availability invalidates a token, even when unavailability warning remains", async () => {
  const h = harness();
  h.state.availability = [{ coachName: "Coach-A", dayOfWeek: 2, timeSlotOrder: 1 }];
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  h.state.availability = [{ coachName: "Coach-A", dayOfWeek: 3, timeSlotOrder: 1 }];
  await failure(() => h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_UNAVAILABLE"], confirmationToken: first.confirmationToken,
  })), "CONFIRM_REQUIRED");
  assert.equal(h.events.includes("update"), false);
});

test("mutation and operation kind are bound to confirmation", async () => {
  const h = harness([fixture(), conflict()]);
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  const confirmed = { confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken };
  await failure(() => h.cases.updateSchedule(input({ coachName: "Coach-A", notes: "different" }, confirmed)), "CONFIRM_REQUIRED");
  await failure(() => h.cases.assignCoach(input(undefined, confirmed)), "CONFIRM_REQUIRED");
  assert.equal(h.events.includes("update"), false);
});

test("stale token does not write when the old conflict has disappeared", async () => {
  const h = harness([fixture(), conflict()]);
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  h.rows.delete("s2");
  const next = await failure(() => h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  })), "CONFIRM_REQUIRED");
  assert.deepEqual(next.warnings, []);
  assert.equal(h.events.includes("update"), false);
});

test("all warning codes are required even with a valid token", async () => {
  const h = harness([fixture(), conflict()]);
  h.state.availability = [{ coachName: "Coach-A", dayOfWeek: 2, timeSlotOrder: 1 }];
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  assert.equal(first.warnings?.length, 2);
  await failure(() => h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  })), "CONFIRM_REQUIRED");
  assert.equal(h.events.includes("update"), false);
});

test("locked schedules permit coach assignment and teaching flags but refuse changed class name", async () => {
  const h = harness([fixture({ isClassLocked: true })]);
  const saved = await h.cases.assignCoach(input({ coachName: "Coach-A", coach1IsTeaching: false }));
  assert.equal(saved.coachName, "Coach-A");
  assert.equal(saved.coach1IsTeaching, false);
  const other = harness([fixture({ isClassLocked: true })]);
  await failure(() => other.cases.updateSchedule(input({ className: "Changed", isClassLocked: false })), "SCHEDULE_LOCKED");
  assert.equal(other.events.includes("update"), false);
});

test("duplicate coaches use canonical names and never write", async () => {
  const h = harness([fixture({ coachName: "Coach-A" })]);
  await failure(() => h.cases.assignCoach(input({ coachName2: " c o a c h - a " })), "DUPLICATE_COACH");
  assert.equal(h.events.includes("update"), false);
});

test("clearing slot one promotes slot two and preserves its teaching flag", async () => {
  const h = harness([fixture({ coachName: "Coach-A", coachName2: "Coach-B", coach1IsTeaching: true, coach2IsTeaching: false })]);
  const saved = await h.cases.assignCoach(input({ coachName: null }));
  assert.equal(saved.coachName, "Coach-B");
  assert.equal(saved.coachName2, null);
  assert.equal(saved.coach1IsTeaching, false);
  assert.equal(saved.coach2IsTeaching, false);
});

test("undefined preserves fields while explicit null clears nullable fields", async () => {
  const h = harness([fixture({ coachName: "Coach-A" })]);
  const saved = await h.cases.updateSchedule(input({ coachName: undefined, className: undefined, notes: null }));
  assert.equal(saved.coachName, "Coach-A");
  assert.equal(saved.className, "Class-A");
  assert.equal(saved.notes, null);
  const patch = h.auditEntries[0].after;
  assert.equal(patch.coachName, "Coach-A");
});

test("same-venue rows and entirely absent week availability do not warn", async () => {
  const h = harness([fixture(), conflict({ venueId: "v1" })]);
  const saved = await h.cases.updateSchedule(input());
  assert.equal(saved.version, 2);
});

test("moving an unchanged coach to a different date or slot rechecks target warnings", async () => {
  for (const patch of [{ date: "2026-10-20" }, { timeSlotId: "t2" }, { venueId: "v3" }]) {
    const h = harness([fixture({ coachName: "Coach-A" }), conflict({ ...patch, venueId: "v2" })]);
    await failure(() => h.cases.updateSchedule(input(patch)), "CONFIRM_REQUIRED");
    assert.equal(h.events.includes("update"), false);
  }
});

test("transaction takes schedule lock before re-read and sorted old/new placement locks before context", async () => {
  const before = fixture({ coachName: "Coach-Z", date: "2026-10-20" });
  const h = harness([before]);
  await h.cases.updateSchedule(input({ coachName: "Coach-A", date: "2026-10-19", timeSlotId: "t2" }));
  assert.equal(h.events[0], "begin");
  assert.match(h.events[1], /^lock:schedule:/);
  assert.equal(h.events[2], "read:s1");
  const expectedKeys = placementLockKeys(before, { ...before, coachName: "Coach-A", date: "2026-10-19", timeSlotId: "t2" });
  assert.deepEqual(h.events.slice(3, 3 + expectedKeys.length), expectedKeys.map((key) => `lock:${key}`));
  assert.equal(h.events[3 + expectedKeys.length], "context");
  assert.ok(h.events.indexOf("context") < h.events.indexOf("update"));
  assert.ok(h.events.indexOf("update") < h.events.indexOf("audit"));
  assert.equal(h.events.at(-1), "commit");
  assert.equal(h.lockTails.size, 0);
});

test("warning context is loaded after acquiring the placement lock", async () => {
  const h = harness();
  const originalAcquire = h.deps.locks.acquire;
  h.deps.locks.acquire = async (keys) => {
    await originalAcquire(keys);
    if (keys.some((key) => key.startsWith("schedule-coach:"))) h.rows.set("s2", conflict());
  };
  await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  assert.equal(h.events.includes("update"), false);
});

test("audit failure rolls back the stand-in transaction and propagates unchanged", async () => {
  const h = harness();
  h.state.auditFailure = true;
  await assert.rejects(() => h.cases.updateSchedule(input()), /synthetic audit failure/);
  assert.equal(h.rows.get("s1")?.version, 1);
  assert.equal(h.rows.get("s1")?.coachName, null);
  assert.equal(h.auditEntries.length, 0);
  assert.equal(h.lockTails.size, 0);
});

test("repository compare-and-write remains the final version barrier", async () => {
  const h = harness();
  h.state.beforeUpdate = () => { h.rows.set("s1", fixture({ version: 2, notes: "other writer" })); };
  await failure(() => h.cases.updateSchedule(input()), "VERSION_CONFLICT");
  assert.equal(h.rows.get("s1")?.notes, "other writer");
  assert.equal(h.auditEntries.length, 0);
});

test("two schedules assigning the same canonical coach serialize, so later one sees the committed conflict", async () => {
  const h = harness([fixture(), fixture({ id: "s2", venueId: "v2" })]);
  const results = await Promise.allSettled([
    h.cases.assignCoach(input()),
    h.cases.assignCoach(input({ coachName: " coach-a " }, { scheduleId: "s2" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ScheduleMutationError);
  assert.equal(rejected.reason.code, "CONFIRM_REQUIRED");
  assert.equal([...h.rows.values()].filter((row) => row.coachName !== null).length, 1);
  assert.equal(h.auditEntries.length, 1);
  assert.equal(h.lockTails.size, 0);
});

test("confirmation canonicalizes patch keys and relevant row ordering", async () => {
  const h = harness([fixture(), conflict(), conflict({ id: "s3", venueId: "v3" })]);
  const first = await failure(() => h.cases.updateSchedule(input({ coachName: "Coach-A", notes: "same" })), "CONFIRM_REQUIRED");
  const s2 = h.rows.get("s2")!;
  h.rows.delete("s2"); h.rows.set("s2", s2);
  const saved = await h.cases.updateSchedule(input({ notes: "same", coachName: "Coach-A", className: undefined }, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  }));
  assert.equal(saved.version, 2);
});

test("irrelevant rows do not invalidate a confirmation token", async () => {
  const h = harness([fixture(), conflict()]);
  const first = await failure(() => h.cases.updateSchedule(input()), "CONFIRM_REQUIRED");
  h.rows.set("unrelated", fixture({ id: "unrelated", venueId: "v5", coachName: "Coach-Unrelated" }));
  const saved = await h.cases.updateSchedule(input(undefined, {
    confirmWarnings: ["COACH_CONFLICT"], confirmationToken: first.confirmationToken,
  }));
  assert.equal(saved.version, 2);
});
