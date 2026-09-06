/**
 * Construction de l'objet carte et publication sur une carte du pool.
 *
 * Publier ne touche jamais au tag NFC : on remplace le contenu associe au cardId, et la carte
 * physique joue autre chose a la prochaine insertion.
 */
import { basename, extname } from 'node:path';

import { iconRef, trackRef, updateCard, upsertCard } from '../yoto/api.ts';
import { YotoError } from '../yoto/errors.ts';
import type { Card, Chapter, Track } from '../yoto/types.ts';
import { MAX_CARD_BYTES, MAX_TRACKS_PER_CARD, type UploadedTrack } from './upload.ts';

export interface TrackInput extends UploadedTrack {
  title: string;
  /** mediaId d'une icone deja televersee, sans le prefixe `yoto:#`. */
  iconMediaId?: string | undefined;
}

export interface CardInput {
  title: string;
  tracks: TrackInput[];
  coverUrl?: string | undefined;
  author?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  languages?: string[] | undefined;
  minAge?: number | undefined;
  maxAge?: number | undefined;
}

/** Titre lisible depuis un nom de fichier : « 04 Le Renard.m4a » -> « Le Renard ». */
export function titleFromFilename(path: string): string {
  const stem = basename(path, extname(path));
  const cleaned = stem.replace(/^\s*\d+[\s._-]+/, '').replace(/_/g, ' ').trim();
  return cleaned || stem;
}

/**
 * Une piste par chapitre. La meme icone est posee sur le chapitre et sur la piste : le lecteur
 * affiche celle du chapitre en liste, celle de la piste en lecture.
 */
export function buildCard(input: CardInput): Card {
  if (input.tracks.length === 0) throw new YotoError('Une carte a besoin d’au moins une piste.');
  if (input.tracks.length > MAX_TRACKS_PER_CARD) {
    throw new YotoError(
      `${input.tracks.length} pistes : une carte n’en accepte que ${MAX_TRACKS_PER_CARD}.`,
    );
  }

  let totalDuration = 0;
  let totalSize = 0;

  const chapters: Chapter[] = input.tracks.map((entry, index) => {
    const position = index + 1;
    const duration = Number(entry.info?.duration ?? 0);
    const fileSize = Number(entry.info?.fileSize ?? 0);
    totalDuration += Number.isFinite(duration) ? duration : 0;
    totalSize += Number.isFinite(fileSize) ? fileSize : 0;

    // `icon16x16` : x minuscule. Une camelCase automatique produirait `icon16X16`, que Yoto
    // ignore sans erreur.
    const display = entry.iconMediaId ? { icon16x16: iconRef(entry.iconMediaId) } : undefined;

    const track: Track = {
      key: '01',
      title: entry.title,
      trackUrl: trackRef(entry.transcodedSha256),
      type: 'audio',
      overlayLabel: String(position),
      ...(entry.info?.format ? { format: entry.info.format } : {}),
      ...(duration ? { duration: Math.round(duration) } : {}),
      ...(fileSize ? { fileSize } : {}),
      ...(display ? { display } : {}),
    };

    return {
      key: String(position).padStart(2, '0'),
      title: entry.title,
      tracks: [track],
      overlayLabel: String(position),
      ...(display ? { display } : {}),
    };
  });

  if (totalSize > MAX_CARD_BYTES) {
    const mb = Math.round(totalSize / 1024 / 1024);
    throw new YotoError(`${mb} Mo au total ; la limite est de 500 Mo par carte.`);
  }

  return {
    title: input.title,
    content: { chapters, config: { autoadvance: 'next' } },
    metadata: {
      ...(input.coverUrl ? { cover: { imageL: input.coverUrl } } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.languages ? { languages: input.languages } : {}),
      ...(input.minAge === undefined ? {} : { minAge: input.minAge }),
      ...(input.maxAge === undefined ? {} : { maxAge: input.maxAge }),
      media: { duration: Math.round(totalDuration), fileSize: totalSize },
    },
  };
}

/**
 * Publie sur une carte existante du pool.
 *
 * Passe par une lecture-fusion-ecriture : la carte distante porte des champs non documentes
 * qu'un POST partiel effacerait. Les tableaux du patch remplacent, donc les anciens chapitres
 * disparaissent bien au lieu de se melanger aux nouveaux.
 */
export async function publishToCard(cardId: string, input: CardInput): Promise<Card> {
  const card = buildCard(input);
  return updateCard(cardId, card as unknown as Record<string, unknown>);
}

/** Cree un nouveau contenu MYO, sans carte physique associee. */
export async function publishAsNew(input: CardInput): Promise<Card> {
  return upsertCard(buildCard(input));
}
