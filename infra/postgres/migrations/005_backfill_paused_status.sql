BEGIN;

ALTER TABLE registry_backfill_checkpoints
  DROP CONSTRAINT IF EXISTS registry_backfill_checkpoints_status_check;

ALTER TABLE registry_backfill_checkpoints
  ADD CONSTRAINT registry_backfill_checkpoints_status_check
  CHECK (status IN ('pending', 'running', 'paused', 'complete', 'failed'));

INSERT INTO schema_migrations(version) VALUES ('005_backfill_paused_status') ON CONFLICT DO NOTHING;
COMMIT;
