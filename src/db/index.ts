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
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  handle.exec(schema);
  migrate(handle, schema);

  instance = handle;
  return handle;
}

/**
 * Evolutions du schema pour les bases deja creees.
 *
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table existante : tout changement de forme
 * doit donc etre rejoue ici. Chaque etape est idempotente et se verifie avant d'agir.
 */
function migrate(handle: Database.Database, schema: string): void {
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

  // Le titre Yoto de chaque contenu, pour retrouver l'histoire qu'il joue sans appeler Yoto. Un
  // surnom n'est repris que s'il est le titre d'une histoire : un surnom donne a la main (« 1 »)
  // ferait un faux titre, que la bibliotheque Yoto corrigera.
  if (!columns('cards').has('title')) {
    handle.exec(`
      ALTER TABLE cards ADD COLUMN title TEXT;
      UPDATE cards SET title = nickname WHERE nickname IN (SELECT title FROM projects);
    `);
  }

  if (!columns('card_tags').has('name')) {
    handle.exec('ALTER TABLE card_tags ADD COLUMN name TEXT');
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

  // Les comptes : chaque table de donnees porte account_id. Les lignes d'avant restent sans
  // compte jusqu'a ce que le premier compte cree les reprenne. L'unicite d'un contenu ou d'une
  // puce devient « par compte », ce qu'un ALTER ne sait pas faire : on reconstruit ces tables,
  // et projects avec, dont la cle etrangere vers cards(card_id) n'aurait plus de cible unique.
  if (!columns('cards').has('account_id')) {
    handle.exec('PRAGMA foreign_keys = OFF');
    handle.transaction(() => {
      for (const table of ['cards', 'card_tags', 'projects']) rebuild(handle, schema, table);
      if (!columns('jobs').has('account_id')) {
        handle.exec(`
          ALTER TABLE jobs ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
          UPDATE jobs SET account_id = (SELECT account_id FROM projects WHERE projects.id = jobs.project_id);
        `);
      }
    })();
    handle.exec('PRAGMA foreign_keys = ON');
  }

  handle.exec(`
    CREATE INDEX IF NOT EXISTS projects_account ON projects (account_id, id);
    CREATE INDEX IF NOT EXISTS cards_account ON cards (account_id);
    CREATE INDEX IF NOT EXISTS card_tags_account ON card_tags (account_id, card_id);
  `);
}

/**
 * Remplace une table par sa forme du schema, en recopiant les colonnes communes. La forme cible
 * est lue dans schema.sql : une seule definition fait foi, pour les bases neuves comme anciennes.
 */
function rebuild(handle: Database.Database, schema: string, table: string): void {
  const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`).exec(schema)?.[0];
  if (!ddl) throw new Error(`Table ${table} absente du schema`);

  const names = (name: string): string[] =>
    (handle.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((row) => row.name);

  handle.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${table}_new`));
  const target = new Set(names(`${table}_new`));
  const shared = names(table).filter((name) => target.has(name)).join(', ');
  handle.exec(`
    INSERT INTO ${table}_new (${shared}) SELECT ${shared} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_new RENAME TO ${table};
  `);
}

/** Reglages globaux, d'avant les comptes : ne servent plus qu'a la reprise par le premier compte. */
export function getSetting(key: string): string | undefined {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}
