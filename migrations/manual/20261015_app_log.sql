-- System log for the IT page (API errors and rejections, Ragic / notification events).
-- Additive only: one new table, nothing existing changes. Apply to the development
-- database; Publish carries it to production. Rows older than 90 days are deleted by the app.
BEGIN;
SET LOCAL search_path TO public;

CREATE TABLE IF NOT EXISTS app_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,
  source text NOT NULL,
  code text,
  message text,
  method text,
  route text,
  status integer,
  request_id text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS app_log_occurred_idx ON app_log (occurred_at);
CREATE INDEX IF NOT EXISTS app_log_level_idx ON app_log (level, occurred_at);
CREATE INDEX IF NOT EXISTS app_log_route_idx ON app_log (route, occurred_at);

COMMIT;
