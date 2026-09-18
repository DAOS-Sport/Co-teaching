-- Review duplicate rows before applying if the first SELECT returns data.
SELECT venue_id, date, time_slot_id,
       lower(regexp_replace(trim(class_name), '\s+', '', 'g')) AS normalized_class,
       count(*)
FROM schedules
WHERE class_name IS NOT NULL AND trim(class_name) <> ''
GROUP BY 1,2,3,4 HAVING count(*) > 1;

UPDATE schedules
SET coach_name_2 = NULL, coach2_is_teaching = false
WHERE coach_count = 1 AND coach_name_2 IS NOT NULL;

UPDATE schedules
SET coach1_is_teaching = true
WHERE coach_name IS NOT NULL AND trim(coach_name) <> ''
  AND coach_name_2 IS NULL AND coach1_is_teaching = false;

ALTER TABLE schedules ALTER COLUMN coach1_is_teaching SET DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_schedule_class_in_cell
ON schedules (
  venue_id,
  date,
  time_slot_id,
  lower(regexp_replace(trim(class_name), '\s+', '', 'g'))
)
WHERE class_name IS NOT NULL AND trim(class_name) <> '';
