BEGIN;

CREATE TABLE IF NOT EXISTS wallet_challenges (
  challenge_id text PRIMARY KEY,
  address text NOT NULL,
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_challenges_address_idx ON wallet_challenges(address, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  address text NOT NULL,
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_sessions_address_idx ON wallet_sessions(address, expires_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id text PRIMARY KEY,
  address text NOT NULL,
  name text NOT NULL,
  categories text[] NOT NULL,
  minimum_severity text NOT NULL CHECK (minimum_severity IN ('info', 'low', 'medium', 'high', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds >= 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_address_idx ON alert_rules(address, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_occurrences (
  occurrence_id text PRIMARY KEY,
  rule_id text NOT NULL REFERENCES alert_rules(rule_id),
  address text NOT NULL,
  risk_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  title text NOT NULL,
  evidence jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_occurrences_address_idx ON alert_occurrences(address, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS action_intents (
  intent_id text PRIMARY KEY,
  address text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('planned', 'wallet-requested', 'submitted', 'confirmed', 'blocked')),
  intent jsonb NOT NULL,
  txid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS action_intents_address_idx ON action_intents(address, updated_at DESC);

INSERT INTO schema_migrations(version) VALUES ('003_product_workflows') ON CONFLICT DO NOTHING;
COMMIT;
