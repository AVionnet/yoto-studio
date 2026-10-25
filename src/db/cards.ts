/** Le pool : les cartes physiques enrolees une fois pour toutes. */
import { db, deleteSetting, getSetting, setSetting } from './index.ts';

export interface PoolCard {
  id: number;
  card_id: string;
  nickname: string;
  ndef_url: string | null;
  track_count: number;
  current_project_id: number | null;
  enrolled_at: string;
}

/** Une puce vierge encodee. Plusieurs peuvent partager un `card_id` : ce sont des jumelles. */
export interface CardTag {
  id: number;
  uid: string | null;
  card_id: string;
  written_at: string;
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

/**
 * Enregistre l'URL relevee sur une carte physique. C'est la seule facon d'obtenir un couple
 * cardId + token valide : il est frappe par le serveur Yoto, et ne se fabrique pas ici.
 */
export function setNdefUrl(cardId: string, ndefUrl: string): void {
  db()
    .prepare(`UPDATE cards SET ndef_url = ?, updated_at = datetime('now') WHERE card_id = ?`)
    .run(ndefUrl, cardId);
}

/**
 * Memorise l'adresse relevee pour un contenu, en l'enrolant au besoin. Un surnom choisi a la main
 * — « la bleue » — ne se fait pas ecraser : on n'enrole que ce qui manque au pool, et le releve,
 * lui, fait toujours foi pour l'adresse.
 */
export function saveAddress(cardId: string, nickname: string, ndefUrl: string): void {
  if (!findByCardId(cardId)) enroll(cardId, nickname, ndefUrl);
  setNdefUrl(cardId, ndefUrl);
}

/**
 * Le passeur : la carte MYO officielle qu'on relie a chaque histoire dans l'app Yoto, puis qu'on
 * releve ici. On n'en garde que l'uid, qui suffit a le reconnaitre parmi les vierges.
 */
const PASSEUR = 'passeur_uid';
export const getPasseur = (): string | undefined => getSetting(PASSEUR);
export const setPasseur = (uid: string): void => setSetting(PASSEUR, uid);
export const forgetPasseur = (): void => deleteSetting(PASSEUR);

/**
 * Note une puce vierge qui vient d'etre encodee. La cle est l'uid : une puce ne porte qu'un
 * enregistrement NDEF, donc la reencoder deplace simplement son contenu.
 */
export function recordTag(cardId: string, uid: string | undefined): void {
  if (uid) {
    db()
      .prepare(
        `INSERT INTO card_tags (uid, card_id) VALUES (?, ?)
         ON CONFLICT (uid) DO UPDATE
           SET card_id = excluded.card_id, written_at = datetime('now')`,
      )
      .run(uid, cardId);
    return;
  }
  // Sans uid on ne peut pas reconnaitre la puce : on garde quand meme la trace de l'encodage.
  db().prepare('INSERT INTO card_tags (card_id) VALUES (?)').run(cardId);
}

export function tagsFor(cardId: string): CardTag[] {
  return db()
    .prepare('SELECT * FROM card_tags WHERE card_id = ? ORDER BY written_at DESC')
    .all(cardId) as CardTag[];
}

/** Ce que nos registres disent d'une puce, reconnue a son uid. */
export function findTag(uid: string): CardTag | undefined {
  return db().prepare('SELECT * FROM card_tags WHERE uid = ?').get(uid) as CardTag | undefined;
}

/** Combien de cartes physiques portent chaque contenu, pour l'afficher dans le pool. */
export function tagCounts(): Map<string, number> {
  const rows = db()
    .prepare('SELECT card_id, count(*) AS n FROM card_tags GROUP BY card_id')
    .all() as { card_id: string; n: number }[];
  return new Map(rows.map((row) => [row.card_id, row.n]));
}

export function setTrackCount(cardId: string, count: number): void {
  db()
    .prepare(`UPDATE cards SET track_count = ?, updated_at = datetime('now') WHERE card_id = ?`)
    .run(count, cardId);
}
