/**
 * Ingestion YouTube via yt-dlp.
 *
 * Depuis une IP de datacenter, YouTube applique son traitement le plus strict et aucun drapeau
 * n'y remedie : les cookies d'un compte connecte sont la seule defense fiable, et elle
 * s'erode. C'est pourquoi l'ingestion est une interface : le jour ou cette source se ferme,
 * le depot de fichiers et les flux RSS continuent de fonctionner.
 */
import { execa } from 'execa';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.ts';

export class SourceError extends Error {
  readonly hint: string | undefined;
  /** Vrai quand seule cette video est en cause : dans une playlist, on passe a la suivante. */
  readonly onlyThisVideo: boolean;

  constructor(message: string, hint?: string, onlyThisVideo = false) {
    super(message);
    this.name = 'SourceError';
    this.hint = hint;
    this.onlyThisVideo = onlyThisVideo;
  }
}

export interface RemoteMedia {
  id: string;
  title: string;
  durationSeconds: number | undefined;
  uploader: string | undefined;
  thumbnailUrl: string | undefined;
  webpageUrl: string;
}

function baseArgs(): string[] {
  const args = ['--no-playlist', '--no-progress', '--no-warnings'];
  if (config.ytdlp.cookiesFile) args.push('--cookies', config.ytdlp.cookiesFile);
  return args;
}

/**
 * Le rythme poli ne s'applique qu'au telechargement, jamais a la sonde.
 * `--sleep-requests 2` sur une simple lecture de metadonnees coute une dizaine de secondes
 * (12,7 s contre 2,6 s mesure) pour zero benefice : c'est un unique acces, pas un aspirateur.
 */
function politeArgs(): string[] {
  return ['--sleep-requests', '2'];
}

function translate(stderr: string): SourceError {
  const text = stderr.toLowerCase();

  if (text.includes('sign in to confirm') || text.includes('not a bot')) {
    return new SourceError(
      'YouTube demande une vérification humaine pour cette requête.',
      "Depuis un serveur, il faut fournir un fichier cookies.txt d'un compte connecté " +
        '(réglage YTDLP_COOKIES_FILE). Sinon, dépose le fichier audio directement.',
    );
  }
  if (text.includes('unable to extract')) {
    return new SourceError(
      "yt-dlp n'arrive plus à lire cette page.",
      'YouTube casse yt-dlp toutes les quelques semaines : commence par le mettre à jour.',
    );
  }
  if (
    text.includes('video unavailable') ||
    text.includes('private video') ||
    text.includes('not available in your country') ||
    text.includes('confirm your age')
  ) {
    return new SourceError('Cette vidéo est indisponible ou privée.', undefined, true);
  }
  if (text.includes('is not a valid url')) {
    return new SourceError("Cette adresse n'est pas reconnue.");
  }

  const lastLine = stderr.trim().split('\n').pop() ?? 'échec inconnu';
  return new SourceError(`yt-dlp : ${lastLine}`);
}

/** Metadonnees seules, sans rien telecharger. */
export async function probe(url: string): Promise<RemoteMedia> {
  try {
    const { stdout } = await execa('yt-dlp', [...baseArgs(), '--dump-single-json', url], {
      timeout: 30_000,
    });
    const data = JSON.parse(stdout) as Record<string, unknown>;
    return {
      id: String(data['id'] ?? ''),
      title: String(data['title'] ?? 'Sans titre'),
      durationSeconds: typeof data['duration'] === 'number' ? data['duration'] : undefined,
      uploader: typeof data['uploader'] === 'string' ? data['uploader'] : undefined,
      thumbnailUrl: typeof data['thumbnail'] === 'string' ? data['thumbnail'] : undefined,
      webpageUrl: typeof data['webpage_url'] === 'string' ? data['webpage_url'] : url,
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    if (stderr.includes('ENOENT') || (error as { code?: string }).code === 'ENOENT') {
      throw new SourceError('yt-dlp est introuvable sur ce serveur.', 'Installe-le : brew install yt-dlp');
    }
    throw translate(stderr);
  }
}

export interface PlaylistEntry {
  id: string;
  title: string;
  durationSeconds: number | undefined;
}

export interface RemotePlaylist {
  id: string;
  title: string;
  entries: PlaylistEntry[];
  /** Videos ecartees d'office : privees, supprimees, ou en direct. */
  skipped: number;
}

/**
 * L'identifiant de playlist porte par une adresse, s'il faut la traiter comme telle.
 *
 * `watch?v=…&list=…` est la forme qu'on partage depuis une playlist : on la prend entiere.
 * Les « mix » (RD…) sont des radios generees a l'infini pour chaque visiteur, pas une liste
 * qu'on a composee : la video seule est ce qu'on voulait.
 */
export function playlistIdOf(url: string): string | undefined {
  try {
    const list = new URL(url).searchParams.get('list');
    if (!list || list.startsWith('RD')) return undefined;
    return list;
  } catch {
    return undefined;
  }
}

/** Les titres que YouTube met a la place d'une video qu'on ne peut plus lire. */
const UNAVAILABLE_TITLES = new Set(['[Private video]', '[Deleted video]', '[Unavailable video]']);

/** Lecture a plat : titres et identifiants seuls, quelques secondes meme pour cent videos. */
export async function probePlaylist(url: string): Promise<RemotePlaylist> {
  const listId = playlistIdOf(url);
  if (!listId) throw new SourceError("Cette adresse n'est pas celle d'une playlist.");
  const canonical = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;

  let data: Record<string, unknown>;
  try {
    const args = ['--flat-playlist', '--yes-playlist', '--no-progress', '--no-warnings'];
    if (config.ytdlp.cookiesFile) args.push('--cookies', config.ytdlp.cookiesFile);
    const { stdout } = await execa('yt-dlp', [...args, '--dump-single-json', canonical], {
      timeout: 60_000,
    });
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new SourceError('yt-dlp est introuvable sur ce serveur.', 'Installe-le : brew install yt-dlp');
    }
    if (stderr.toLowerCase().includes('does not exist')) {
      throw new SourceError("Cette playlist n'existe pas, ou elle est privée.");
    }
    throw translate(stderr);
  }

  const raw = Array.isArray(data['entries']) ? (data['entries'] as Record<string, unknown>[]) : [];
  const entries: PlaylistEntry[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    const title = typeof entry['title'] === 'string' ? entry['title'] : '';
    const live = entry['live_status'] === 'is_live' || entry['live_status'] === 'is_upcoming';
    if (!id || UNAVAILABLE_TITLES.has(title) || live) {
      skipped += 1;
      continue;
    }
    entries.push({
      id,
      title: title || 'Sans titre',
      durationSeconds: typeof entry['duration'] === 'number' ? entry['duration'] : undefined,
    });
  }

  return {
    id: listId,
    title: typeof data['title'] === 'string' && data['title'] ? data['title'] : 'Playlist',
    entries,
    skipped,
  };
}

export const videoUrl = (id: string): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

export type DownloadProgress = (message: string) => void;

/**
 * Telecharge la piste audio dans `targetDir`, sous le nom `basename.<ext>`, et rend le chemin
 * du fichier. On extrait en m4a : c'est ce que le lecteur accepte, et ca evite un ré-encodage
 * cote Yoto.
 */
export async function downloadAudio(
  url: string,
  targetDir: string,
  onProgress: DownloadProgress = () => {},
  basename = 'source',
): Promise<string> {
  const template = join(targetDir, `${basename}.%(ext)s`);

  try {
    onProgress('Téléchargement…');
    await execa(
      'yt-dlp',
      [
        ...baseArgs(),
        ...politeArgs(),
        '-x',
        '--audio-format',
        'm4a',
        '--audio-quality',
        '0',
        '-o',
        template,
        url,
      ],
      { timeout: 45 * 60 * 1000 },
    );
  } catch (error) {
    throw translate((error as { stderr?: string }).stderr ?? String(error));
  }

  const produced = (await readdir(targetDir)).filter(
    (name) => name.startsWith(`${basename}.`) && !name.endsWith('.part'),
  );
  const file = produced.find((name) => name.endsWith('.m4a')) ?? produced[0];
  if (!file) throw new SourceError("yt-dlp n'a produit aucun fichier.");
  return join(targetDir, file);
}
