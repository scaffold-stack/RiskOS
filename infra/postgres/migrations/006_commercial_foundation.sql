BEGIN;

CREATE TABLE IF NOT EXISTS commercial_api_keys (
  key_id text PRIMARY KEY,
  key_prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  plan text NOT NULL CHECK (plan IN ('developer', 'protocol')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  monthly_request_limit integer NOT NULL CHECK (monthly_request_limit BETWEEN 1 AND 10000000),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS commercial_api_keys_status_idx
  ON commercial_api_keys(status, created_at DESC);

CREATE TABLE IF NOT EXISTS commercial_api_usage (
  key_id text NOT NULL REFERENCES commercial_api_keys(key_id) ON DELETE CASCADE,
  period_start date NOT NULL,
  request_count bigint NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, period_start)
);

CREATE TABLE IF NOT EXISTS commercial_entitlements (
  subject_type text NOT NULL CHECK (subject_type IN ('wallet')),
  subject_id text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('free', 'pro', 'treasury', 'protocol')),
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  source text NOT NULL CHECK (source IN ('manual', 'billing')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (subject_type, subject_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS commercial_entitlements_status_idx
  ON commercial_entitlements(status, ends_at);

INSERT INTO schema_migrations(version)
VALUES ('006_commercial_foundation')
ON CONFLICT DO NOTHING;

COMMIT;
