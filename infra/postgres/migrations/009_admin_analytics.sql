BEGIN;

CREATE TABLE IF NOT EXISTS platform_request_events (
  event_id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  status_code integer NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('anonymous', 'wallet', 'api-key', 'admin', 'chainhook', 'operations')),
  api_key_id text,
  address_hash text CHECK (address_hash IS NULL OR address_hash ~ '^[a-f0-9]{64}$'),
  event_kind text NOT NULL CHECK (event_kind IN (
    'api-request',
    'address-search',
    'wallet-login',
    'alert-created',
    'api-key-created',
    'report-generated',
    'protection-planned',
    'chainhook-delivery',
    'admin-login'
  )),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_request_events_occurred_idx
  ON platform_request_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_request_events_route_idx
  ON platform_request_events(route, occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_request_events_event_kind_idx
  ON platform_request_events(event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_request_events_address_idx
  ON platform_request_events(address_hash, occurred_at DESC)
  WHERE address_hash IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('009_admin_analytics')
ON CONFLICT DO NOTHING;

COMMIT;
