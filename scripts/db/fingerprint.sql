-- Schema fingerprint: one line per table, md5 only (no data, no secrets).
-- Columns, constraints and indexes are hashed separately so differences can be located.
WITH tbl AS (
  SELECT n.nspname AS s, c.relname AS t, c.oid
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND (n.nspname = 'public' OR n.nspname LIKE 'school\_%')
),
cols AS (
  SELECT t.s, t.t, md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attname)) AS h
  FROM tbl t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  GROUP BY t.s, t.t
),
cons AS (
  SELECT t.s, t.t, md5(coalesce(string_agg(co.conname || ':' || pg_get_constraintdef(co.oid), ',' ORDER BY co.conname), '')) AS h
  FROM tbl t LEFT JOIN pg_constraint co ON co.conrelid = t.oid
  GROUP BY t.s, t.t
),
idx AS (
  SELECT t.s, t.t, md5(coalesce(string_agg(i.indexname || ':' || i.indexdef, ',' ORDER BY i.indexname), '')) AS h
  FROM tbl t LEFT JOIN pg_indexes i ON i.schemaname = t.s AND i.tablename = t.t
  GROUP BY t.s, t.t
)
SELECT cols.s || '.' || cols.t || '|' || left(cols.h, 8) || '|' || left(cons.h, 8) || '|' || left(idx.h, 8)
FROM cols JOIN cons USING (s, t) JOIN idx USING (s, t)
ORDER BY 1;
