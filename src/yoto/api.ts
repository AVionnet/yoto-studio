/** Les appels d'API dont l'application a besoin, avec leurs pieges encapsules. */
import { basename } from 'node:path';

import { YotoError } from './errors.ts';
import { putSigned, request } from './http.ts';
import type {
  Card,
  CardSummary,
  CoverImage,
  DisplayIcon,
  Transcoded,
  UploadSlot,
} from './types.ts';

/** Deballe `{ cle: valeur }` quand l'API enveloppe, sinon rend le corps tel quel. */
function unwrap<T>(body: unknown, key: string): T {
  if (body && typeof body === 'object' && key in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>)[key] as T;
  }
  return body as T;
}

// --- Contenu -----------------------------------------------------------------

export async function listMyCards(): Promise<CardSummary[]> {
  const { body } = await request('/content/mine');
  const cards = unwrap<CardSummary[] | undefined>(body, 'cards');
  return cards ?? [];
}

/**
 * `playable` fait resoudre les references `yoto:#…` en URLs signees de courte duree — utile
 * pour reecouter, jamais pour stocker.
 */
export async function getCard(cardId: string, playable = false): Promise<Card> {
  const { body } = await request(`/content/${encodeURIComponent(cardId)}`, {
    query: playable ? { playable: true, signingType: 's3' } : {},
  });
  return unwrap<Card>(body, 'card');
}

/** Creation si `cardId` est absent, mise a jour s'il est present. Meme endpoint. */
export async function upsertCard(card: Card): Promise<Card> {
  const { body } = await request('/content', { method: 'POST', json: card });
  return unwrap<Card>(body, 'card');
}

/**
 * Supprime un contenu MYO chez Yoto.
 *
 * Irreversible, et une carte physique liee a ce contenu cesse de jouer : il faut la relier dans
 * l'app Yoto pour lui redonner vie. Un 404 est traite comme un succes — le contenu n'existe
 * deja plus, l'intention est satisfaite.
 */
export async function deleteCard(cardId: string): Promise<void> {
  await request(`/content/${encodeURIComponent(cardId)}`, {
    method: 'DELETE',
    allowedStatuses: [404],
  });
}

/**
 * Fusion recursive : les objets se combinent, les tableaux et les scalaires du patch remplacent.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    const bothPlainObjects =
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value);
    merged[key] = bothPlainObjects
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged as T;
}

/**
 * Mise a jour en lecture-fusion-ecriture, jamais en POST direct : la reponse de l'API porte des
 * champs non documentes (`sortkey`, `userId`, `content.activity`, `chapters[].ambient`,
 * `tracks[].events`…) qu'un POST partiel effacerait.
 */
export async function updateCard(cardId: string, patch: Record<string, unknown>): Promise<Card> {
  const current = await getCard(cardId);
  const merged = deepMerge(current as Record<string, unknown>, patch);
  merged['cardId'] = cardId;
  return upsertCard(merged as Card);
}

// --- Media : audio -----------------------------------------------------------

export async function requestUploadSlot(sha256: string, filename: string): Promise<UploadSlot> {
  const { body } = await request('/media/transcode/audio/uploadUrl', {
    query: { sha256, filename: basename(filename) },
  });
  const slot = unwrap<UploadSlot>(body, 'upload');
  if (!slot?.uploadId) {
    throw new YotoError("La reponse ne contient pas d'uploadId.");
  }
  return slot;
}

export { putSigned as putUpload };

/**
 * Rend `undefined` tant que le transcodage n'est pas fini.
 *
 * 202 et 404 signifient « pas encore pret » — c'est undocumente, et les traiter comme des
 * erreurs casse tout le flux. Un 200 sans `transcodedSha256` est egalement « pas encore pret ».
 */
export async function getTranscode(uploadId: string, loudnorm = false): Promise<Transcoded | undefined> {
  const { status, body } = await request(
    `/media/upload/${encodeURIComponent(uploadId)}/transcoded`,
    { query: { loudnorm: String(loudnorm) }, allowedStatuses: [202, 404] },
  );
  if (status === 202 || status === 404) return undefined;

  const transcode = unwrap<Transcoded | undefined>(body, 'transcode');
  if (!transcode || typeof transcode !== 'object' || !transcode.transcodedSha256) return undefined;
  return transcode;
}

/** La reference que consomme `track.trackUrl`. */
export const trackRef = (transcodedSha256: string): string => `yoto:#${transcodedSha256}`;

// --- Media : images ----------------------------------------------------------

/**
 * Note : ce parametre s'ecrit `autoconvert` tout en minuscules ici, alors que l'endpoint des
 * icones utilise `autoConvert` en camelCase. L'asymetrie est reelle cote API.
 */
export async function uploadCover(
  bytes: Buffer,
  contentType: string,
  coverType = 'default',
  autoconvert = true,
): Promise<CoverImage> {
  const { body } = await request('/media/coverImage/user/me/upload', {
    method: 'POST',
    query: { autoconvert: String(autoconvert), coverType },
    body: bytes,
    contentType,
    timeoutMs: 120_000,
  });
  const cover = unwrap<CoverImage>(body, 'coverImage');
  if (!cover?.mediaUrl) throw new YotoError("La reponse ne contient pas de mediaUrl.");
  return cover;
}

// --- Icones ------------------------------------------------------------------

async function icons(path: string): Promise<DisplayIcon[]> {
  const { body } = await request(path);
  const list = unwrap<DisplayIcon[] | undefined>(body, 'displayIcons');
  return Array.isArray(list) ? list : [];
}

export const publicIcons = (): Promise<DisplayIcon[]> => icons('/media/displayIcons/user/yoto');
export const myIcons = (): Promise<DisplayIcon[]> => icons('/media/displayIcons/user/me');

/** Ici le parametre est bien `autoConvert` en camelCase — voir la note sur les covers. */
export async function uploadIcon(
  bytes: Buffer,
  filename: string,
  autoConvert = true,
): Promise<DisplayIcon> {
  const { body } = await request('/media/displayIcons/user/me/upload', {
    method: 'POST',
    query: { autoConvert: String(autoConvert), filename: basename(filename) },
    body: bytes,
    contentType: filename.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/png',
    timeoutMs: 60_000,
  });
  const icon = unwrap<DisplayIcon>(body, 'displayIcon');
  if (!icon?.mediaId) throw new YotoError("La reponse ne contient pas de mediaId.");
  return icon;
}

/** La reference que consomme `display.icon16x16` — avec un x minuscule. */
export const iconRef = (mediaId: string): string => `yoto:#${mediaId}`;

/** Recherche cote client : il n'existe aucun endpoint de recherche d'icones. */
export function searchIcons(list: DisplayIcon[], term: string): DisplayIcon[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return list;
  return list.filter(
    (icon) =>
      icon.title?.toLowerCase().includes(needle) ||
      icon.publicTags?.some((tag) => tag.toLowerCase().includes(needle)),
  );
}
