/**
 * Emulateur de lecteur : ecouter le contenu d'un projet avant de le poser sur la Yoto.
 *
 * Deux sources d'audio, dans cet ordre :
 *  1. le fichier local, tant qu'il n'a pas ete purge — c'est le plus fidele et le plus rapide ;
 *  2. les URLs signees de Yoto, obtenues avec `?playable=true`, quand le projet est publie mais
 *     que les fichiers de travail ont disparu.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { getProject, listTracks, type TrackRow } from '../../db/projects.ts';
import { getCard } from '../../yoto/api.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout, raw } from '../html.ts';
import { motifCells } from '../motifs.ts';
import { requireAuth } from './auth.ts';

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
};

/** `bytes=0-` ou `bytes=1024-4095`. Rend undefined si l'en-tete est absent ou illisible. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  // Forme suffixe « bytes=-500 » : les 500 derniers octets.
  if (!rawStart) {
    const length = Number(rawEnd);
    if (!length) return undefined;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(start) || start > end || start >= size) return undefined;
  return { start, end };
}

const durationOf = (track: TrackRow): string => {
  if (!track.duration_ms) {
    const span = Math.round((track.end_ms - track.start_ms) / 1000);
    if (!span) return '—';
    return `${Math.floor(span / 60)}:${String(span % 60).padStart(2, '0')}`;
  }
  const seconds = Math.round(track.duration_ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * URL de lecture par piste. Les URLs signees de Yoto sont de courte duree : on ne les stocke
 * pas, on les redemande a chaque ouverture du lecteur.
 */
async function sources(projectId: number, tracks: TrackRow[], cardId: string | null): Promise<(string | null)[]> {
  const local = tracks.map((track) =>
    track.file_path ? `/projets/${projectId}/pistes/${track.idx}/audio` : null,
  );
  if (local.every(Boolean) || !cardId || !isConnected()) return local;

  try {
    const card = await getCard(cardId, true);
    const chapters = card.content?.chapters ?? [];
    return local.map((url, index) => {
      if (url) return url;
      const remote = chapters[index]?.tracks?.[0]?.trackUrl;
      // Avec `playable`, les references `yoto:#` sont resolues en URLs https signees ;
      // celles qui ne le sont pas restent injouables.
      return remote?.startsWith('http') ? remote : null;
    });
  } catch {
    return local;
  }
}

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { id: string } }>('/projets/:id/ecouter', async (request, reply) => {
    const projectId = Number(request.params.id);
    const project = getProject(projectId);
    if (!project) return reply.status(404).send('Projet introuvable.');

    const tracks = listTracks(projectId);
    const urls = await sources(projectId, tracks, project.card_id);

    const rows = tracks.map((track, index) => {
      const url = urls[index];
      return html`
        <li class="pl-track" data-src="${url ?? ''}" data-index="${index}">
          <button class="pl-play" type="button" ${url ? '' : raw('disabled')}
                  aria-label="Lire ${track.title}">
            <span class="pl-num">${index + 1}</span>
            <span class="pl-glyph" aria-hidden="true">▶</span>
          </button>
          <span class="pl-name">${track.title}</span>
          <span class="pl-dur">${url ? durationOf(track) : 'indisponible'}</span>
        </li>
      `;
    });

    const cells = motifCells(projectId)
      .map((colour) => `<span style="background:${colour}"></span>`)
      .join('');

    return reply.type('text/html').send(
      layout(
        { title: project.title, nav: 'cards' },
        html`
          <a class="back" href="/projets/${projectId}">← Retour au projet</a>
          <h1>${project.title}</h1>

          <div class="player-layout">
            <div class="player-body">
              <div class="player-screen" id="pl-screen" aria-hidden="true">${raw(cells)}</div>
              <div class="player-bar">
                <span class="player-knob"></span>
                <span class="player-track"><span id="pl-progress"></span></span>
                <span class="player-knob"></span>
              </div>
              <div class="player-now" id="pl-now">Choisis une piste</div>
            </div>

            <div>
              <p class="muted">
                ${tracks.length} piste(s). La lecture enchaîne automatiquement, comme sur le
                lecteur.
              </p>
              ${tracks.length === 0
                ? html`<p class="alert error">Ce projet n'a encore aucune piste.</p>`
                : html`<ul class="pl-list">${rows}</ul>`}
            </div>
          </div>

          <audio id="pl-audio" preload="none"></audio>
          <script src="/static/player.js"></script>
        `,
      ),
    );
  });

  /** Diffusion du fichier local, avec support des requetes de plage pour permettre le seek. */
  app.get<{ Params: { id: string; idx: string } }>(
    '/projets/:id/pistes/:idx/audio',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const index = Number(request.params.idx);

      const track = listTracks(projectId).find((entry) => entry.idx === index);
      if (!track?.file_path) return reply.status(404).send('Piste introuvable.');

      let size: number;
      try {
        size = (await stat(track.file_path)).size;
      } catch {
        return reply.status(410).send('Le fichier de travail a été purgé.');
      }

      const type = AUDIO_TYPES[extname(track.file_path).toLowerCase()] ?? 'application/octet-stream';
      const range = parseRange(request.headers.range, size);

      reply.header('Accept-Ranges', 'bytes').header('Content-Type', type);

      if (!range) {
        return reply.header('Content-Length', size).send(createReadStream(track.file_path));
      }

      return reply
        .status(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(createReadStream(track.file_path, { start: range.start, end: range.end }));
    },
  );
}
