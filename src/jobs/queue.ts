/**
 * File de travaux en SQLite. Un seul worker in-process : pas de Redis a administrer, et l'etat
 * survit a un redemarrage.
 *
 * Les travaux termines sont conserves jusqu'a leur peremption plutot que supprimes a la premiere
 * lecture — sinon un simple rafraichissement de page perd le resultat.
 */
import { db } from '../db/index.ts';

export type JobState = 'queued' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: number;
  project_id: number | null;
  kind: string;
  payload_json: string;
  state: JobState;
  progress: number;
  total: number;
  message: string;
  result_json: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

/** Duree de conservation d'un travail termine, pour que l'interface puisse le relire. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;

const TERMINAL: JobState[] = ['done', 'error', 'cancelled'];

export function enqueue(kind: string, payload: unknown, projectId?: number): number {
  const info = db()
    .prepare(
      `INSERT INTO jobs (project_id, kind, payload_json, message)
       VALUES (?, ?, ?, 'En attente…')`,
    )
    .run(projectId ?? null, kind, JSON.stringify(payload ?? {}));
  return Number(info.lastInsertRowid);
}

export function getJob(id: number): Job | undefined {
  return db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

/** Le travail en cours ou le dernier termine pour un projet. */
export function latestJobFor(projectId: number): Job | undefined {
  return db()
    .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(projectId) as Job | undefined;
}

export function claimNext(): Job | undefined {
  const claim = db().transaction((): Job | undefined => {
    const next = db()
      .prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1`)
      .get() as Job | undefined;
    if (!next) return undefined;
    db()
      .prepare(
        `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(next.id);
    return { ...next, state: 'running', attempts: next.attempts + 1 };
  });
  return claim();
}

export function reportProgress(id: number, message: string, done: number, total: number): void {
  db()
    .prepare(
      `UPDATE jobs SET message = ?, progress = ?, total = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(message, done, total, id);
}

function finish(id: number, state: JobState, fields: { result?: unknown; error?: string }): void {
  db()
    .prepare(
      `UPDATE jobs SET state = ?, result_json = ?, error = ?, updated_at = datetime('now'),
              expires_at = ?
       WHERE id = ?`,
    )
    .run(
      state,
      fields.result === undefined ? null : JSON.stringify(fields.result),
      fields.error ?? null,
      new Date(Date.now() + KEEP_FINISHED_MS).toISOString(),
      id,
    );
}

export const succeed = (id: number, result?: unknown): void => finish(id, 'done', { result });
export const fail = (id: number, error: string): void => finish(id, 'error', { error });
export const markCancelled = (id: number): void => finish(id, 'cancelled', {});

/** Demande d'annulation : le worker la constate entre deux etapes et s'arrete proprement. */
export function requestCancel(id: number): void {
  db()
    .prepare(
      `UPDATE jobs SET state = 'cancelling', message = 'Arrêt après l’étape en cours…',
              updated_at = datetime('now')
       WHERE id = ? AND state IN ('queued', 'running')`,
    )
    .run(id);
}

export function isCancelling(id: number): boolean {
  const row = db().prepare('SELECT state FROM jobs WHERE id = ?').get(id) as
    | { state: JobState }
    | undefined;
  return row?.state === 'cancelling';
}

export const isTerminal = (state: JobState): boolean => TERMINAL.includes(state);

/**
 * Au demarrage : un travail marque « en cours » est le vestige d'un arret brutal, on le remet
 * en file. Et on purge ceux qui ont depasse leur peremption.
 */
export function recoverOnBoot(): { requeued: number; purged: number } {
  const requeued = db()
    .prepare(
      `UPDATE jobs SET state = 'queued', message = 'Reprise après redémarrage…'
       WHERE state IN ('running', 'cancelling')`,
    )
    .run().changes;

  const purged = db()
    .prepare(`DELETE FROM jobs WHERE expires_at IS NOT NULL AND expires_at < ?`)
    .run(new Date().toISOString()).changes;

  return { requeued, purged };
}
