-- Persistent OAuth state for the scheduling MCP. The schema is also declared in
-- shared/schema.ts; this idempotent file documents the production DDL for
-- reviewed deployment and manual recovery. Tokens and authorization codes are
-- stored only as SHA-256 digests, never as plaintext.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id varchar PRIMARY KEY,
  client_data jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash varchar(64) PRIMARY KEY,
  client_id varchar NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge varchar NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_client
  ON mcp_oauth_codes (client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry
  ON mcp_oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash varchar(64) PRIMARY KEY,
  token_type varchar(16) NOT NULL,
  client_id varchar NOT NULL,
  scopes jsonb NOT NULL,
  resource text NOT NULL,
  expires_at timestamp NOT NULL,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client
  ON mcp_oauth_tokens (client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expiry
  ON mcp_oauth_tokens (expires_at);
