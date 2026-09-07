BEGIN;

CREATE TABLE IF NOT EXISTS protocol_projection_events (
  projection_id text PRIMARY KEY,
  source_event_key text NOT NULL REFERENCES contract_events(event_key),
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  index_block_hash text NOT NULL,
  block_height bigint NOT NULL CHECK (block_height >= 0),
  tx_id text NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  protocol text NOT NULL CHECK (protocol IN ('zest', 'bitflow', 'sbtc')),
  adapter_version text NOT NULL,
  kind text NOT NULL,
  owner_address text,
  position_key text NOT NULL,
  payload jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (network, index_block_hash) REFERENCES chain_blocks(network, index_block_hash)
);
CREATE INDEX IF NOT EXISTS protocol_projection_owner_idx
  ON protocol_projection_events(network, owner_address, protocol, block_height DESC) WHERE canonical;
CREATE INDEX IF NOT EXISTS protocol_projection_position_idx
  ON protocol_projection_events(network, position_key, block_height DESC, event_index DESC) WHERE canonical;

CREATE TABLE IF NOT EXISTS projection_issues (
  issue_id bigserial PRIMARY KEY,
  source_event_key text NOT NULL REFERENCES contract_events(event_key),
  network text NOT NULL,
  index_block_hash text NOT NULL,
  protocol text NOT NULL,
  code text NOT NULL,
  detail text NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS projection_issue_unique
  ON projection_issues(source_event_key, protocol, code, detail);

CREATE TABLE IF NOT EXISTS comparison_runs (
  run_id text PRIMARY KEY,
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  registry_version text NOT NULL,
  address_count integer NOT NULL CHECK (address_count >= 100),
  matched_count integer NOT NULL DEFAULT 0,
  mismatch_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS comparison_results (
  run_id text NOT NULL REFERENCES comparison_runs(run_id),
  address text NOT NULL,
  matched boolean NOT NULL,
  candidate_digest text NOT NULL,
  reference_digest text NOT NULL,
  detail jsonb NOT NULL,
  PRIMARY KEY (run_id, address)
);

INSERT INTO schema_migrations(version) VALUES ('002_protocol_projection') ON CONFLICT DO NOTHING;
COMMIT;
