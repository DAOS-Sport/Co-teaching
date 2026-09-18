-- Weekly push reliability upgrade. Apply before deploying the matching server.
ALTER TABLE weekly_push_runs
  ADD COLUMN IF NOT EXISTS destination varchar NOT NULL DEFAULT 'coaches',
  ADD COLUMN IF NOT EXISTS idempotency_key varchar;

UPDATE weekly_push_runs
SET idempotency_key = CASE WHEN dry_run
  THEN 'weekly-preview:' || week_start_date || ':coaches:' || id
  ELSE 'weekly-send:' || week_start_date || ':coaches:' || id
END
WHERE idempotency_key IS NULL;

ALTER TABLE weekly_push_runs ALTER COLUMN idempotency_key SET NOT NULL;

-- Preserve historical duplicates by moving older rows to an explicit legacy
-- destination bucket. New rows always use destination='coaches'.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY push_type, week_start_date, destination, dry_run
    ORDER BY created_at DESC, id DESC
  ) AS rn
  FROM weekly_push_runs
)
UPDATE weekly_push_runs w
SET destination = 'coaches-legacy-' || w.id
FROM ranked r
WHERE w.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_push_delivery
  ON weekly_push_runs(push_type, week_start_date, destination, dry_run);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_push_idempotency_key
  ON weekly_push_runs(idempotency_key);

ALTER TABLE weekly_push_recipients
  ADD COLUMN IF NOT EXISTS delivery_key varchar,
  ADD COLUMN IF NOT EXISTS line_retry_key varchar,
  ADD COLUMN IF NOT EXISTS started_at timestamp,
  ADD COLUMN IF NOT EXISTS completed_at timestamp,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp,
  ADD COLUMN IF NOT EXISTS line_response_code integer;

UPDATE weekly_push_recipients r
SET delivery_key = CASE WHEN w.dry_run THEN 'weekly-preview:' ELSE 'weekly:' END
    || w.week_start_date || ':' || COALESCE(r.recipient_id, r.line_user_id, r.id),
    line_retry_key = gen_random_uuid()::text
FROM weekly_push_runs w
WHERE r.run_id = w.id
  AND (r.delivery_key IS NULL OR r.line_retry_key IS NULL);

ALTER TABLE weekly_push_recipients
  ALTER COLUMN delivery_key SET NOT NULL,
  ALTER COLUMN line_retry_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_push_recipient_delivery_key
  ON weekly_push_recipients(delivery_key);

-- Normalize old state names to the new state machine.
UPDATE weekly_push_runs SET status = 'sending' WHERE status = 'running';
UPDATE weekly_push_runs SET status = 'partial_success' WHERE status = 'partial_failed';

CREATE TABLE IF NOT EXISTS weekly_push_outbox (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id varchar NOT NULL REFERENCES weekly_push_runs(id) ON DELETE CASCADE,
  queue_name varchar NOT NULL,
  payload_json jsonb NOT NULL,
  status varchar NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamp,
  published_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_push_outbox_run
  ON weekly_push_outbox(run_id);
CREATE INDEX IF NOT EXISTS idx_weekly_push_outbox_pending
  ON weekly_push_outbox(status, next_attempt_at);
