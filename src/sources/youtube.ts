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

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'SourceError';
    this.hint = hint;
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
  if (text.includes('video unavailable') || text.includes('private video')) {
    return new SourceError('Cette vidéo est indisponible ou privée.');
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

export type DownloadProgress = (message: string) => void;

/**
 * Telecharge la piste audio dans `targetDir` et rend le chemin du fichier.
 * On extrait en m4a : c'est ce que le lecteur accepte, et ca evite un ré-encodage cote Yoto.
 */
export async function downloadAudio(
  url: string,
  targetDir: string,
  onProgress: DownloadProgress = () => {},
): Promise<string> {
  const template = join(targetDir, 'source.%(ext)s');

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

  const produced = (await readdir(targetDir)).filter((name) => name.startsWith('source.'));
  const file = produced.find((name) => name.endsWith('.m4a')) ?? produced[0];
  if (!file) throw new SourceError("yt-dlp n'a produit aucun fichier.");
  return join(targetDir, file);
}
