-- Additive upgrade: review and apply before starting the new application.
-- Existing classroom snapshots, positions, messages and personal notes stay intact.
CREATE TABLE IF NOT EXISTS reading_reader_states (
  id serial PRIMARY KEY,
  reading_id integer NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  document_key text NOT NULL, position jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1, mutation_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reading_reader_states_document_uq
  ON reading_reader_states(reading_id, document_key);

CREATE TABLE IF NOT EXISTS reading_bookmarks (
  id serial PRIMARY KEY,
  reading_id integer NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  document_key text NOT NULL, client_id text NOT NULL, position jsonb NOT NULL,
  title text NOT NULL, excerpt text NOT NULL, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reading_bookmarks_client_uq
  ON reading_bookmarks(reading_id, document_key, client_id);
