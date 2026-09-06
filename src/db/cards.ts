/** Le pool : les cartes physiques enrolees une fois pour toutes. */
import { db } from './index.ts';

export interface PoolCard {
  id: number;
  card_id: string;
  nickname: string;
  ndef_url: string | null;
  track_count: number;
  current_project_id: number | null;
  enrolled_at: string;
}

export function listPool(): PoolCard[] {
  return db().prepare('SELECT * FROM cards ORDER BY nickname COLLATE NOCASE').all() as PoolCard[];
}

export function findByCardId(cardId: string): PoolCard | undefined {
  return db().prepare('SELECT * FROM cards WHERE card_id = ?').get(cardId) as PoolCard | undefined;
}

export function enroll(cardId: string, nickname: string, ndefUrl?: string): void {
  db()
    .prepare(
      `INSERT INTO cards (card_id, nickname, ndef_url, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (card_id) DO UPDATE
         SET nickname = excluded.nickname,
             -- une URL relevee par NFC ne doit jamais etre ecrasee par un enrolement manuel
             ndef_url = coalesce(excluded.ndef_url, cards.ndef_url),
             updated_at = excluded.updated_at`,
    )
    .run(cardId, nickname.trim(), ndefUrl ?? null);
}

export function unenroll(cardId: string): void {
  db().prepare('DELETE FROM cards WHERE card_id = ?').run(cardId);
}

export function setTrackCount(cardId: string, count: number): void {
  db()
    .prepare(`UPDATE cards SET track_count = ?, updated_at = datetime('now') WHERE card_id = ?`)
    .run(count, cardId);
}
