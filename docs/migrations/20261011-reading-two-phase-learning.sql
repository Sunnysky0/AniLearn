-- Add two-phase reading progress, resumable whole-article context, turn replay,
-- and private-to-the-session learner notes. Existing snapshots and history stay intact.
ALTER TABLE reading_sessions
  ADD COLUMN IF NOT EXISTS learning_state jsonb,
  ADD COLUMN IF NOT EXISTS analysis_draft jsonb;

CREATE TABLE IF NOT EXISTS reading_turns (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES reading_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  input_hash text NOT NULL,
  phase text NOT NULL,
  focus text,
  intent text,
  status text NOT NULL DEFAULT 'running',
  action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reading_turns_session_request_uq UNIQUE (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS reading_turns_session_idx ON reading_turns(session_id, id);

CREATE TABLE IF NOT EXISTS reading_personal_notes (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES reading_sessions(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  kind text NOT NULL,
  content text NOT NULL DEFAULT '',
  selection jsonb,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reading_personal_notes_session_client_uq UNIQUE (session_id, client_id)
);
CREATE INDEX IF NOT EXISTS reading_personal_notes_session_idx ON reading_personal_notes(session_id, id);

ALTER TABLE reading_messages
  ADD COLUMN IF NOT EXISTS turn_id integer REFERENCES reading_turns(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS focus text,
  ADD COLUMN IF NOT EXISTS selection jsonb;
CREATE INDEX IF NOT EXISTS reading_messages_turn_idx ON reading_messages(turn_id, id);

-- Legacy progress is retained verbatim for review, but it never marks the new
-- article-level analysis as completed.
UPDATE reading_sessions
SET learning_state = jsonb_build_object(
  'phase', 'free_reading',
  'stateRevision', 0,
  'readingConfirmedAt', NULL,
  'articleKind', NULL,
  'articleKindSource', NULL,
  'currentFocus', NULL,
  'focusStatus', jsonb_build_object(
    'structure', 'not_started', 'writing', 'not_started', 'theme', 'not_started',
    'emotion', 'not_started', 'technique', 'not_started'
  ),
  'analysisNotes', '{}'::jsonb,
  'summary', '',
  'analysisCompletedAt', NULL,
  'legacy', jsonb_build_object('status', status, 'progress', progress, 'notes', notes)
)
WHERE learning_state IS NULL;

UPDATE reading_sessions
SET analysis_draft = jsonb_build_object(
  'status', 'idle', 'requestId', NULL, 'sourceRevision', coalesce((snapshot->>'revision')::integer, 0), 'totalChunks', 0,
  'chunks', '{}'::jsonb, 'merges', '{}'::jsonb, 'context', '', 'articleKind', NULL, 'error', NULL
)
WHERE analysis_draft IS NULL;
