-- Add chat attachments without replacing reading materials or classroom history.
ALTER TABLE reading_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
