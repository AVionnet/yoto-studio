/**
 * Les cartes et les contenus qu'elles portent.
 *
 * Une histoire vit chez Yoto sous un identifiant de contenu (`card_id`). Une carte est l'objet
 * qu'on pose sur le lecteur : ici, une copie sur une puce du commerce, qui porte l'adresse d'un
 * contenu. Seul le passeur, la carte MYO officielle, sert a relever ces adresses.
 */
import { db, deleteSetting, getSetting, setSetting } from './index.ts';

export interface PoolCard {
  id: number;
  card_id: string;
  nickname: string;
  /** Le titre de l'histoire chez Yoto, quand on l'a vu passer. */
  title: string | null;
  ndef_url: string | null;
  track_count: number;
  current_project_id: number | null;
  enrolled_at: string;
}

/** Une puce vierge encodee. Plusieurs peuvent partager un `card_id` : ce sont des jumelles. */
export interface CardTag {
  id: number;
  uid: string | null;
  name: string | null;
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
export function recordTag(cardId: string, uid: string | undefined): CardTag {
  if (uid) {
    // Le nom suit la puce : la reencoder change son histoire, pas son nom.
    return db()
      .prepare(
        `INSERT INTO card_tags (uid, card_id) VALUES (?, ?)
         ON CONFLICT (uid) DO UPDATE
           SET card_id = excluded.card_id, written_at = datetime('now')
         RETURNING *`,
      )
      .get(uid, cardId) as CardTag;
  }
  // Sans uid on ne peut pas reconnaitre la puce : on garde quand meme la trace de l'encodage.
  return db()
    .prepare('INSERT INTO card_tags (card_id) VALUES (?) RETURNING *')
    .get(cardId) as CardTag;
}

/** Les copies, sans le passeur : il change d'histoire a chaque liaison, ce n'en est pas une. */
export function listTags(): CardTag[] {
  return db()
    .prepare('SELECT * FROM card_tags WHERE uid IS NULL OR uid <> ? ORDER BY written_at DESC')
    .all(getPasseur() ?? '') as CardTag[];
}

/**
 * Une puce lue sur le telephone, avec son nom : on l'enregistre si on ne la connaissait pas (ecrite
 * ailleurs, ou avant qu'on releve les numeros), sinon on la renomme. Son histoire est celle qu'elle
 * porte vraiment ; la date d'ecriture, elle, n'est pas connue d'une simple lecture et reste.
 */
export function registerTag(uid: string, cardId: string, name: string): CardTag {
  return db()
    .prepare(
      `INSERT INTO card_tags (uid, card_id, name) VALUES (?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET card_id = excluded.card_id, name = excluded.name
       RETURNING *`,
    )
    .get(uid, cardId, name.trim().slice(0, 60) || null) as CardTag;
}

/** Une puce perdue, donnee ou jetee : elle ne compte plus parmi les cartes. */
export function forgetTag(id: number): void {
  db().prepare('DELETE FROM card_tags WHERE id = ?').run(id);
}

/**
 * Les ecritures faites sans numero de puce, pour un contenu. Elles ne designent aucune carte
 * precise — souvent les memes puces, reecrites — et ne servent qu'a gonfler les compteurs.
 */
export function forgetAnonymousTags(cardId: string): void {
  db().prepare('DELETE FROM card_tags WHERE uid IS NULL AND name IS NULL AND card_id = ?').run(cardId);
}

export function renameTag(id: number, name: string): void {
  db()
    .prepare('UPDATE card_tags SET name = ? WHERE id = ?')
    .run(name.trim().slice(0, 60) || null, id);
}

/** Le nom a montrer pour une copie : le sien, sinon de quoi la distinguer. */
export const tagLabel = (tag: CardTag): string =>
  tag.name ?? (tag.uid ? `puce ${tag.uid.slice(-5)}` : 'copie sans numéro');

/** Les copies qui portent un contenu. */
export interface Holders {
  copies: CardTag[];
}

export function holdersByContent(): Map<string, Holders> {
  const holders = new Map<string, Holders>();
  const of = (cardId: string): Holders => {
    let entry = holders.get(cardId);
    if (!entry) holders.set(cardId, (entry = { copies: [] }));
    return entry;
  };
  for (const tag of listTags()) of(tag.card_id).copies.push(tag);
  return holders;
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



/** Retient le titre Yoto des contenus connus, a chaque fois qu'on voit passer la bibliotheque. */
export function rememberTitles(contents: { cardId: string; title: string }[]): void {
  const update = db().prepare('UPDATE cards SET title = ? WHERE card_id = ?');
  db().transaction(() => {
    for (const content of contents) update.run(content.title, content.cardId);
  })();
}

/**
 * Les contenus d'une histoire : celui qu'elle connait, et ceux qui portent son titre chez Yoto —
 * une histoire publiee deux fois a deux contenus, et un identifiant perdu se retrouve ainsi.
 */
export function contentIdsFor(project: { card_id: string | null; title: string }): string[] {
  const rows = db().prepare('SELECT card_id FROM cards WHERE title = ?').all(project.title) as {
    card_id: string;
  }[];
  return [...new Set([project.card_id, ...rows.map((row) => row.card_id)].filter((id) => id !== null))];
}

/** Toutes les copies qui portent l'un de ces contenus. */
export function mergeHolders(all: Map<string, Holders>, cardIds: string[]): Holders {
  return { copies: cardIds.flatMap((id) => all.get(id)?.copies ?? []) };
}

/**
 * Rend son identifiant a une histoire publiee qui l'a perdu, quand un seul contenu porte son
 * titre. (Retirer une carte de l'ancien pool l'effacait.)
 */
export function relinkByTitle(): number {
  return db()
    .prepare(
      `UPDATE projects
          SET card_id = (SELECT card_id FROM cards WHERE cards.title = projects.title)
        WHERE card_id IS NULL AND state = 'published'
          AND (SELECT count(*) FROM cards WHERE cards.title = projects.title) = 1`,
    )
    .run().changes;
}

/** Ce qu'une synchronisation avec le compte Yoto a change, ou trouve d'anormal. */
export interface SyncReport {
  contents: number;
  added: string[];
  retitled: string[];
  relinked: number;
  /** Contenus supprimes chez Yoto, retires d'ici avec leur adresse relevee. */
  removed: { label: string; copies: number }[];
}

/**
 * Aligne les contenus connus ici sur la bibliotheque Yoto : chaque contenu du compte y entre, son
 * titre est mis a jour, et les histoires qui avaient perdu leur identifiant le retrouvent. Un
 * contenu supprime chez Yoto est retire d'ici, adresse relevee comprise : il ne serait plus
 * propose a la copie. Les puces qui le portent restent dans la liste des copies.
 */
export function syncContents(remote: { cardId: string; title: string }[]): SyncReport {
  const report: SyncReport = { contents: remote.length, added: [], retitled: [], relinked: 0, removed: [] };
  const insert = db().prepare('INSERT INTO cards (card_id, nickname, title) VALUES (?, ?, ?)');
  const retitle = db().prepare('UPDATE cards SET title = ? WHERE card_id = ?');

  db().transaction(() => {
    for (const content of remote) {
      const known = findByCardId(content.cardId);
      if (!known) {
        insert.run(content.cardId, content.title.slice(0, 60), content.title);
        report.added.push(content.title);
      } else if (known.title !== content.title) {
        retitle.run(content.title, content.cardId);
        // Un titre jamais vu n'est pas un changement : il manquait, simplement.
        if (known.title) report.retitled.push(`${known.title} → ${content.title}`);
      }
    }
  })();

  // Une bibliotheque vide alors qu'on connait des contenus ressemble plus a un incident chez Yoto
  // qu'a tout supprime : on ne retire rien sur cette seule foi.
  if (remote.length > 0) {
    const ids = new Set(remote.map((content) => content.cardId));
    db().transaction(() => {
      for (const card of listPool()) {
        if (ids.has(card.card_id)) continue;
        // L'identifiant departage deux contenus de meme titre (une histoire publiee deux fois).
        const label = card.title ? `« ${card.title} » (${card.card_id})` : card.card_id;
        report.removed.push({ label, copies: tagsFor(card.card_id).length });
        unenroll(card.card_id);
      }
    })();
  }
  report.relinked = relinkByTitle();
  return report;
}

/** Les noms des copies qui portent un contenu, pour les afficher. */
export function holderNames(holders: Holders | undefined): { names: string[]; anonymous: number } {
  const copies = holders?.copies ?? [];
  const names = copies.filter((tag) => tag.uid || tag.name).map((tag) => `« ${tagLabel(tag)} »`);
  return { names, anonymous: copies.filter((tag) => !tag.uid && !tag.name).length };
}

/** « « la bleue », « la rouge » et 2 copies sans nom » — ou rien. */
export function holdersSentence(holders: Holders | undefined): string {
  const { names, anonymous } = holderNames(holders);
  if (anonymous) names.push(`${anonymous} copie${anonymous > 1 ? 's' : ''} sans nom`);
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`;
}
