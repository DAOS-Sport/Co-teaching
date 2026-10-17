# B05: explicit notification runtime

Normal `npm run dev` and `npm start` remain web-only. They do not start workers,
cron, schema repair, seeds or data cleanup. `server/notification-app.ts` is a
separate, deliberate operational entry; importing the HTTP application does not
select it. No new package or lockfile change is required.

## Deployment contract

Use a reviewed, always-on deployment for the long-lived entry. Replit Autoscale
can stop when idle. Setting an environment variable does not provision an
always-on machine or constitute approval for its cost. An external wakeup design
requires a separate reviewed entry; the command below is not that design.

```sh
NOTIFICATION_RUNTIME_MODE=always-on \
ENABLE_WEEKLY_PUSH_QUEUE=1 ENABLE_WEEKLY_PUSH_WORKER=1 \
npm run start:notifications
```

Keep the existing credential sources. Do not put connection strings, tokens,
destinations or personal data in commands, receipts or this specification.
The normal build produces both `dist/index.js` and `dist/notification-app.js`.

Before loading HTTP or workers, validate the explicit flags, cron and timezone,
then check the existing database in one READ ONLY transaction. The notification
contract covers the app tables and installed pg-boss 10.4.2/schema v24 columns,
types, nullability, enum, queue functions, partitioned job parent and immediate
unique indexes. Missing structures cause refusal, never automatic repair.

New database objects require the separately reviewed and approved manual SQL.
`migrate:false` alone is insufficient: pg-boss creates queue partitions and
updates operational metadata. The current runtime has nine queue partitions,
including its internal timekeeper queue and the existing report/cleanup queues.
Queue creation is explicitly within the operational scope, not a business data
migration. No report cleanup schedule is enabled by this entry.

HTTP and workers run in the same process, so administrative readiness reflects
the actual local worker registration. A second process must not be substituted
without changing that readiness contract. pg-boss coordinates cron ownership and
job claims in PostgreSQL; it does not guarantee notification delivery when no
executor is running.

## Effective schedules and lifecycle

| Purpose | Cron | Timezone |
| --- | --- | --- |
| Weekly notification | `0 12 * * 0` | `Asia/Taipei` |
| Tomorrow reminder | `0 19 * * *` | `Asia/Taipei` |
| Durable notification reconciliation | `*/5 * * * *` | `Asia/Taipei` |

These preserve the observed legacy notification times. A deliberate
`WEEKLY_PUSH_CRON`/`WEEKLY_PUSH_TIMEZONE` override must pass validation before
workers start. The entry also preserves the independently configured Ragic
03:00 Taipei schedule when its existing flag is enabled, using only the future
daily schedule. It never calls the legacy boot-sync timer or startup repairs.

Completed and failed pg-boss jobs are archived after seven days; archive deletion
is seven days. This policy concerns new queue metadata. Business notification
logs and report cleanup are outside the scheduled cleanup scope.

SIGTERM/SIGINT handlers exist during initialization. Abort prevents later
initialization stages; an in-progress operation must finish before scoped
schedule restoration and draining. A 35-second deadline bounds shutdown. Failure
does not report readiness, and only known static error codes reach startup logs.
An ordinary stop drains workers and closes HTTP/Ragic scheduling while retaining
durable schedule definitions for restart. It does not cancel jobs already queued
or undo platform-accepted deliveries.

## Cutover and rollback evidence

1. Freshly identify the actual deployment, source, flags, database and installed
   queue version. Preview and production are separate targets.
2. Inventory existing jobs, schedules, runs and unknown deliveries without
   starting pg-boss. Preserve original schema and data fingerprints.
3. Rehearse the exact manual SQL and guards in an isolated PG16 database.
   Positive rollback and activity-refusal cases use separate fixtures; preserve
   the activity record. Use a fresh psql connection and stop on first error.
4. Apply only the approved additive SQL, then independently compare all existing
   rows, original columns and sequences. Do not backfill legacy LINE identities.
5. Resolve the hosting/wakeup contract before switching. Choose a maintenance
   window away from a due trigger, stop every old weekly manual/cron writer,
   wait for its in-flight operations to finish and verify old deployment termination, then
   confirm one active notification mechanism and actual authenticated readiness.
   Do not leave the web-only candidate as an unnoticed notification replacement.
6. Verify actual schedule rows, worker processing/restart, and source/bundle
   identity. Separate isolated tests, actual database reads, deployment and real
   platform acceptance. A dry run must not send LINE or satisfy the live weekly
   watchdog. A real test message requires its own authorization.

New wet weekly runs refuse any legacy weekly notification log in the entire
requested date window before generating a new durable identity. An existing
durable idempotency key is reused with its saved state, including unknown results.
Scheduled coach names that match multiple eligible accounts cause an explicit
conflict response. Historical dry-run previews remain available, with zero
recipient/group LINE requests and zero live weekly watchdog pings.

The legacy-history check and new-run transaction are not atomic with the old
application's independent writer. This guard requires the old writer to be
quiescent; it cannot establish safe ownership while an old manual request or
cron is still in flight. Removing a schedule definition alone is insufficient.
Preserve the termination and in-flight evidence as a cutover prerequisite.

Before any new activity, the guarded app-only rollback can remove only the new
empty structures. After activity, retain the schema, identities and history;
restore only the three owned schedule scopes and drain the known workers. Never
delete jobs or logs to manufacture an empty rollback precondition. Do not restart
the old unsafe web boot as a recovery shortcut. If legacy/new ownership or an
unknown delivery cannot be reconciled, stop the affected branch and report the
specific unresolved state.

## Validation

`npm test`, `npm run check`, architecture/contract gates and `npm run build`
include the explicit entry's regressions. `npm run test:pg` requires its existing
double opt-in for a task-owned loopback PG database. The catalog `name[]` driver
case has a real PostgreSQL regression: preflight requests `enumlabel::text` so
valid state labels are returned as an array.

Functional acceptance additionally exercises the source and compiled entries,
authenticated HTTP readiness, persistent schedule rows, real OS signals,
startup cancellation, no unexpected outbound delivery and preserved data.
Catalog/process stubs and an isolated OIDC/transport fixture are evidence only
for their stated scope. They do not complete production cutover.
