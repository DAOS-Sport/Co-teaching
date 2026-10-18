CREATE TABLE IF NOT EXISTS public.teacher_access_tokens (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  jti VARCHAR NOT NULL UNIQUE,
  token_hash VARCHAR NOT NULL UNIQUE,
  school_code VARCHAR NOT NULL,
  teacher_id VARCHAR NOT NULL,
  permissions JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR NOT NULL DEFAULT 'admin-password'
);
CREATE INDEX IF NOT EXISTS idx_teacher_access_tokens_school_teacher
  ON public.teacher_access_tokens (school_code, teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_access_tokens_expires
  ON public.teacher_access_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.teacher_access_audit_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id VARCHAR REFERENCES public.teacher_access_tokens(id) ON DELETE SET NULL,
  school_code VARCHAR NOT NULL,
  teacher_id VARCHAR NOT NULL,
  event VARCHAR NOT NULL,
  path TEXT,
  ip_address VARCHAR,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teacher_access_audit_token
  ON public.teacher_access_audit_logs (token_id, created_at);

-- Per-school feedback migrations are applied by initializeSchoolSchema()
-- because each school uses its own dynamic schema.
