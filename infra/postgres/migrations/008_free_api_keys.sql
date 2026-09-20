BEGIN;

ALTER TABLE commercial_api_keys
  DROP CONSTRAINT IF EXISTS commercial_api_keys_plan_check;
ALTER TABLE commercial_api_keys
  ADD CONSTRAINT commercial_api_keys_plan_check
  CHECK (plan IN ('free', 'pro', 'treasury', 'developer', 'protocol'));

INSERT INTO schema_migrations(version)
VALUES ('008_free_api_keys')
ON CONFLICT DO NOTHING;

COMMIT;
