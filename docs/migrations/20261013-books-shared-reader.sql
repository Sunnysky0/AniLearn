-- Additive migration. Apply during the separately scheduled upgrade, never to
-- the database of the currently running application during implementation.
ALTER TABLE reading_sessions ADD COLUMN IF NOT EXISTS reader_position jsonb;
ALTER TABLE reading_messages ADD COLUMN IF NOT EXISTS reader_anchor jsonb;
ALTER TABLE reading_personal_notes ADD COLUMN IF NOT EXISTS reader_anchor jsonb;

CREATE TABLE IF NOT EXISTS books (
  id serial PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en', kind text NOT NULL DEFAULT 'thought',
  status text NOT NULL DEFAULT 'uploaded', current_version_id integer,
  builtin_key text, cover_asset_id text, error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS books_builtin_key_uq ON books(builtin_key);
CREATE TABLE IF NOT EXISTS book_versions (
  id serial PRIMARY KEY, book_id integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'uploaded', revision integer NOT NULL DEFAULT 0,
  source_hash text NOT NULL, parser_version text NOT NULL, file_name text NOT NULL, format text NOT NULL,
  source_data text NOT NULL, converted_data text, draft jsonb,
  footnotes jsonb NOT NULL DEFAULT '{}', error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS book_chapters (
  id text PRIMARY KEY, version_id integer NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
  title text NOT NULL, parent_id text, role text NOT NULL DEFAULT 'main', sort_order integer NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS book_chapters_version_order ON book_chapters(version_id,sort_order);
CREATE TABLE IF NOT EXISTS book_assets (
  id serial PRIMARY KEY, version_id integer NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
  asset_key text NOT NULL, mime text NOT NULL, data text NOT NULL, width integer, height integer
);
CREATE UNIQUE INDEX IF NOT EXISTS book_assets_version_key_uq ON book_assets(version_id,asset_key);
CREATE TABLE IF NOT EXISTS book_sessions (
  id serial PRIMARY KEY, book_id integer NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  version_id integer NOT NULL REFERENCES book_versions(id), tutor_id integer NOT NULL REFERENCES tutors(id),
  current_chapter_id text NOT NULL, status text NOT NULL DEFAULT 'active', summary text NOT NULL DEFAULT '',
  summary_draft jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS book_chapter_states (
  id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES book_sessions(id) ON DELETE CASCADE,
  chapter_id text NOT NULL REFERENCES book_chapters(id), learning jsonb NOT NULL, position jsonb, analysis_draft jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS book_chapter_states_session_chapter_uq ON book_chapter_states(session_id,chapter_id);
CREATE TABLE IF NOT EXISTS book_turns (
  id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES book_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL, input_hash text NOT NULL, chapter_id text NOT NULL,
  phase text NOT NULL, focus text, intent text, status text NOT NULL DEFAULT 'running', action text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS book_turns_session_request_uq ON book_turns(session_id,request_id);
CREATE TABLE IF NOT EXISTS book_messages (
  id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES book_sessions(id) ON DELETE CASCADE,
  turn_id integer REFERENCES book_turns(id) ON DELETE CASCADE, chapter_id text NOT NULL,
  role text NOT NULL, kind text NOT NULL DEFAULT 'text', language text NOT NULL DEFAULT 'zh-CN',
  content text NOT NULL, speech text NOT NULL DEFAULT '', attachments jsonb NOT NULL DEFAULT '[]',
  phase text NOT NULL DEFAULT 'free_reading', focus text, anchor jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS book_messages_session_idx ON book_messages(session_id,id);
CREATE TABLE IF NOT EXISTS book_personal_notes (
  id serial PRIMARY KEY, version_id integer NOT NULL REFERENCES book_versions(id) ON DELETE CASCADE,
  chapter_id text, kind text NOT NULL, client_id text NOT NULL, content text NOT NULL,
  anchor jsonb, revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS book_personal_notes_version_client_uq ON book_personal_notes(version_id,client_id);
