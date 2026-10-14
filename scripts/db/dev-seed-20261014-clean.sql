-- Removes everything dev-seed-20261014.sql created on the DEVELOPMENT database.
BEGIN;
DELETE FROM schedules
WHERE date BETWEEN '2026-10-19' AND '2026-10-25' AND class_name LIKE 'TEST\_%';
DELETE FROM coach_availability
WHERE coach_name IN ('測試教練甲', '測試教練乙', '測試教練丙');
DELETE FROM coach_users
WHERE name IN ('測試教練甲', '測試教練乙', '測試教練丙') AND line_id IS NULL;
SELECT
  (SELECT count(*) FROM schedules WHERE class_name LIKE 'TEST\_%') AS test_classes_left,
  (SELECT count(*) FROM coach_users WHERE name IN ('測試教練甲', '測試教練乙', '測試教練丙')) AS test_coaches_left;
COMMIT;
