-- Batch 2 public schema (Issues #8, #3, #1). Additive only: no drops, renames or type changes.
-- Old code keeps working: new columns have defaults and new tables are unused until
-- the matching code ships. Apply to the development database; Publish carries it to
-- production. Take a production restore point before publishing.
BEGIN;
SET LOCAL search_path TO public;

-- #8 optimistic concurrency: every schedule write bumps the version.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
-- School schemas (school_*) are not migrated by Publish (it diffs only public);
-- the app adds this column to them at startup, like their other columns.

-- #3 operation timeline, written in the same transaction as the business change.
CREATE TABLE IF NOT EXISTS operation_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  request_id text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  reason text
);
CREATE INDEX IF NOT EXISTS operation_audit_entity_idx ON operation_audit (entity, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS operation_audit_occurred_idx ON operation_audit (occurred_at);

-- #1 persistent Ragic sync runs and their failed items.
CREATE TABLE IF NOT EXISTS ragic_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  error_code text
);
CREATE INDEX IF NOT EXISTS ragic_sync_runs_started_idx ON ragic_sync_runs (started_at);
CREATE TABLE IF NOT EXISTS ragic_sync_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ragic_sync_runs (id) ON DELETE CASCADE,
  kind text NOT NULL,
  source_id text NOT NULL,
  status text NOT NULL,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ragic_sync_items_run_idx ON ragic_sync_items (run_id);

COMMIT;
