-- Expands schema and replaces legacy name uniqueness. Review mapping and take
-- a database restore point before production; no identity rows are backfilled.
BEGIN;
SET LOCAL search_path TO public;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS coach_user_id varchar REFERENCES coach_users(id);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS coach_user_id_2 varchar REFERENCES coach_users(id);
ALTER TABLE coach_availability ADD COLUMN IF NOT EXISTS coach_user_id varchar REFERENCES coach_users(id);
ALTER TABLE coach_venue_preferences ADD COLUMN IF NOT EXISTS coach_user_id varchar REFERENCES coach_users(id);
ALTER TABLE coach_users ADD COLUMN IF NOT EXISTS ragic_record_id varchar;
-- These tables share the Schedule projection. Keep their columns compatible;
-- school teacher identity is not inferred or backfilled by this migration.
DO $$
DECLARE schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['school_demo','school_school1','school_school2'] LOOP
    IF to_regclass(format('%I.schedules', schema_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.schedules ADD COLUMN IF NOT EXISTS coach_user_id varchar, ADD COLUMN IF NOT EXISTS coach_user_id_2 varchar, ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1', schema_name);
    END IF;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS coach_users_ragic_record_id_unique ON coach_users(ragic_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS availability_coach_id_slot ON coach_availability(coach_user_id,week_start,day_of_week,time_slot_order);
CREATE UNIQUE INDEX IF NOT EXISTS preferences_coach_id_venue ON coach_venue_preferences(coach_user_id,venue_name);
ALTER TABLE coach_availability DROP CONSTRAINT IF EXISTS coach_availability_coach_name_week_start_day_of_week_time_s_key;
ALTER TABLE coach_venue_preferences DROP CONSTRAINT IF EXISTS coach_venue_preferences_coach_name_venue_name_key;
CREATE TABLE IF NOT EXISTS operation_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id text NOT NULL, actor_role text NOT NULL, request_id text,
  entity text NOT NULL, entity_id text NOT NULL,
  before_data jsonb, after_data jsonb, override_reason text
);
CREATE INDEX IF NOT EXISTS operation_audit_entity ON operation_audit(entity, entity_id, occurred_at);
CREATE TABLE IF NOT EXISTS ragic_sync_runs (
  id uuid PRIMARY KEY, status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  total_count integer NOT NULL DEFAULT 0, success_count integer NOT NULL DEFAULT 0, failure_count integer NOT NULL DEFAULT 0, error_code text
);
CREATE TABLE IF NOT EXISTS ragic_sync_items (
  run_id uuid NOT NULL REFERENCES ragic_sync_runs(id), kind text NOT NULL, source_id text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL, attempts integer NOT NULL DEFAULT 0, error_code text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,kind,source_id)
);
COMMIT;
