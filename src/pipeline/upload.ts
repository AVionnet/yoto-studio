/**
 * Upload audio vers Yoto.
 *
 * Deux temps volontairement separes : on televerse d'abord tous les fichiers, puis on sonde
 * tous les transcodages ensemble. Yoto transcode en concurrence cote serveur, donc enchainer
 * upload+attente piste par piste gaspille l'essentiel du temps.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { getTranscode, putUpload, requestUploadSlot } from '../yoto/api.ts';
import { TranscodeTimeoutError, YotoError } from '../yoto/errors.ts';
import type { TranscodedInfo } from '../yoto/types.ts';

/**
 * L'API annonce 1 Go par fichier, mais l'interface web de Yoto s'arrete a ~100 Mo. On se cale
 * sur la limite basse : une piste qui passe l'API mais pas l'app serait un piege silencieux.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TRACKS_PER_CARD = 100;
export const MAX_CARD_BYTES = 500 * 1024 * 1024;

/** Televersements simultanes. Chaque fichier transite par la memoire, d'ou la borne. */
const UPLOAD_CONCURRENCY = 3;

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

export const AUDIO_EXTENSIONS = Object.keys(CONTENT_TYPES);

export const contentTypeFor = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Empreinte en flux : un fichier de 100 Mo ne doit pas etre charge deux fois. */
export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

export interface PendingUpload {
  path: string;
  uploadId: string;
  /** Vrai quand Yoto connaissait deja le fichier : aucun octet n'a transite. */
  deduplicated: boolean;
}

export interface UploadedTrack {
  path: string;
  transcodedSha256: string;
  info: TranscodedInfo | undefined;
}

export type Progress = (message: string, done: number, total: number) => void;
export type CancelCheck = () => boolean;

const noProgress: Progress = () => {};
const neverCancelled: CancelCheck = () => false;

export class CancelledError extends Error {
  constructor() {
    super('Travail annule.');
    this.name = 'CancelledError';
  }
}

/** Etape 1 : obtenir un emplacement et y deposer le fichier, sauf s'il est deja connu. */
export async function uploadOne(path: string): Promise<PendingUpload> {
  const info = await stat(path);
  if (!info.isFile()) throw new YotoError(`Ce n'est pas un fichier : ${path}`);
  if (info.size > MAX_FILE_BYTES) {
    const mb = Math.round(info.size / 1024 / 1024);
    throw new YotoError(`${basename(path)} fait ${mb} Mo ; la limite est de 100 Mo par piste.`);
  }

  const sha256 = await sha256File(path);
  const slot = await requestUploadSlot(sha256, path);

  if (!slot.uploadUrl) {
    return { path, uploadId: slot.uploadId, deduplicated: true };
  }

  await putUpload(slot.uploadUrl, await readFile(path), contentTypeFor(path));
  return { path, uploadId: slot.uploadId, deduplicated: false };
}

/** Petit ordonnanceur borne : garde `limit` travaux en vol, preserve l'ordre des resultats. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function uploadAll(
  paths: string[],
  onProgress: Progress = noProgress,
  isCancelled: CancelCheck = neverCancelled,
): Promise<PendingUpload[]> {
  let done = 0;
  return mapLimit(paths, UPLOAD_CONCURRENCY, async (path) => {
    if (isCancelled()) throw new CancelledError();
    const pending = await uploadOne(path);
    done += 1;
    onProgress(
      pending.deduplicated
        ? `${basename(path)} déjà connu de Yoto`
        : `${basename(path)} téléversé`,
      done,
      paths.length,
    );
    return pending;
  });
}

/**
 * Etape 2 : attendre les transcodages, tous en parallele.
 *
 * L'endpoint repond 202 ou 404 tant que ce n'est pas pret — ce sont des etats normaux, pas des
 * erreurs. La couche API les traduit deja en `undefined`.
 */
export async function awaitTranscodes(
  pending: PendingUpload[],
  onProgress: Progress = noProgress,
  isCancelled: CancelCheck = neverCancelled,
  { intervalMs = 2000, timeoutMs = 600_000 } = {},
): Promise<UploadedTrack[]> {
  const results = new Map<string, UploadedTrack>();
  const deadline = Date.now() + timeoutMs;

  while (results.size < pending.length) {
    if (isCancelled()) throw new CancelledError();

    if (Date.now() > deadline) {
      const missing = pending.filter((item) => !results.has(item.uploadId));
      throw new TranscodeTimeoutError(
        `Transcodage inachevé après ${Math.round(timeoutMs / 1000)} s pour ` +
          missing.map((item) => basename(item.path)).join(', '),
      );
    }

    const outstanding = pending.filter((item) => !results.has(item.uploadId));
    const answers = await Promise.all(
      outstanding.map(async (item) => ({ item, transcode: await getTranscode(item.uploadId) })),
    );

    for (const { item, transcode } of answers) {
      if (!transcode) continue;
      results.set(item.uploadId, {
        path: item.path,
        transcodedSha256: transcode.transcodedSha256,
        info: transcode.transcodedInfo,
      });
    }

    onProgress(`Transcodage : ${results.size}/${pending.length}`, results.size, pending.length);

    if (results.size < pending.length) {
      // Sommeil fractionne pour que l'annulation reste reactive.
      for (let waited = 0; waited < intervalMs; waited += 250) {
        if (isCancelled()) throw new CancelledError();
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  }

  // L'ordre d'entree fait foi : c'est celui des pistes sur la carte.
  return pending.map((item) => results.get(item.uploadId)!);
}

/** Le flux complet, dans le bon ordre. */
export async function uploadAndTranscode(
  paths: string[],
  onProgress: Progress = noProgress,
  isCancelled: CancelCheck = neverCancelled,
): Promise<UploadedTrack[]> {
  if (paths.length > MAX_TRACKS_PER_CARD) {
    throw new YotoError(
      `${paths.length} pistes : une carte n'en accepte que ${MAX_TRACKS_PER_CARD}.`,
    );
  }
  const pending = await uploadAll(paths, onProgress, isCancelled);
  return awaitTranscodes(pending, onProgress, isCancelled);
}
