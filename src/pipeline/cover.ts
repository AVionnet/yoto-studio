/**
 * L'image de couverture d'un projet, du cote fichiers.
 *
 * Yoto ne garde qu'une version reduite de ce qu'on lui envoie, et c'est son URL qu'on stocke en
 * base : parfaite pour une vignette dans l'application, trop pauvre pour une etiquette imprimee
 * a 300 ppp. L'original est donc conserve ici, a cote des pistes du projet, et c'est lui que
 * l'impression utilise. Les projets dont la couverture est anterieure a cette conservation
 * retombent sur l'image distante.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Project } from '../db/projects.ts';
import { projectDir } from '../jobs/worker.ts';

/** Un nom de fichier unique par projet, l'extension disant le format a sharp. */
const BASENAME = 'cover';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Au-dela, ce n'est plus une couverture : on refuse de charger en memoire. */
const MAX_BYTES = 20 * 1024 * 1024;

async function findCover(projectId: number): Promise<string | undefined> {
  const directory = projectDir(projectId);
  try {
    const found = (await readdir(directory)).find((name) => name.startsWith(`${BASENAME}.`));
    return found ? join(directory, found) : undefined;
  } catch {
    return undefined; // le dossier du projet n'existe pas encore
  }
}

/** Garde l'original televerse. Une couverture remplacee efface la precedente, quel que soit son format. */
export async function storeCover(
  projectId: number,
  bytes: Buffer,
  mimetype: string,
): Promise<void> {
  const extension = EXTENSIONS[mimetype];
  if (!extension) return; // format inattendu : l'URL distante fera l'affaire

  await removeCover(projectId);
  const directory = projectDir(projectId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${BASENAME}${extension}`), bytes);
}

export async function removeCover(projectId: number): Promise<void> {
  const existing = await findCover(projectId);
  if (existing) await rm(existing, { force: true });
}

/**
 * Telecharge l'image distante, bornee en temps et en taille. Les messages sont des fragments
 * de phrase : l'appelant les recopie derriere « n'a pas pu être lue : ».
 */
async function download(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('l’image distante n’a pas répondu.');
  }
  if (!response.ok) throw new Error(`l’image distante répond ${response.status}.`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error('l’image distante est trop lourde.');
  return bytes;
}

/**
 * Les octets de la couverture, en preferant toujours l'original local.
 * Rend `undefined` quand le projet n'a pas de couverture du tout.
 */
export async function coverBytes(project: Project): Promise<Buffer | undefined> {
  const local = await findCover(project.id);
  if (local) return readFile(local);
  if (project.cover_url) return download(project.cover_url);
  return undefined;
}
