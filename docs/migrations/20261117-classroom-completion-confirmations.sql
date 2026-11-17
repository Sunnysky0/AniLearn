-- Additive migration. Existing teaching evidence and progress remain intact.
BEGIN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completion_confirmations jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
