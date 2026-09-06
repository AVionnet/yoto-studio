/**
 * Fabrication d'une carte : source, publication, progression.
 *
 * Le travail long tourne dans le worker ; la page ne fait que le suivre. Un rafraichissement
 * pendant l'upload ne perd rien, l'etat vit en base.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

import { findByCardId, listPool, unenroll } from '../../db/cards.ts';
import {
  addTrack,
  createProject,
  deleteProject,
  getProject,
  listTracks,
} from '../../db/projects.ts';
import { enqueue, getJob, isTerminal, latestJobFor, requestCancel } from '../../jobs/queue.ts';
import { projectDir } from '../../jobs/worker.ts';
import { titleFromFilename } from '../../pipeline/publish.ts';
import { AUDIO_EXTENSIONS } from '../../pipeline/upload.ts';
import { probe } from '../../sources/youtube.ts';
import { deleteCard } from '../../yoto/api.ts';
import { html, layout, raw, type Html } from '../html.ts';
import { requireAuth } from './auth.ts';

/** Lien vers la fiche du contenu dans l'application web de Yoto. */
function yotoLink(cardId: string | null): Html | string {
  if (!cardId) return '';
  const url = `https://my.yotoplay.com/cards/${encodeURIComponent(cardId)}`;
  return html`<a class="button" href="${url}" target="_blank" rel="noopener">
    Ouvrir chez Yoto ${raw(EXTERNAL_ICON)}
  </a>`;
}

const TRASH_ICON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

const EXTERNAL_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'];

function isYoutubeUrl(value: string): boolean {
  try {
    return YOUTUBE_HOSTS.includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Soumissions en vol, par jeton. Le verrou est synchrone et le processus unique : deux clics
 * rapprochés ne peuvent pas passer tous les deux, ce qu'un simple jeton en session ne garantit
 * pas — la session n'est réécrite qu'à la fin de la requête, donc la seconde lirait encore
 * l'ancienne valeur.
 */
const inFlight = new Set<string>();

function newProjectPage(token: string, error?: string): string {
  const pool = listPool();

  return layout(
    { title: 'Nouvelle carte', nav: 'projects' },
    html`
      <h1>Nouvelle carte</h1>
      ${error ? html`<p class="alert error">${error}</p>` : ''}
      <form class="panel" method="post" action="/projets" enctype="multipart/form-data"
            data-guard>
        <input type="hidden" name="token" value="${token}">

        <label for="title">Titre de la carte</label>
        <input id="title" name="title" required maxlength="140"
               placeholder="Jack et le haricot magique">

        <label for="cardId">Destination</label>
        <select id="cardId" name="cardId">
          <option value="">Nouvelle carte — à lier une fois dans l'app Yoto</option>
          ${pool.map(
            (card) =>
              html`<option value="${card.card_id}">
                ${card.nickname} — remplacer son contenu (${card.track_count} piste(s))
              </option>`,
          )}
        </select>
        <p class="muted">
          ${pool.length === 0
            ? html`Ton compte ne contient encore aucun contenu MYO. La première carte en créera
                un ; tu la lieras ensuite à une carte physique, une seule fois.`
            : html`Réutiliser une carte du pool remplace son contenu. Le tag NFC n'est jamais
                touché.`}
        </p>

        <div class="tabs" data-tabs>
          <div class="tablist" role="tablist" aria-label="Source audio">
            <button type="button" role="tab" data-tab="youtube">YouTube</button>
            <button type="button" role="tab" data-tab="fichiers">Fichiers audio</button>
          </div>

          <div class="tabpanel" data-panel="youtube" role="tabpanel">
            <label for="youtubeUrl">Adresse de la vidéo</label>
            <input id="youtubeUrl" name="youtubeUrl" type="url"
                   placeholder="https://www.youtube.com/watch?v=…">
            <p class="muted">La bande son est extraite, la vidéo est ignorée.</p>
          </div>

          <div class="tabpanel" data-panel="fichiers" role="tabpanel">
            <label for="files">Fichiers à déposer</label>
            <input id="files" name="files" type="file" multiple
                   accept="${AUDIO_EXTENSIONS.join(',')}">
            <p class="muted">
              MP3, M4A, FLAC, WAV… Un fichier donne une piste, dans l'ordre alphabétique.
            </p>
          </div>
        </div>

        <button type="submit" data-busy-label="Préparation…">Fabriquer</button>
        <p class="muted" data-busy-note hidden>
          Lecture de la source, quelques secondes. Ne recharge pas la page.
        </p>
      </form>
      <script src="/static/tabs.js"></script>
      <script src="/static/form.js"></script>
    `,
  );
}

/** Réaffiche le formulaire avec un jeton neuf : sans ça, corriger une erreur serait bloqué. */
function reissue(request: { session: { formToken?: string } }, error: string): string {
  const token = randomUUID();
  request.session.formToken = token;
  return newProjectPage(token, error);
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/projets/nouveau', async (request, reply) => {
    const token = randomUUID();
    request.session.formToken = token;
    return reply.type('text/html').send(newProjectPage(token));
  });

  app.post('/projets', async (request, reply) => {
    const fields = new Map<string, string>();
    const staging = await mkdtemp(join(tmpdir(), 'yoto-upload-'));
    const staged: { path: string; name: string }[] = [];
    let accepted: string | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (!part.filename) {
            await part.file.resume();
            continue;
          }
          if (!AUDIO_EXTENSIONS.includes(extname(part.filename).toLowerCase())) {
            await part.file.resume();
            continue;
          }
          const target = join(staging, `${staged.length}${extname(part.filename)}`);
          await pipeline(part.file, createWriteStream(target));
          staged.push({ path: target, name: part.filename });
        } else {
          fields.set(part.fieldname, String(part.value));
        }
      }

      const token = fields.get('token') ?? '';
      const issued = request.session.formToken;

      // Rejet avant la sonde : c'est elle qui dure, donc c'est pendant elle qu'on re-clique.
      if (!token || token !== issued || inFlight.has(token)) {
        return reply.redirect('/');
      }
      inFlight.add(token);
      accepted = token;
      // Le jeton est brûlé : un retour arrière suivi d'un renvoi ne repassera pas.
      delete request.session.formToken;

      const title = fields.get('title')?.trim() ?? '';
      const cardId = fields.get('cardId')?.trim() ?? '';
      const youtubeUrl = fields.get('youtubeUrl')?.trim() ?? '';

      if (!title) {
        return reply.type('text/html').send(reissue(request, 'Le titre est obligatoire.'));
      }
      if (!youtubeUrl && staged.length === 0) {
        return reply
          .type('text/html')
          .send(reissue(request, 'Donne une adresse YouTube ou dépose au moins un fichier.'));
      }
      if (youtubeUrl && !isYoutubeUrl(youtubeUrl)) {
        return reply.type('text/html').send(reissue(request, "Cette adresse n'est pas une URL YouTube."));
      }

      // Sonde avant de creer quoi que ce soit : une URL morte doit echouer tout de suite,
      // avec un message utile, plutot que dans le worker cinq minutes plus tard.
      if (youtubeUrl) {
        try {
          await probe(youtubeUrl);
        } catch (error) {
          const hint = (error as { hint?: string }).hint;
          return reply
            .type('text/html')
            .send(reissue(request, `${(error as Error).message}${hint ? ` ${hint}` : ''}`));
        }
      }

      const projectId = createProject({
        title,
        sourceKind: youtubeUrl ? 'youtube' : 'upload',
        ...(cardId ? { cardId } : {}),
      });

      if (staged.length > 0) {
        const directory = projectDir(projectId);
        await mkdir(directory, { recursive: true });
        for (const [index, file] of staged.entries()) {
          const final = join(directory, `${String(index + 1).padStart(2, '0')}${extname(file.name)}`);
          await rename(file.path, final);
          addTrack({
            projectId,
            idx: index,
            title: titleFromFilename(file.name),
            filePath: final,
          });
        }
      }

      enqueue(
        'build',
        { projectId, title, ...(cardId ? { cardId } : {}), ...(youtubeUrl ? { youtubeUrl } : {}) },
        projectId,
      );
      return reply.redirect(`/projets/${projectId}`);
    } finally {
      if (accepted) inFlight.delete(accepted);
      await rm(staging, { recursive: true, force: true });
    }
  });

  app.get<{ Params: { id: string } }>('/projets/:id', async (request, reply) => {
    const project = getProject(Number(request.params.id));
    if (!project) return reply.status(404).send('Projet introuvable.');

    const job = latestJobFor(project.id);
    const tracks = listTracks(project.id);
    const running = job ? !isTerminal(job.state) : false;
    const poolCard = project.card_id ? findByCardId(project.card_id) : undefined;
    const pool = listPool();
    const missing = tracks.filter((track) => !track.file_path).length;
    // Republier n'a de sens que si le projet a des pistes et que rien ne tourne deja.
    const publishable = tracks.length > 0 && !running;

    return reply.type('text/html').send(
      layout(
        { title: project.title, nav: 'projects' },
        html`
          <h1>${project.title}</h1>

          <section class="panel">
            <div id="etat" data-project="${project.id}" data-running="${running ? '1' : '0'}">
              ${job
                ? html`
                    <p class="alert ${job.state === 'error' ? 'error' : job.state === 'done' ? 'ok' : ''}">
                      <span id="message">${job.error ?? job.message}</span>
                    </p>
                    <progress id="barre" value="${job.progress}" max="${job.total || 1}"></progress>
                  `
                : html`<p class="muted">Aucun travail en cours.</p>`}
            </div>

            ${running
              ? html`<form method="post" action="/projets/${project.id}/annuler">
                  <button class="link" type="submit">Annuler</button>
                </form>`
              : ''}

            ${job?.state === 'done'
              ? (JSON.parse(job.result_json ?? '{}') as { isNew?: boolean }).isNew
                ? html`<div class="alert ok" style="display:block">
                    <p><strong>Contenu créé</strong> sous l'identifiant <code>${project.card_id}</code>.</p>
                    <p>
                      Dernière étape manuelle, une seule fois dans la vie de cette carte : ouvre
                      ce contenu chez Yoto, choisis « Link to a card » et approche une carte MYO
                      vierge. Ensuite, republier dessus ne demandera plus rien.
                    </p>
                    <p style="margin:0">${yotoLink(project.card_id)}</p>
                  </div>`
                : html`<div class="alert ok" style="display:block">
                    <p>Carte <code>${project.card_id}</code> mise à jour. Insère-la dans le lecteur.</p>
                    <p style="margin:0">${yotoLink(project.card_id)}</p>
                  </div>`
              : ''}
          </section>

          ${publishable
            ? html`
                <section class="panel">
                  <h2>Publier sur une carte</h2>
                  ${missing > 0
                    ? html`<p class="alert error">
                        ${missing} chapitre(s) n'ont pas encore de son.
                        <a href="/projets/${project.id}/enregistrer">Aller les enregistrer</a>.
                      </p>`
                    : html`
                        <form method="post" action="/projets/${project.id}/publier" data-guard>
                          <label for="cardId">Destination</label>
                          <select id="cardId" name="cardId">
                            <option value="">Nouvelle carte — à lier une fois dans l'app Yoto</option>
                            ${pool.map(
                              (card) => html`<option value="${card.card_id}"
                                  ${card.card_id === project.card_id ? raw('selected') : ''}>
                                  ${card.nickname} — remplacer son contenu
                                </option>`,
                            )}
                          </select>
                          <button type="submit" data-busy-label="Envoi…">
                            ${project.state === 'published' ? 'Republier' : 'Publier'}
                          </button>
                        </form>
                        <script src="/static/form.js"></script>
                      `}
                </section>
              `
            : ''}

          ${tracks.length > 0
            ? html`<section class="panel">
                <h2>${tracks.length} piste(s)</h2>
                <p>
                  <a class="button" href="/projets/${project.id}/ecouter">Écouter</a>
                </p>
                <table>
                  <thead><tr><th>#</th><th>Titre</th><th>Transcodé</th></tr></thead>
                  <tbody>
                    ${tracks.map(
                      (track) => html`<tr>
                        <td>${track.idx + 1}</td>
                        <td>${track.title}</td>
                        <td>${track.transcoded_sha256 ? '✓' : '—'}</td>
                      </tr>`,
                    )}
                  </tbody>
                </table>
              </section>`
            : ''}

          <section class="panel danger">
            <h2>Supprimer ce projet</h2>
            <p class="muted">
              Efface les pistes, les fichiers de travail et l'historique de cette application.
            </p>
            <form method="post" action="/projets/${project.id}/supprimer"
                  onsubmit="return confirm('Supprimer « ${project.title} » ?')">
              ${project.card_id
                ? html`
                    <label class="check">
                      <input type="checkbox" name="alsoYoto" value="1" checked>
                      <span>
                        Supprimer aussi le contenu <code>${project.card_id}</code> chez Yoto.
                        ${poolCard
                          ? html`<strong>La carte « ${poolCard.nickname} » cessera de jouer</strong>
                              tant qu'elle n'aura pas été reliée à un autre contenu dans l'app.`
                          : html`Irréversible.`}
                      </span>
                    </label>
                  `
                : ''}
              <button class="danger" type="submit">
                ${raw(TRASH_ICON)} Supprimer
              </button>
            </form>
          </section>

          <script src="/static/progress.js"></script>
        `,
      ),
    );
  });

  app.post<{ Params: { id: string }; Body: { cardId?: string } }>(
    '/projets/:id/publier',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const project = getProject(projectId);
      if (!project) return reply.redirect('/');

      const tracks = listTracks(projectId);
      if (tracks.length === 0 || tracks.some((track) => !track.file_path)) {
        return reply.redirect(`/projets/${projectId}`);
      }

      const cardId = request.body?.cardId?.trim() ?? '';
      enqueue(
        'build',
        { projectId, title: project.title, ...(cardId ? { cardId } : {}) },
        projectId,
      );
      return reply.redirect(`/projets/${projectId}`);
    },
  );

  /** Flux de progression. Se ferme de lui-meme des que le travail est termine. */
  app.get<{ Params: { id: string } }>('/projets/:id/flux', async (request, reply) => {
    const projectId = Number(request.params.id);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Sans ca, un proxy tamponne le flux et la barre ne bouge qu'a la fin.
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    for (;;) {
      if (closed) return;

      const job = latestJobFor(projectId);
      if (!job) {
        reply.raw.write('event: fin\ndata: {}\n\n');
        return reply.raw.end();
      }

      const frame = {
        state: job.state,
        message: job.error ?? job.message,
        progress: job.progress,
        total: job.total,
      };
      reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);

      if (isTerminal(job.state)) {
        reply.raw.write('event: fin\ndata: {}\n\n');
        return reply.raw.end();
      }

      await new Promise((done) => setTimeout(done, 1000));
    }
  });

  app.post<{ Params: { id: string }; Body: { alsoYoto?: string } }>(
    '/projets/:id/supprimer',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const project = getProject(projectId);
      if (!project) return reply.redirect('/');

      // Un travail en vol continuerait d'ecrire dans des lignes disparues.
      const job = latestJobFor(projectId);
      if (job && !isTerminal(job.state)) requestCancel(job.id);

      // Yoto d'abord : si l'appel echoue, on ne veut pas avoir deja perdu la trace locale
      // du contenu a supprimer.
      if (request.body?.alsoYoto && project.card_id) {
        try {
          await deleteCard(project.card_id);
          unenroll(project.card_id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return reply.status(502).type('text/html').send(
            layout(
              { title: 'Suppression impossible', nav: 'cards' },
              html`
                <h1>Suppression impossible</h1>
                <section class="panel">
                  <p class="alert error">
                    Yoto a refusé de supprimer <code>${project.card_id}</code> : ${message}
                  </p>
                  <p class="muted">
                    Rien n'a été effacé, ni ici ni chez Yoto. Réessaie, ou décoche la suppression
                    distante pour ne retirer que le projet local.
                  </p>
                  <p><a class="button" href="/projets/${projectId}">Revenir au projet</a></p>
                </section>
              `,
            ),
          );
        }
      }

      deleteProject(projectId);
      // Les fichiers de travail n'ont plus de raison d'exister.
      await rm(projectDir(projectId), { recursive: true, force: true });

      return reply.redirect('/');
    },
  );

  app.post<{ Params: { id: string } }>('/projets/:id/annuler', async (request, reply) => {
    const job = latestJobFor(Number(request.params.id));
    if (job) requestCancel(job.id);
    return reply.redirect(`/projets/${request.params.id}`);
  });
}
