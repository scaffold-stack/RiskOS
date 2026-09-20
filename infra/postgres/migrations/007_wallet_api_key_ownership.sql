BEGIN;

ALTER TABLE commercial_api_keys
  ADD COLUMN IF NOT EXISTS owner_address text;

CREATE INDEX IF NOT EXISTS commercial_api_keys_owner_idx
  ON commercial_api_keys(owner_address, created_at DESC)
  WHERE owner_address IS NOT NULL;

ALTER TABLE commercial_entitlements
  DROP CONSTRAINT IF EXISTS commercial_entitlements_plan_check;
ALTER TABLE commercial_entitlements
  ADD CONSTRAINT commercial_entitlements_plan_check
  CHECK (plan IN ('free', 'pro', 'treasury', 'developer', 'protocol'));

INSERT INTO schema_migrations(version)
VALUES ('007_wallet_api_key_ownership')
ON CONFLICT DO NOTHING;

COMMIT;
