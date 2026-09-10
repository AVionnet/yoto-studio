/** Projets et pistes. */
import { db } from './index.ts';

export type ProjectState =
  | 'draft'
  | 'fetching'
  | 'segmenting'
  | 'reviewing'
  | 'uploading'
  | 'published'
  | 'failed';

export interface Project {
  id: number;
  title: string;
  state: ProjectState;
  source_kind: string | null;
  source_ref: string | null;
  source_path: string | null;
  card_id: string | null;
  artwork_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackRow {
  id: number;
  project_id: number;
  idx: number;
  title: string;
  text: string | null;
  start_ms: number;
  end_ms: number;
  file_path: string | null;
  duration_ms: number | null;
  file_size: number | null;
  head_db: number | null;
  tail_db: number | null;
  transcoded_sha256: string | null;
  icon_media_id: string | null;
  /** Apercu seulement, jamais envoye a Yoto : la carte publiee ne connait que icon_media_id. */
  icon_url: string | null;
}

export function createProject(fields: {
  title: string;
  sourceKind: string;
  cardId?: string | undefined;
}): number {
  const info = db()
    .prepare(
      `INSERT INTO projects (title, source_kind, card_id, state) VALUES (?, ?, ?, 'draft')`,
    )
    .run(fields.title, fields.sourceKind, fields.cardId ?? null);
  return Number(info.lastInsertRowid);
}

export function getProject(id: number): Project | undefined {
  return db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function listProjects(): Project[] {
  return db().prepare('SELECT * FROM projects ORDER BY id DESC').all() as Project[];
}

export function setProjectState(id: number, state: ProjectState, error?: string | null): void {
  db()
    .prepare(`UPDATE projects SET state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(state, error ?? null, id);
}

export interface ProjectSummary extends Project {
  track_count: number;
  /** Somme des durees connues, en millisecondes. Nulle tant que rien n'est transcode. */
  total_ms: number;
  /** Icone de la premiere piste, pour la vignette d'accueil. Nulle sans icone choisie. */
  icon_url: string | null;
}

/** Les projets avec de quoi remplir une vignette, en une seule requete. */
export function listProjectSummaries(): ProjectSummary[] {
  return db()
    .prepare(
      `SELECT p.*,
              count(t.id) AS track_count,
              coalesce(sum(t.duration_ms), 0) AS total_ms,
              (SELECT icon_url FROM tracks WHERE project_id = p.id AND idx = 0) AS icon_url
       FROM projects p
       LEFT JOIN tracks t ON t.project_id = p.id
       GROUP BY p.id
       ORDER BY p.id DESC`,
    )
    .all() as ProjectSummary[];
}

export function deleteProject(id: number): void {
  // Les pistes et les travaux partent en cascade (ON DELETE CASCADE).
  db().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function setProjectCard(id: number, cardId: string): void {
  db()
    .prepare(`UPDATE projects SET card_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(cardId, id);
}

export function addTrack(fields: {
  projectId: number;
  idx: number;
  title: string;
  /** Absent tant que la piste n'a pas ete enregistree. */
  filePath?: string | undefined;
  text?: string | undefined;
  startMs?: number;
  endMs?: number;
}): void {
  db()
    .prepare(
      `INSERT INTO tracks (project_id, idx, title, text, start_ms, end_ms, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.projectId,
      fields.idx,
      fields.title,
      fields.text ?? null,
      fields.startMs ?? 0,
      fields.endMs ?? 0,
      fields.filePath ?? null,
    );
}

/** Rattache un fichier fraichement enregistre a une piste existante. */
export function setTrackFile(projectId: number, idx: number, filePath: string, durationMs: number): void {
  db()
    .prepare(
      `UPDATE tracks SET file_path = ?, duration_ms = ? WHERE project_id = ? AND idx = ?`,
    )
    .run(filePath, durationMs, projectId, idx);
}

export function listTracks(projectId: number): TrackRow[] {
  return db()
    .prepare('SELECT * FROM tracks WHERE project_id = ? ORDER BY idx')
    .all(projectId) as TrackRow[];
}

/**
 * Associe (ou retire, si `mediaId` est nul) l'icone 16x16 d'une piste deja televersee chez Yoto.
 * `url` n'est qu'un apercu pour l'interface : absent, l'icone reste sans vignette mais fonctionne
 * quand meme a la publication.
 */
export function setTrackIcon(
  projectId: number,
  idx: number,
  mediaId: string | null,
  url: string | null = null,
): void {
  db()
    .prepare(`UPDATE tracks SET icon_media_id = ?, icon_url = ? WHERE project_id = ? AND idx = ?`)
    .run(mediaId, mediaId ? url : null, projectId, idx);
}

export function setTrackTranscode(
  projectId: number,
  idx: number,
  sha256: string,
  durationMs: number | null,
  fileSize: number | null,
): void {
  db()
    .prepare(
      `UPDATE tracks SET transcoded_sha256 = ?, duration_ms = ?, file_size = ?
       WHERE project_id = ? AND idx = ?`,
    )
    .run(sha256, durationMs, fileSize, projectId, idx);
}
