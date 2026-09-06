/**
 * Sessions en SQLite plutot qu'en memoire : un redemarrage ne doit pas deconnecter.
 * Interface attendue par @fastify/session (callbacks, pas promesses).
 */
import type { SessionStore } from '@fastify/session';
import type { Session } from 'fastify';

import { db } from '../db/index.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
`;

export function sqliteSessionStore(): SessionStore {
  const handle = db();
  handle.exec(SCHEMA);

  const upsert = handle.prepare(
    `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
  );
  const select = handle.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
  const remove = handle.prepare('DELETE FROM sessions WHERE sid = ?');
  const sweep = handle.prepare('DELETE FROM sessions WHERE expires_at < ?');

  // Purge des sessions perimees a chaque demarrage : la table ne doit pas grossir sans fin.
  sweep.run(Date.now());

  return {
    set(sid, session, callback) {
      try {
        const expiry = session.cookie?.expires?.getTime() ?? Date.now() + 7 * 24 * 3600 * 1000;
        upsert.run(sid, JSON.stringify(session), expiry);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },

    get(sid, callback) {
      try {
        const row = select.get(sid) as { data: string; expires_at: number } | undefined;
        if (!row) return callback(null, null);
        if (row.expires_at < Date.now()) {
          remove.run(sid);
          return callback(null, null);
        }
        callback(null, JSON.parse(row.data) as Session);
      } catch (error) {
        callback(error as Error);
      }
    },

    destroy(sid, callback) {
      try {
        remove.run(sid);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  };
}
