-- Schema d'avant les comptes (commit 11b28db), pour tester la migration des bases existantes.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS cards (
  id                 INTEGER PRIMARY KEY,
  card_id            TEXT NOT NULL UNIQUE,
  nickname           TEXT NOT NULL,
  title              TEXT,
  ndef_url           TEXT,
  track_count        INTEGER NOT NULL DEFAULT 0,
  current_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  enrolled_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS card_tags (
  id         INTEGER PRIMARY KEY,
  uid        TEXT UNIQUE,
  name       TEXT,
  card_id    TEXT NOT NULL,
  written_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft','fetching','segmenting','reviewing',
                                'uploading','published','failed')),
  source_kind  TEXT CHECK (source_kind IN ('upload','youtube','rss','voice')),
  source_ref   TEXT,
  source_path  TEXT,
  card_id      TEXT REFERENCES cards(card_id) ON DELETE SET NULL,
  cover_url    TEXT,
  artwork_json TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tracks (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx               INTEGER NOT NULL,
  title             TEXT NOT NULL,
  text              TEXT,
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  file_path         TEXT,
  duration_ms       INTEGER,
  file_size         INTEGER,
  head_db           REAL,
  tail_db           REAL,
  transcoded_sha256 TEXT,
  icon_media_id     TEXT,
  icon_url          TEXT,
  UNIQUE (project_id, idx)
);
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','running','cancelling','done','error','cancelled')),
  progress     INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  result_json  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (state, id) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS tracks_project ON tracks (project_id, idx);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
