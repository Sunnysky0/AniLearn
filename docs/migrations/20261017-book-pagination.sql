-- Additive migration. Review and back up the database before applying.
BEGIN;
CREATE TABLE IF NOT EXISTS book_reader_states (
  version_id integer PRIMARY KEY REFERENCES book_versions(id) ON DELETE CASCADE,
  position jsonb NOT NULL,
  chapter_positions jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 0,
  mutation_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS book_bookmarks (
  id serial PRIMARY KEY,
  version_id integer NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  position jsonb NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS book_bookmarks_version_client_uq ON book_bookmarks (version_id, client_id);
COMMIT;
