/** Connexion SQLite unique, schema applique au demarrage. */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.ts';

const here = dirname(fileURLToPath(import.meta.url));

let instance: Database.Database | undefined;

export function db(): Database.Database {
  if (instance) return instance;

  mkdirSync(config.dataDir, { recursive: true });
  const handle = new Database(join(config.dataDir, 'yoto-studio.db'));

  // busy_timeout evite les SQLITE_BUSY quand le worker ecrit pendant qu'une requete lit.
  handle.pragma('busy_timeout = 5000');
  handle.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(handle);

  instance = handle;
  return handle;
}

/**
 * Evolutions du schema pour les bases deja creees.
 *
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table existante : tout changement de forme
 * doit donc etre rejoue ici. Chaque etape est idempotente et se verifie avant d'agir.
 */
function migrate(handle: Database.Database): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );

  if (!columns('tracks').has('text')) {
    handle.exec('ALTER TABLE tracks ADD COLUMN text TEXT');
  }

  if (!columns('tracks').has('icon_url')) {
    handle.exec('ALTER TABLE tracks ADD COLUMN icon_url TEXT');
  }

  if (!columns('projects').has('cover_url')) {
    handle.exec('ALTER TABLE projects ADD COLUMN cover_url TEXT');
  }

  // SQLite ne sait pas modifier une contrainte CHECK : il faut reconstruire la table.
  const ddl = handle
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
    .get() as { sql: string } | undefined;

  if (ddl && ddl.sql.includes("'rss'") && !ddl.sql.includes("'voice'")) {
    handle.exec('PRAGMA foreign_keys = OFF');
    handle.transaction(() => {
      handle.exec(`
        CREATE TABLE projects_new (
          id           INTEGER PRIMARY KEY,
          title        TEXT NOT NULL,
          state        TEXT NOT NULL DEFAULT 'draft'
                       CHECK (state IN ('draft','fetching','segmenting','reviewing',
                                        'uploading','published','failed')),
          source_kind  TEXT CHECK (source_kind IN ('upload','youtube','rss','voice')),
          source_ref   TEXT,
          source_path  TEXT,
          card_id      TEXT REFERENCES cards(card_id) ON DELETE SET NULL,
          artwork_json TEXT,
          error        TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO projects_new SELECT id, title, state, source_kind, source_ref, source_path,
               card_id, artwork_json, error, created_at, updated_at FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;
      `);
    })();
    handle.exec('PRAGMA foreign_keys = ON');
  }
}

/** Reglages libres : jetons Yoto, cookies YouTube. */
export function getSetting(key: string): string | undefined {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value);
}

export function deleteSetting(key: string): void {
  db().prepare('DELETE FROM settings WHERE key = ?').run(key);
}
