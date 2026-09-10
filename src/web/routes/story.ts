/**
 * Ecrire une histoire, puis la lire a voix haute.
 *
 * Le texte vient de DeepSeek, la voix vient du micro du navigateur. Chaque chapitre devient une
 * piste : le texte s'affiche pendant qu'on enregistre, et la piste attend son fichier.
 */
import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

import {
  addTrack,
  createProject,
  getProject,
  listTracks,
  setTrackEdges,
  setTrackFile,
} from '../../db/projects.ts';
import { projectDir } from '../../jobs/worker.ts';
import { measureEdges, probeDurationMs } from '../../pipeline/segment.ts';
import { MAX_CHAPTERS, isConfigured, writeStory, StoryError } from '../../sources/deepseek.ts';
import { html, layout, raw } from '../html.ts';
import { requireAuth } from './auth.ts';

const MIC_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

function newStoryPage(error?: string): string {
  return layout(
    { title: 'Écrire une histoire', nav: 'cards' },
    html`
      <a class="back" href="/">← Bibliothèque</a>
      <h1>Écrire une histoire</h1>

      ${error ? html`<p class="alert error">${error}</p>` : ''}

      ${!isConfigured()
        ? html`<p class="alert error">
            Aucune clé DeepSeek n'est configurée. Renseigne <code>DEEPSEEK_API_KEY</code> dans le
            fichier <code>.env</code>.
          </p>`
        : ''}

      <form class="panel" method="post" action="/histoire" data-guard>
        <label for="brief">De quoi parle l'histoire ?</label>
        <textarea id="brief" name="brief" required rows="4"
                  placeholder="Un hérisson timide qui apprend à dire bonjour aux animaux du jardin."></textarea>

        <div class="row">
          <div>
            <label for="age">Âge de l'enfant</label>
            <input id="age" name="age" type="number" min="2" max="12" value="5" required>
          </div>
          <div>
            <label for="chapters">Nombre de chapitres</label>
            <input id="chapters" name="chapters" type="number" min="1" max="${MAX_CHAPTERS}"
                   value="3" required>
          </div>
        </div>

        <button type="submit" data-busy-label="Écriture en cours…" ${isConfigured() ? '' : raw('disabled')}>
          Écrire l'histoire
        </button>
        <p class="muted" data-busy-note hidden>
          Le modèle écrit chapitre par chapitre : compte une trentaine de secondes.
        </p>
      </form>
    `,
  );
}

export async function storyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/histoire/nouvelle', async (_request, reply) =>
    reply.type('text/html').send(newStoryPage()),
  );

  app.post<{ Body: { brief?: string; age?: string; chapters?: string } }>(
    '/histoire',
    async (request, reply) => {
      const brief = request.body.brief?.trim() ?? '';
      if (!brief) return reply.type('text/html').send(newStoryPage('Décris l’histoire voulue.'));

      let story;
      try {
        story = await writeStory({
          brief,
          age: Number(request.body.age) || 5,
          chapters: Number(request.body.chapters) || 3,
        });
      } catch (error) {
        const hint = error instanceof StoryError ? error.hint : undefined;
        return reply
          .type('text/html')
          .send(newStoryPage(`${(error as Error).message}${hint ? ` ${hint}` : ''}`));
      }

      const projectId = createProject({ title: story.title, sourceKind: 'voice' });
      story.chapters.forEach((chapter, index) => {
        addTrack({ projectId, idx: index, title: chapter.title, text: chapter.text });
      });

      return reply.redirect(`/projets/${projectId}/enregistrer`);
    },
  );

  /** Le studio : le texte a lire, un bouton d'enregistrement par chapitre. */
  app.get<{ Params: { id: string } }>('/projets/:id/enregistrer', async (request, reply) => {
    const projectId = Number(request.params.id);
    const project = getProject(projectId);
    if (!project) return reply.status(404).send('Projet introuvable.');

    const tracks = listTracks(projectId);
    const recorded = tracks.filter((track) => track.file_path).length;

    return reply.type('text/html').send(
      layout(
        { title: project.title, nav: 'cards' },
        html`
          <a class="back" href="/projets/${projectId}">← Retour au projet</a>
          <h1>${project.title}</h1>

          <p class="alert ${recorded === tracks.length ? 'ok' : ''}"
             id="rec-summary" data-total="${tracks.length}">
            ${recorded} chapitre(s) enregistré(s) sur ${tracks.length}.
          </p>

          <div id="rec-unsupported" class="alert error" hidden></div>

          <ol class="chapters">
            ${tracks.map(
              (track) => html`
                <li class="chapter" data-index="${track.idx}"
                    data-recorded="${track.file_path ? '1' : '0'}">
                  <div class="chapter-head">
                    <h2>${track.idx + 1}. ${track.title}</h2>
                    <span class="chapter-state">${track.file_path ? 'enregistré' : 'à lire'}</span>
                  </div>

                  <p class="chapter-text">${track.text ?? ''}</p>

                  <div class="chapter-actions">
                    <button type="button" class="rec-start">
                      ${raw(MIC_ICON)} <span class="rec-label">Enregistrer</span>
                    </button>
                    <span class="rec-timer" hidden>0:00</span>
                    <audio class="rec-preview" controls
                           ${track.file_path
                             ? raw(`src="/projets/${projectId}/pistes/${track.idx}/audio"`)
                             : raw('hidden')}></audio>
                  </div>
                </li>
              `,
            )}
          </ol>

          <p><a class="button" href="/projets/${projectId}">Aller à la publication</a></p>

          <script src="/static/recorder.js"></script>
        `,
      ),
    );
  });

  /**
   * Reception d'un enregistrement.
   *
   * Le navigateur produit du WebM/Opus ou du MP4 selon la plateforme ; Yoto n'accepte ni l'un
   * ni l'autre en WebM. On reencode donc en AAC. C'est la seule exception a la regle du
   * « on ne fait que couper » : ici la conversion est imposee par le format cible, pas par un
   * gout de retouche.
   */
  app.post<{ Params: { id: string; idx: string } }>(
    '/projets/:id/pistes/:idx/enregistrement',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const index = Number(request.params.idx);

      const track = listTracks(projectId).find((entry) => entry.idx === index);
      if (!track) return reply.status(404).send({ error: 'Piste introuvable.' });

      const upload = await request.file();
      if (!upload) return reply.status(400).send({ error: 'Aucun enregistrement reçu.' });

      const directory = projectDir(projectId);
      await mkdir(directory, { recursive: true });

      const raw_ = join(directory, `voix-${index}.upload`);
      const final = join(directory, `${String(index + 1).padStart(2, '0')}.m4a`);

      try {
        await pipeline(upload.file, createWriteStream(raw_));
        await execa('ffmpeg', [
          '-hide_banner', '-nostdin', '-y',
          '-i', raw_,
          '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          final,
        ]);
      } catch (error) {
        await rm(raw_, { force: true });
        return reply
          .status(500)
          .send({ error: `Conversion impossible : ${(error as Error).message}` });
      }

      await rm(raw_, { force: true });
      setTrackFile(projectId, index, final, await probeDurationMs(final));
      const edges = await measureEdges(final);
      setTrackEdges(projectId, index, edges.headDb, edges.tailDb);

      const done = listTracks(projectId).filter((entry) => entry.file_path).length;
      return reply.send({
        ok: true,
        recorded: done,
        clean: edges.clean,
        src: `/projets/${projectId}/pistes/${index}/audio`,
      });
    },
  );
}
