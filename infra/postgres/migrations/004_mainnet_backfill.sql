BEGIN;

CREATE TABLE IF NOT EXISTS registry_backfill_checkpoints (
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  registry_version text NOT NULL,
  contract_principal text NOT NULL,
  activation_block bigint NOT NULL CHECK (activation_block >= 0),
  next_offset bigint NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  observed_tip bigint CHECK (observed_tip >= 0),
  pages_completed integer NOT NULL DEFAULT 0 CHECK (pages_completed >= 0),
  events_seen bigint NOT NULL DEFAULT 0 CHECK (events_seen >= 0),
  transactions_ingested bigint NOT NULL DEFAULT 0 CHECK (transactions_ingested >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, registry_version, contract_principal)
);

CREATE INDEX IF NOT EXISTS registry_backfill_status_idx
  ON registry_backfill_checkpoints(network, registry_version, status, updated_at);

INSERT INTO schema_migrations(version) VALUES ('004_mainnet_backfill') ON CONFLICT DO NOTHING;
COMMIT;
