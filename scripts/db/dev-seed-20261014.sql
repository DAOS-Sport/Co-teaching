-- Test data for checking #6 / #8 on the DEVELOPMENT database (week of 2026-10-19).
-- Every class name starts with TEST_; re-running replaces the previous run.
-- Remove everything with dev-seed-20261014-clean.sql.
BEGIN;

DELETE FROM schedules
WHERE date BETWEEN '2026-10-19' AND '2026-10-25' AND class_name LIKE 'TEST\_%';
DELETE FROM coach_availability
WHERE week_start = '2026-10-19' AND coach_name IN ('測試教練甲', '測試教練乙', '測試教練丙');

INSERT INTO coach_users (name, status, role, linked_coach_name)
SELECT coach, 'approved', 'coach', coach
FROM unnest(ARRAY['測試教練甲', '測試教練乙', '測試教練丙']) AS coach
WHERE NOT EXISTS (SELECT 1 FROM coach_users existing WHERE existing.name = coach);

WITH venue AS (SELECT id, row_number() OVER (ORDER BY "order", name) AS n FROM venues),
     slot AS (SELECT id, "order" FROM time_slots)
INSERT INTO schedules (date, venue_id, time_slot_id, class_name, coach_name, coach_count, is_class_locked, notes)
SELECT row.day::date,
       (SELECT id FROM venue WHERE venue.n = row.venue_no),
       (SELECT id FROM slot WHERE slot."order" = row.period),
       row.class_name, row.coach, row.coach_count, row.locked,
       '測試資料（2026-10-14 建立，可用清除腳本刪除）'
FROM (VALUES
  ('2026-10-19', 1, 1, 'TEST_跨館衝堂A班', '測試教練甲', 1, false),
  ('2026-10-19', 2, 1, 'TEST_跨館衝堂B班', '測試教練甲', 1, false),
  ('2026-10-19', 3, 1, 'TEST_指派衝堂H班', NULL,         1, false),
  ('2026-10-19', 1, 2, 'TEST_同館兩班C班', '測試教練乙', 1, false),
  ('2026-10-19', 1, 2, 'TEST_同館兩班D班', '測試教練乙', 1, false),
  ('2026-10-20', 1, 1, 'TEST_可排時段E班', NULL,         2, false),
  ('2026-10-20', 1, 2, 'TEST_版本測試F班', NULL,         1, false),
  ('2026-10-21', 1, 1, 'TEST_已鎖定G班',   NULL,         1, true)
) AS row(day, venue_no, period, class_name, coach, coach_count, locked);

-- 測試教練丙 filled availability this week, but only Monday period 3.
INSERT INTO coach_availability (coach_name, week_start, day_of_week, time_slot_order)
VALUES ('測試教練丙', '2026-10-19', 1, 3);

SELECT s.date, v.name AS venue, t.period, s.class_name, coalesce(s.coach_name, '') AS coach,
       CASE WHEN s.is_class_locked THEN '已鎖定' ELSE '' END AS locked
FROM schedules s JOIN venues v ON v.id = s.venue_id JOIN time_slots t ON t.id = s.time_slot_id
WHERE s.date BETWEEN '2026-10-19' AND '2026-10-25' AND s.class_name LIKE 'TEST\_%'
ORDER BY s.date, t."order", v."order", s.class_name;

COMMIT;
