/**
 * Worker in-process : reclame un travail, l'execute, publie sa progression.
 *
 * Un seul travail a la fois. Le pipeline est deja parallele a l'interieur (televersements
 * bornes, sondage des transcodages en une passe), et une KVM d'entree de gamme n'a rien a
 * gagner a lancer deux ffmpeg en meme temps.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { runAs } from '../accounts/context.ts';
import { config } from '../config.ts';
import { enroll, rememberTitles } from '../db/cards.ts';
import {
  addTrack,
  getProject,
  listTracks,
  setProjectCard,
  setProjectState,
  setTrackIcon,
  setTrackTranscode,
} from '../db/projects.ts';
import { publishAsNew, publishToCard } from '../pipeline/publish.ts';
import { drawIcon } from '../sources/artwork.ts';
import { uploadIcon } from '../yoto/api.ts';
import { titleFromFilename } from '../pipeline/publish.ts';
import { CancelledError, uploadAndTranscode } from '../pipeline/upload.ts';
import { downloadAudio, SourceError, videoUrl } from '../sources/youtube.ts';
import {
  claimNext,
  fail,
  isCancelling,
  markCancelled,
  recoverOnBoot,
  reportProgress,
  succeed,
  type Job,
} from './queue.ts';

const POLL_INTERVAL_MS = 1000;

export interface BuildPayload {
  projectId: number;
  /** Vide pour creer un nouveau contenu : Yoto attribuera alors un cardId. */
  cardId?: string;
  title: string;
  /** Present quand la source est une URL a telecharger. */
  youtubeUrl?: string;
  /** Present quand la source est une playlist : une video par chapitre, dans l'ordre. */
  playlist?: { id: string; title: string }[];
}

export const projectDir = (projectId: number): string =>
  join(config.mediaDir, 'projects', String(projectId));

/**
 * Une seule piste pour l'instant : le decoupage en chapitres arrive au lot suivant, avec
 * l'ecran de validation des frontieres.
 */
async function ingest(job: Job, payload: BuildPayload): Promise<number> {
  if (payload.playlist) return ingestPlaylist(job, payload, payload.playlist);
  if (!payload.youtubeUrl) return 0;
  if (listTracks(payload.projectId).length > 0) return 0; // deja telecharge, reprise

  setProjectState(payload.projectId, 'fetching');
  reportProgress(job.id, 'Téléchargement de la source…', 0, 1);

  const directory = projectDir(payload.projectId);
  await mkdir(directory, { recursive: true });
  const file = await downloadAudio(payload.youtubeUrl, directory, (message) =>
    reportProgress(job.id, message, 0, 1),
  );

  const project = getProject(payload.projectId);
  addTrack({
    projectId: payload.projectId,
    idx: 0,
    title: project?.title || titleFromFilename(file),
    filePath: file,
  });
  return 0;
}

/**
 * Une video par chapitre ; rend le nombre de videos sautees. Les fichiers deja presents sont gardes : un redemarrage du serveur
 * au milieu d'une playlist de quarante videos reprend la ou il s'etait arrete. Les pistes ne
 * sont creees qu'a la fin, d'un coup, pour que leur presence signifie « tout est la ».
 *
 * Une video indisponible (privee, bloquee dans le pays) est sautee ; toute autre erreur —
 * verification anti-robot, yt-dlp absent — touchera aussi les suivantes, on s'arrete.
 */
async function ingestPlaylist(
  job: Job,
  payload: BuildPayload,
  entries: { id: string; title: string }[],
): Promise<number> {
  if (listTracks(payload.projectId).length > 0) return 0;

  setProjectState(payload.projectId, 'fetching');
  const directory = projectDir(payload.projectId);
  await mkdir(directory, { recursive: true });

  const done: { title: string; file: string }[] = [];
  let skipped = 0;

  for (const [index, entry] of entries.entries()) {
    if (isCancelling(job.id)) throw new CancelledError();
    const basename = String(index + 1).padStart(3, '0');
    const label = `Téléchargement ${index + 1}/${entries.length} : « ${entry.title} »`;
    reportProgress(job.id, label, index, entries.length);

    const existing = (await readdir(directory)).find(
      (name) => name.startsWith(`${basename}.`) && !name.endsWith('.part'),
    );
    if (existing) {
      done.push({ title: entry.title, file: join(directory, existing) });
      continue;
    }

    try {
      const file = await downloadAudio(videoUrl(entry.id), directory, () => {}, basename);
      done.push({ title: entry.title, file });
    } catch (error) {
      if (error instanceof SourceError && error.onlyThisVideo) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  if (done.length === 0) throw new Error("Aucune vidéo de la playlist n'a pu être téléchargée.");

  done.forEach((entry, idx) =>
    addTrack({ projectId: payload.projectId, idx, title: entry.title, filePath: entry.file }),
  );
  reportProgress(
    job.id,
    skipped === 0
      ? `${done.length} chapitre(s) téléchargé(s).`
      : `${done.length} chapitre(s) téléchargé(s), ${skipped} vidéo(s) indisponible(s) sautée(s).`,
    entries.length,
    entries.length,
  );
  return skipped;
}

async function runBuild(job: Job): Promise<unknown> {
  const payload = JSON.parse(job.payload_json) as BuildPayload;

  const skipped = await ingest(job, payload);
  if (isCancelling(job.id)) throw new CancelledError();

  const rows = listTracks(payload.projectId);
  if (rows.length === 0) throw new Error('Ce projet ne contient aucune piste.');

  const paths = rows.map((row) => {
    if (!row.file_path) throw new Error(`La piste « ${row.title} » n'a pas de fichier.`);
    return row.file_path;
  });

  setProjectState(payload.projectId, 'uploading');

  const uploaded = await uploadAndTranscode(
    paths,
    (message, done, total) => reportProgress(job.id, message, done, total),
    () => isCancelling(job.id),
  );

  // On note les sha au fur et a mesure : une republication ulterieure sera deduplicee et
  // n'aura plus rien a transferer.
  uploaded.forEach((entry, index) => {
    const row = rows[index]!;
    setTrackTranscode(
      payload.projectId,
      row.idx,
      entry.transcodedSha256,
      entry.info?.duration ? Math.round(Number(entry.info.duration) * 1000) : null,
      entry.info?.fileSize ? Number(entry.info.fileSize) : null,
    );
  });

  reportProgress(job.id, 'Publication de la carte…', uploaded.length, uploaded.length);

  const input = {
    title: payload.title,
    coverUrl: getProject(payload.projectId)?.cover_url ?? undefined,
    tracks: uploaded.map((entry, index) => ({
      ...entry,
      title: rows[index]!.title,
      iconMediaId: rows[index]!.icon_media_id ?? undefined,
    })),
  };

  // Sans carte de destination, on cree un contenu neuf : Yoto lui attribue un cardId, qui
  // entre aussitot dans le pool. Il ne restera qu'a le lier une fois a une carte physique.
  const card = payload.cardId
    ? await publishToCard(payload.cardId, input)
    : await publishAsNew(input);

  const isNew = !payload.cardId;
  if (card.cardId) {
    if (isNew) enroll(card.cardId, payload.title);
    rememberTitles([{ cardId: card.cardId, title: payload.title }]);
    setProjectCard(payload.projectId, card.cardId);
  }

  setProjectState(payload.projectId, 'published');
  return { cardId: card.cardId, title: card.title, trackCount: uploaded.length, isNew, skipped };
}

export interface ArtworkPayload {
  projectId: number;
  /** Redessiner aussi les pistes qui ont deja une icone. */
  all?: boolean;
}

/**
 * Une icone par piste, dessinee puis televersee chez Yoto.
 *
 * Un echec isole ne fait pas tomber le lot : sur dix chapitres, le modele en rate parfois un,
 * et perdre les neuf autres pour autant serait absurde. Le compte des rates est rendu a la fin.
 */
async function runArtwork(job: Job): Promise<unknown> {
  const payload = JSON.parse(job.payload_json) as ArtworkPayload;

  const tracks = listTracks(payload.projectId).filter(
    (track) => payload.all || !track.icon_media_id,
  );
  if (tracks.length === 0) throw new Error('Toutes les pistes ont déjà une icône.');

  let drawn = 0;
  let failed = 0;

  for (const [index, track] of tracks.entries()) {
    if (isCancelling(job.id)) throw new CancelledError();
    reportProgress(job.id, `Dessin de « ${track.title} »…`, index, tracks.length);

    try {
      const icon = await drawIcon({
        subject: track.title,
        story: getProject(payload.projectId)?.title,
        text: track.text ?? undefined,
      });
      const uploaded = await uploadIcon(icon, `piste-${track.idx + 1}.png`);
      setTrackIcon(payload.projectId, track.idx, uploaded.mediaId, uploaded.url ?? null);
      drawn += 1;
    } catch {
      failed += 1;
    }
  }

  reportProgress(
    job.id,
    failed === 0
      ? `${drawn} icône(s) dessinée(s).`
      : `${drawn} icône(s) dessinée(s), ${failed} en échec.`,
    tracks.length,
    tracks.length,
  );
  if (drawn === 0) throw new Error("Aucune icône n'a pu être dessinée.");

  return { drawn, failed };
}

const HANDLERS: Record<string, (job: Job) => Promise<unknown>> = {
  build: runBuild,
  artwork: runArtwork,
};

async function runOne(job: Job): Promise<void> {
  const handler = HANDLERS[job.kind];
  if (!handler) {
    fail(job.id, `Type de travail inconnu : ${job.kind}`);
    return;
  }

  try {
    succeed(job.id, await handler(job));
  } catch (error) {
    if (error instanceof CancelledError) {
      markCancelled(job.id);
      if (job.project_id && job.kind === 'build') setProjectState(job.project_id, 'draft');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(job.id, message);
    // Seule la fabrication porte l'etat du projet : un dessin rate ne rend pas la carte
    // invalide, et la marquer « echec » effacerait l'etat « publiee » qu'elle vient d'obtenir.
    if (job.project_id && job.kind === 'build') setProjectState(job.project_id, 'failed', message);
  }
}

let running = false;

export function startWorker(log: { info: (msg: string) => void; error: (msg: string) => void }): void {
  const { requeued, purged } = recoverOnBoot();
  if (requeued || purged) {
    log.info(`file de travaux : ${requeued} repris, ${purged} purgés`);
  }

  running = true;

  void (async () => {
    while (running) {
      const job = claimNext();
      if (!job) {
        await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
        continue;
      }
      log.info(`travail ${job.id} (${job.kind}) démarré pour le compte ${job.account_id}`);
      // Base et Yoto sont lus au nom du compte du travail : ses jetons, ses projets.
      await runAs(job.account_id, () => runOne(job));
      log.info(`travail ${job.id} terminé`);
    }
  })();
}

export function stopWorker(): void {
  running = false;
}
