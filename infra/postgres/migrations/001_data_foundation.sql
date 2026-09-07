BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_chain_events (
  event_key text PRIMARY KEY,
  source text NOT NULL,
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processed' CHECK (status IN ('received', 'processed', 'quarantined')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS chain_blocks (
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  index_block_hash text NOT NULL,
  block_hash text NOT NULL,
  height bigint NOT NULL CHECK (height >= 0),
  parent_index_block_hash text,
  burn_block_height bigint CHECK (burn_block_height >= 0),
  block_time timestamptz,
  canonical boolean NOT NULL DEFAULT true,
  raw_event_key text NOT NULL REFERENCES raw_chain_events(event_key),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, index_block_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_canonical_block_per_height
  ON chain_blocks(network, height) WHERE canonical;
CREATE INDEX IF NOT EXISTS chain_blocks_parent_idx ON chain_blocks(network, parent_index_block_hash);

CREATE TABLE IF NOT EXISTS chain_transactions (
  network text NOT NULL,
  tx_id text NOT NULL,
  index_block_hash text NOT NULL,
  tx_index integer NOT NULL CHECK (tx_index >= 0),
  success boolean,
  canonical boolean NOT NULL DEFAULT true,
  raw jsonb NOT NULL,
  PRIMARY KEY (network, tx_id, index_block_hash),
  FOREIGN KEY (network, index_block_hash) REFERENCES chain_blocks(network, index_block_hash)
);
CREATE INDEX IF NOT EXISTS chain_transactions_block_idx ON chain_transactions(network, index_block_hash, tx_index);

CREATE TABLE IF NOT EXISTS contract_events (
  event_key text PRIMARY KEY,
  network text NOT NULL,
  tx_id text NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  index_block_hash text NOT NULL,
  contract_identifier text,
  topic text,
  event_type text NOT NULL,
  value jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  FOREIGN KEY (network, index_block_hash) REFERENCES chain_blocks(network, index_block_hash)
);
CREATE INDEX IF NOT EXISTS contract_events_contract_idx ON contract_events(network, contract_identifier, canonical);

CREATE TABLE IF NOT EXISTS position_snapshots (
  snapshot_id text PRIMARY KEY,
  network text NOT NULL,
  address text NOT NULL,
  position_id text NOT NULL,
  protocol text NOT NULL,
  adapter_version text NOT NULL,
  index_block_hash text NOT NULL,
  block_height bigint NOT NULL,
  position jsonb NOT NULL,
  lineage jsonb NOT NULL,
  confidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  FOREIGN KEY (network, index_block_hash) REFERENCES chain_blocks(network, index_block_hash)
);
CREATE INDEX IF NOT EXISTS position_snapshots_current_idx ON position_snapshots(network, address, position_id, block_height DESC) WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS registry_versions (
  version text PRIMARY KEY,
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  manifest_sha256 text NOT NULL UNIQUE,
  signer_fingerprint text NOT NULL,
  signature_base64 text NOT NULL,
  manifest jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'superseded', 'revoked')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_registry_per_network ON registry_versions(network) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS source_health (
  source_id text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('green', 'amber', 'red')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  observed_height bigint,
  lag_blocks bigint,
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id text PRIMARY KEY,
  source_id text NOT NULL,
  network text NOT NULL,
  checked_from_height bigint NOT NULL,
  checked_to_height bigint NOT NULL,
  mismatch_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  source_id text NOT NULL,
  network text NOT NULL,
  last_height bigint NOT NULL,
  last_index_block_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, network)
);

INSERT INTO schema_migrations(version) VALUES ('001_data_foundation') ON CONFLICT DO NOTHING;
COMMIT;
