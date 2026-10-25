/**
 * Fabrication d'une carte : source, publication, progression.
 *
 * Le travail long tourne dans le worker ; la page ne fait que le suivre. Un rafraichissement
 * pendant l'upload ne perd rien, l'etat vit en base.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

import {
  findByCardId,
  contentIdsFor,
  holdersByContent,
  mergeHolders,
  holderNames,
  holdersSentence,
  unenroll,
  type Holders,
} from '../../db/cards.ts';
import {
  addTrack,
  clearProjectSource,
  createProject,
  deleteProject,
  getProject,
  listTracks,
  setProjectCover,
  setProjectSource,
  setTrackEdges,
  setTrackIcon,
  type Project,
  type TrackRow,
} from '../../db/projects.ts';
import { enqueue, getJob, isTerminal, latestJobFor, requestCancel, type Job } from '../../jobs/queue.ts';
import { projectDir } from '../../jobs/worker.ts';
import { removeCover, storeCover } from '../../pipeline/cover.ts';
import { titleFromFilename } from '../../pipeline/publish.ts';
import {
  cutSegment,
  EDGE_SILENCE_DB,
  measureEdges,
  proposeSegments,
  type Segment,
} from '../../pipeline/segment.ts';
import { AUDIO_EXTENSIONS, MAX_TRACKS_PER_CARD } from '../../pipeline/upload.ts';
import { drawCover, drawIcon } from '../../sources/artwork.ts';
import { isConfigured } from '../../sources/deepseek.ts';
import { probe } from '../../sources/youtube.ts';
import {
  deleteCard,
  myIcons,
  publicIcons,
  searchIcons,
  uploadCover,
  uploadIcon,
} from '../../yoto/api.ts';
import type { DisplayIcon } from '../../yoto/types.ts';
import { html, layout, raw, type Html } from '../html.ts';
import { requireAuth } from './auth.ts';
import { ETATS } from './home.ts';

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
  return layout(
    { title: 'Nouvelle histoire', nav: 'stories' },
    html`
      <a class="back" href="/">← Histoires</a>
      <h1>Nouvelle histoire</h1>
      ${error ? html`<p class="alert error">${error}</p>` : ''}
      <form class="panel" method="post" action="/projets" enctype="multipart/form-data"
            data-guard>
        <input type="hidden" name="token" value="${token}">

        <label for="title">Titre de l'histoire</label>
        <input id="title" name="title" required maxlength="140"
               placeholder="Jack et le haricot magique">

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
            <label class="check">
              <input type="checkbox" name="autoSplit" value="1">
              <span>
                Un seul long enregistrement à découper automatiquement (détection de silences) —
                pour un seul fichier déposé.
              </span>
            </label>
          </div>
        </div>

        <button type="submit" data-busy-label="Préparation…">Créer l’histoire</button>
        <p class="muted" data-busy-note hidden>
          Lecture de la source, quelques secondes. Ne recharge pas la page.
        </p>
      </form>
      <script src="/static/tabs.js"></script>
      <script src="/static/form.js"></script>
    `,
  );
}

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Faux si une extremite mesuree depasse -40 dB : la coupe est probablement tombee en plein mot. */
const isEdgeClean = (track: TrackRow): boolean =>
  (track.head_db === null || track.head_db <= EDGE_SILENCE_DB) &&
  (track.tail_db === null || track.tail_db <= EDGE_SILENCE_DB);

function reviewPanel(project: Project, segments: Segment[], totalMs: number): Html {
  return html`
    <section class="panel">
      <h2>Découpage automatique</h2>
      <p class="muted">
        ${segments.length} piste(s) proposée(s) sur ${formatMs(totalMs)} au total. Ajuste le
        nombre si le résultat ne convient pas, puis valide.
      </p>
      <form method="get" action="/projets/${project.id}" class="inline">
        <label for="pistes">Nombre de pistes</label>
        <input id="pistes" name="pistes" type="number" min="1" max="${MAX_TRACKS_PER_CARD}"
               value="${segments.length}">
        <button type="submit">Recalculer</button>
      </form>
      <table>
        <thead><tr><th>#</th><th>Début</th><th>Fin</th><th>Durée</th></tr></thead>
        <tbody>
          ${segments.map(
            (segment, index) => html`<tr>
              <td>${index + 1}</td>
              <td>${formatMs(segment.startMs)}</td>
              <td>${formatMs(segment.endMs)}</td>
              <td>${formatMs(segment.endMs - segment.startMs)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      <form method="post" action="/projets/${project.id}/decoupage" data-guard>
        <input type="hidden" name="segments" value='${JSON.stringify(segments)}'>
        <button type="submit" data-busy-label="Découpage…">Valider ce découpage</button>
      </form>
    </section>
  `;
}

function iconGrid(label: string, icons: DisplayIcon[], project: Project, track: TrackRow): Html {
  if (icons.length === 0) return html``;
  return html`
    <h3>${label}</h3>
    <div class="icon-picker-grid">
      ${icons.map(
        (icon) => html`
          <form method="post" action="/projets/${project.id}/pistes/${track.idx}/icone">
            <input type="hidden" name="mediaId" value="${icon.mediaId}">
            <input type="hidden" name="url" value="${icon.url ?? ''}">
            <button
              type="submit"
              class="icon-pick${icon.mediaId === track.icon_media_id ? ' is-selected' : ''}"
              title="${icon.title ?? icon.mediaId}"
            >
              ${icon.url
                ? html`<img src="${icon.url}" alt="${icon.title ?? ''}" width="40" height="40">`
                : html`<span class="icon-pick-fallback">${(icon.title ?? '?').slice(0, 2)}</span>`}
            </button>
          </form>
        `,
      )}
    </div>
  `;
}

function iconPickerPage(
  project: Project,
  track: TrackRow,
  mine: DisplayIcon[],
  pub: DisplayIcon[],
  q: string,
  error?: string,
): string {
  return layout(
    { title: `Icône — ${track.title}`, nav: 'stories' },
    html`
      <h1>Icône de « ${track.title} »</h1>
      <p class="muted">
        Le petit dessin affiché sur l'écran du lecteur pendant la lecture, et dans la liste des
        chapitres.
      </p>
      ${error ? html`<p class="alert error">${error}</p>` : ''}

      <section class="panel">
        <form method="get" action="/projets/${project.id}/pistes/${track.idx}/icone" class="inline">
          <input type="search" name="q" value="${q}" placeholder="Rechercher une icône…">
          <button type="submit">Chercher</button>
        </form>

        ${track.icon_media_id
          ? html`
              <div class="icon-current">
                <div class="icon-pick is-selected" aria-hidden="true">
                  ${track.icon_url
                    ? html`<img src="${track.icon_url}" alt="" width="40" height="40">`
                    : html`<span class="icon-pick-fallback">?</span>`}
                </div>
                <form method="post" action="/projets/${project.id}/pistes/${track.idx}/icone">
                  <input type="hidden" name="mediaId" value="">
                  <button class="link" type="submit">Retirer l'icône actuelle</button>
                </form>
              </div>
            `
          : ''}

        ${iconGrid('Mes icônes', mine, project, track)}
        ${iconGrid('Bibliothèque Yoto', pub, project, track)}
        ${mine.length === 0 && pub.length === 0
          ? html`<p class="muted">Aucune icône ne correspond${q ? html` à « ${q} »` : ''}.</p>`
          : ''}
      </section>

      <section class="panel">
        <h2>Faire dessiner l'icône</h2>
        <p class="muted">
          Le dessin est dicté par DeepSeek en grandes formes, puis réduit à 16×16 — une icône
          reste une silhouette, pas une miniature.
        </p>
        ${isConfigured()
          ? html`
              <form method="post"
                    action="/projets/${project.id}/pistes/${track.idx}/icone/dessiner" data-guard>
                <label for="sujet">Quoi dessiner</label>
                <input id="sujet" name="sujet" maxlength="200" value="${track.title}" required>
                <button type="submit" data-busy-label="Dessin en cours…">
                  ${track.icon_media_id ? 'Redessiner' : 'Dessiner'}
                </button>
              </form>
              <script src="/static/form.js"></script>
            `
          : html`<p class="alert error">
              Aucune clé DeepSeek n'est configurée : renseigne DEEPSEEK_API_KEY dans le
              fichier .env.
            </p>`}
      </section>

      <section class="panel">
        <h2>Importer une image</h2>
        <p class="muted">PNG ou GIF, idéalement en 16×16 pixels.</p>
        <form method="post" action="/projets/${project.id}/pistes/${track.idx}/icone/televerser"
              enctype="multipart/form-data">
          <label for="fichier">Fichier</label>
          <input id="fichier" name="fichier" type="file" accept="image/png,image/gif" required>
          <button type="submit">Téléverser et utiliser</button>
        </form>
      </section>

      <p><a href="/projets/${project.id}">Retour au projet</a></p>
    `,
  );
}

function coverPickerPage(project: Project, error?: string): string {
  const aiReady = isConfigured();

  return layout(
    { title: `Couverture — ${project.title}`, nav: 'stories' },
    html`
      <h1>Couverture de « ${project.title} »</h1>
      <p class="muted">L'image affichée dans la bibliothèque de l'app Yoto.</p>
      ${error ? html`<p class="alert error">${error}</p>` : ''}

      <section class="panel">
        ${project.cover_url
          ? html`
              <div class="icon-current">
                <div class="icon-tile" aria-hidden="true">
                  <img class="photo" src="${project.cover_url}" alt="">
                </div>
                <form method="post" action="/projets/${project.id}/couverture/retirer">
                  <button class="link" type="submit">Retirer la couverture</button>
                </form>
              </div>
            `
          : ''}

        <form method="post" action="/projets/${project.id}/couverture"
              enctype="multipart/form-data">
          <label for="fichier">Image (JPG ou PNG, carrée de préférence)</label>
          <input id="fichier" name="fichier" type="file" accept="image/jpeg,image/png" required>
          <button type="submit">Téléverser et utiliser</button>
        </form>
      </section>

      <section class="panel">
        <h2>Faire dessiner la couverture</h2>
        <p class="muted">
          DeepSeek dicte l'illustration en formes découpées, que le serveur met en image. Le
          titre et le début de l'histoire suffisent ; la consigne ci-dessous n'est là que pour
          orienter. Redessiner donne un autre dessin à chaque fois.
        </p>
        ${aiReady
          ? html`
              <form method="post" action="/projets/${project.id}/couverture/dessiner" data-guard>
                <label for="consigne">Consigne (facultative)</label>
                <input id="consigne" name="consigne" maxlength="400"
                       placeholder="Une tortue verte au bord d'une rivière, au crépuscule">
                <button type="submit" data-busy-label="Dessin en cours…">
                  ${project.cover_url ? 'Redessiner' : 'Dessiner'}
                </button>
                <p class="muted" data-busy-note hidden>
                  Une dizaine de secondes. Ne recharge pas la page.
                </p>
              </form>
              <script src="/static/form.js"></script>
            `
          : html`<p class="alert error">
              Aucune clé DeepSeek n'est configurée : renseigne DEEPSEEK_API_KEY dans le
              fichier .env.
            </p>`}
      </section>

      <p><a href="/projets/${project.id}">Retour au projet</a></p>
    `,
  );
}

/*
 * La fiche d'une histoire, dans l'ordre ou elle se fabrique : ses chapitres, son habillage, sa
 * publication chez Yoto, puis les cartes qui la portent. Chaque geste n'a qu'une place.
 */

function projectHead(project: Project, tracks: TrackRow[]): Html {
  const totalMs = tracks.reduce((sum, track) => sum + (track.duration_ms ?? 0), 0);
  const published = project.state === 'published';
  return html`
    <a class="back" href="/">← Histoires</a>
    <div class="project-head">
      ${project.cover_url
        ? html`<div class="icon-tile" aria-hidden="true">
            <img class="photo" src="${project.cover_url}" alt="">
          </div>`
        : ''}
      <div>
        <h1>${project.title}</h1>
        <div class="story-status">
          <span class="chip ${published ? '' : 'pale'}">${ETATS[project.state] ?? project.state}</span>
          <span class="story-when">
            ${tracks.length} chapitre${tracks.length > 1 ? 's' : ''}${totalMs ? ` · ${formatMs(totalMs)}` : ''}
            ${project.card_id ? html` · <code>${project.card_id}</code>` : ''}
          </span>
        </div>
      </div>
    </div>
    ${tracks.length > 0
      ? html`<div class="picker">
          <a class="button" href="/projets/${project.id}/ecouter">Écouter</a>
        </div>`
      : ''}
  `;
}

/** Le travail en cours ou tout juste fini. Rien du tout quand il n'y en a pas. */
function jobPanel(project: Project, job: Job | undefined, running: boolean): Html | string {
  if (!job) return '';
  const built = job.state === 'done' && job.kind === 'build';
  const isNew = built && (JSON.parse(job.result_json ?? '{}') as { isNew?: boolean }).isNew;
  return html`
    <section class="panel">
      <div id="etat" data-project="${project.id}" data-running="${running ? '1' : '0'}">
        <p class="alert ${job.state === 'error' ? 'error' : job.state === 'done' ? 'ok' : ''}">
          <span id="message">${job.error ?? job.message}</span>
        </p>
        ${running || job.state === 'error'
          ? html`<progress id="barre" value="${job.progress}" max="${job.total || 1}"></progress>`
          : ''}
      </div>
      ${running
        ? html`<form method="post" action="/projets/${project.id}/annuler">
            <button class="link" type="submit">Annuler</button>
          </form>`
        : ''}
      ${built
        ? html`<p class="muted" style="margin:0">
            ${isNew
              ? html`Contenu créé chez Yoto. Reste à le mettre sur une carte : voir
                  <a href="#carte">« Sur quelles cartes »</a>.`
              : html`Contenu mis à jour : les cartes qui le portent jouent la nouvelle version.`}
          </p>`
        : ''}
    </section>
  `;
}

function tracksPanel(project: Project, tracks: TrackRow[], running: boolean): Html | string {
  const missing = tracks.filter((track) => !track.file_path).length;
  const voice = project.source_kind === 'voice';
  if (tracks.length === 0 && !voice) return '';
  return html`
    <section class="panel">
      <h2>Chapitres</h2>
      ${missing > 0
        ? html`<p class="alert error">
            ${missing} chapitre(s) n'ont pas encore de son.
            <a href="/projets/${project.id}/enregistrer">Aller les enregistrer</a>.
          </p>`
        : ''}
      <div class="picker">
        ${voice
          ? html`<a class="button ghost" href="/projets/${project.id}/enregistrer">
              ${missing > 0 ? 'Enregistrer les chapitres' : 'Réenregistrer un chapitre'}
            </a>`
          : ''}
        ${isConfigured() && !running && tracks.some((track) => !track.icon_media_id)
          ? html`<form method="post" action="/projets/${project.id}/icones/dessiner">
              <button class="button ghost" type="submit">Dessiner les icônes manquantes</button>
            </form>`
          : ''}
      </div>
      <table class="stack">
        <thead><tr><th>#</th><th>Titre</th><th>Durée</th><th>Icône</th></tr></thead>
        <tbody>
          ${tracks.map(
            (track) => html`<tr>
              <td data-label="Chapitre">${track.idx + 1}</td>
              <td data-label="Titre">
                <div>
                  ${track.title}
                  ${!isEdgeClean(track)
                    ? html`<span class="chip warn"
                            title="Le début ou la fin de cette piste semble couper un mot.">
                            ⚠️ coupe
                          </span>`
                    : ''}
                </div>
              </td>
              <td data-label="Durée">
                ${track.duration_ms ? formatMs(track.duration_ms) : track.file_path ? '—' : 'à enregistrer'}
              </td>
              <td data-label="Icône">
                <a class="track-icon-link" href="/projets/${project.id}/pistes/${track.idx}/icone">
                  ${track.icon_url ? html`<img src="${track.icon_url}" alt="" width="24" height="24">` : ''}
                  ${track.icon_media_id ? 'Changer' : 'Choisir'}
                </a>
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </section>
  `;
}

/** Ce qui habille l'histoire : la couverture chez Yoto, et l'étiquette qu'on en tire. */
function dressingPanel(project: Project): Html {
  return html`
    <section class="panel">
      <h2>Couverture et étiquette</h2>
      ${project.cover_url
        ? html`<div class="icon-current">
            <div class="icon-tile" aria-hidden="true">
              <img class="photo" src="${project.cover_url}" alt="">
            </div>
            <div class="picker" style="margin:0">
              <a class="button ghost" href="/projets/${project.id}/couverture">Changer la couverture</a>
              <a class="button ghost" href="/projets/${project.id}/etiquette">Étiquette à découper</a>
            </div>
          </div>`
        : html`<p class="muted">
              Aucune couverture : l'app Yoto affichera un carré vide, et l'étiquette à découper en a
              besoin.
            </p>
            <a class="button ghost" href="/projets/${project.id}/couverture">Choisir une couverture</a>`}
    </section>
  `;
}

function publishPanel(
  project: Project,
  tracks: TrackRow[],
  running: boolean,
): Html | string {
  if (tracks.length === 0) return '';
  const missing = tracks.filter((track) => !track.file_path).length;
  const published = project.state === 'published';
  // Republier met a jour le contenu existant : les copies qui portent son adresse jouent alors la
  // nouvelle version. En creer un neuf les laisserait sur l'ancienne.
  const copies = holdersByContent();
  const count = (cardId: string): number => copies.get(cardId)?.copies.length ?? 0;
  const relevee = (cardId: string): number => (findByCardId(cardId)?.ndef_url ? 1 : 0);
  const contents = contentIdsFor(project).sort(
    (a, b) => count(b) - count(a) || relevee(b) - relevee(a),
  );
  // Les versions portent toutes le titre de l'histoire : on les distingue par leurs copies, ou par
  // ce qu'on peut en faire. L'identifiant ne sert qu'a departager deux descriptions identiques.
  const describe = (cardId: string): string => {
    const onCards = holdersSentence(copies.get(cardId));
    if (onCards) return `Sur ${onCards}`;
    return findByCardId(cardId)?.ndef_url
      ? 'Aucune copie — adresse relevée, prête à copier'
      : 'Aucune copie — jamais relevée sur le passeur';
  };
  const labels = contents.map(describe);
  const label = (cardId: string, index: number): string =>
    labels.indexOf(labels[index]!) !== labels.lastIndexOf(labels[index]!)
      ? `${labels[index]} (${cardId})`
      : labels[index]!;
  return html`
    <section class="panel">
      <h2>Publier chez Yoto</h2>
      <p class="muted">
        Envoie les chapitres, les icônes et la couverture vers ton compte Yoto. Les cartes qui
        portent déjà l'histoire jouent la nouvelle version, sans être réécrites.
      </p>
      ${published && project.card_id
        ? html`<p>Publiée sous <code>${project.card_id}</code>. ${yotoLink(project.card_id)}</p>`
        : ''}
      ${missing > 0
        ? html`<p class="muted">Enregistre d'abord les chapitres sans son (voir plus haut).</p>`
        : running
          ? html`<p class="muted">Un travail est en cours ; attends qu'il se termine.</p>`
          : html`
              <form method="post" action="/projets/${project.id}/publier" data-guard>
                ${contents.length > 1
                  ? html`
                      <label for="cardId">Version à mettre à jour</label>
                      <select id="cardId" name="cardId">
                        ${contents.map(
                          (cardId, index) => html`<option value="${cardId}">
                            ${label(cardId, index)}
                          </option>`,
                        )}
                      </select>
                      <p class="muted">
                        L'histoire a été publiée plusieurs fois : chaque version a ses copies.
                      </p>
                    `
                  : html`<input type="hidden" name="cardId" value="${contents[0] ?? ''}">`}
                <button type="submit" data-busy-label="Envoi…">
                  ${published ? 'Republier' : 'Publier'}
                </button>
              </form>
              <script src="/static/form.js"></script>
            `}
    </section>
  `;
}

/** Les copies qui portent l'histoire, et comment en faire une. */
function cardPanel(project: Project, holders: Holders | undefined): Html | string {
  if (project.state !== 'published') return '';
  const addressKnown = contentIdsFor(project).some((id) => findByCardId(id)?.ndef_url);
  const onCards = holdersSentence(holders);
  return html`
    <section class="panel" id="carte">
      <h2>Sur quelles cartes</h2>
      ${onCards
        ? html`<p>Sur ${onCards}. <a href="/cartes">Nommer les cartes</a></p>`
        : html`<p>Aucune carte ne porte encore cette histoire.</p>`}
      <p class="muted">
        ${addressKnown
          ? html`Adresse déjà relevée : pose directement la puce, neuve ou déjà écrite.`
          : html`Relie d'abord l'histoire à ton passeur dans l'app Yoto (« Link to a card ») ; la
              page te guide ensuite.`}
      </p>
      <a class="button" href="/cartes/encoder?projet=${project.id}">Fabriquer une carte</a>
    </section>
  `;
}

function deletePanel(project: Project, holders: Holders | undefined): Html {
  const { names } = holderNames(holders);
  return html`
    <section class="panel danger">
      <h2>Supprimer cette histoire</h2>
      <p class="muted">
        Efface les chapitres, les fichiers de travail et l'historique de cette application.
      </p>
      <form method="post" action="/projets/${project.id}/supprimer"
            onsubmit="return confirm('Supprimer « ${project.title} » ?')">
        ${project.card_id
          ? html`
              <label class="check">
                <input type="checkbox" name="alsoYoto" value="1" checked>
                <span>
                  Supprimer aussi le contenu <code>${project.card_id}</code> chez Yoto.
                  ${names.length
                    ? html`<strong>${names.join(', ')} cesseront de jouer</strong> : il faudra les
                        mettre sur une autre histoire.`
                    : html`Irréversible.`}
                </span>
              </label>
            `
          : ''}
        <button class="danger" type="submit">${raw(TRASH_ICON)} Supprimer</button>
      </form>
    </section>
  `;
}

/** Réaffiche le formulaire avec un jeton neuf : sans ça, corriger une erreur serait bloqué. */
function reissue(request: { session: { formToken?: string } }, error: string): string {
  const token = randomUUID();
  request.session.formToken = token;
  return newProjectPage(token, error);
}

/** Le dossier de depot vit dans /tmp, souvent un autre disque que /media : rename n'y suffit pas. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await unlink(from);
  }
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
      const autoSplit = fields.get('autoSplit') === '1';

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
      if (autoSplit && (youtubeUrl || staged.length !== 1)) {
        return reply
          .type('text/html')
          .send(reissue(request, 'Le découpage automatique ne s’applique qu’à un seul fichier audio.'));
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

      // Le decoupage n'a encore aucune piste : on s'arrete a la revue, le worker n'a rien
      // a faire tant que le decoupage n'est pas valide.
      if (autoSplit) {
        const directory = projectDir(projectId);
        await mkdir(directory, { recursive: true });
        const source = staged[0]!;
        const final = join(directory, `source${extname(source.name)}`);
        await moveFile(source.path, final);
        setProjectSource(projectId, final);
        return reply.redirect(`/projets/${projectId}`);
      }

      if (staged.length > 0) {
        const directory = projectDir(projectId);
        await mkdir(directory, { recursive: true });
        for (const [index, file] of staged.entries()) {
          const final = join(directory, `${String(index + 1).padStart(2, '0')}${extname(file.name)}`);
          await moveFile(file.path, final);
          addTrack({
            projectId,
            idx: index,
            title: titleFromFilename(file.name),
            filePath: final,
          });
          const edges = await measureEdges(final);
          setTrackEdges(projectId, index, edges.headDb, edges.tailDb);
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

  app.get<{ Params: { id: string }; Querystring: { pistes?: string } }>(
    '/projets/:id',
    async (request, reply) => {
    const project = getProject(Number(request.params.id));
    if (!project) return reply.status(404).send('Histoire introuvable.');

    const job = latestJobFor(project.id);
    const tracks = listTracks(project.id);
    const running = job ? !isTerminal(job.state) : false;
    const holders = mergeHolders(holdersByContent(), contentIdsFor(project));
    // Un decoupage en attente n'a encore aucune piste : la revue remplace le tableau habituel.
    const reviewing = project.state === 'reviewing' && !!project.source_path;
    let review: { segments: Segment[]; totalMs: number } | undefined;
    let reviewError: string | undefined;
    if (reviewing) {
      const targetCount = Number(request.query.pistes ?? '');
      try {
        const proposal = await proposeSegments(
          project.source_path!,
          Number.isFinite(targetCount) && targetCount > 1 ? { targetCount } : {},
        );
        review = { segments: proposal.segments, totalMs: proposal.totalMs };
      } catch (error) {
        reviewError = error instanceof Error ? error.message : String(error);
      }
    }

    return reply.type('text/html').send(
      layout(
        { title: project.title, nav: 'stories' },
        html`
          ${projectHead(project, tracks)}
          ${jobPanel(project, job, running)}

          ${reviewing
            ? review
              ? reviewPanel(project, review.segments, review.totalMs)
              : html`<section class="panel">
                  <p class="alert error">
                    Impossible d'analyser l'enregistrement${reviewError ? ` : ${reviewError}` : ''}.
                  </p>
                </section>`
            : ''}

          ${tracksPanel(project, tracks, running)}
          ${dressingPanel(project)}
          ${publishPanel(project, tracks, running)}
          ${cardPanel(project, holders)}
          ${deletePanel(project, holders)}

          <script src="/static/progress.js"></script>
        `,
      ),
    );
  });
  app.get<{ Params: { id: string; idx: string }; Querystring: { q?: string } }>(
    '/projets/:id/pistes/:idx/icone',
    async (request, reply) => {
      const project = getProject(Number(request.params.id));
      if (!project) return reply.status(404).send('Histoire introuvable.');
      const idx = Number(request.params.idx);
      const track = listTracks(project.id).find((row) => row.idx === idx);
      if (!track) return reply.status(404).send('Piste introuvable.');

      const q = request.query.q?.trim() ?? '';
      try {
        const [mine, pub] = await Promise.all([myIcons(), publicIcons()]);
        return reply
          .type('text/html')
          .send(iconPickerPage(project, track, searchIcons(mine, q), searchIcons(pub, q), q));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.type('text/html').send(iconPickerPage(project, track, [], [], q, message));
      }
    },
  );

  app.post<{ Params: { id: string; idx: string }; Body: { mediaId?: string; url?: string } }>(
    '/projets/:id/pistes/:idx/icone',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const idx = Number(request.params.idx);
      const mediaId = request.body?.mediaId?.trim() ?? '';
      const url = request.body?.url?.trim() ?? '';
      setTrackIcon(projectId, idx, mediaId || null, url || null);
      return reply.redirect(`/projets/${projectId}`);
    },
  );

  app.post<{ Params: { id: string; idx: string } }>(
    '/projets/:id/pistes/:idx/icone/televerser',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const idx = Number(request.params.idx);
      const project = getProject(projectId);
      if (!project) return reply.status(404).send('Histoire introuvable.');
      const track = listTracks(projectId).find((row) => row.idx === idx);
      if (!track) return reply.status(404).send('Piste introuvable.');

      const file = await request.file();
      if (!file) {
        return reply
          .type('text/html')
          .send(iconPickerPage(project, track, [], [], '', 'Choisis un fichier.'));
      }

      try {
        const bytes = await file.toBuffer();
        const icon = await uploadIcon(bytes, file.filename);
        setTrackIcon(projectId, idx, icon.mediaId, icon.url ?? null);
        return reply.redirect(`/projets/${projectId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.type('text/html').send(iconPickerPage(project, track, [], [], '', message));
      }
    },
  );

  app.post<{ Params: { id: string; idx: string }; Body: { sujet?: string } }>(
    '/projets/:id/pistes/:idx/icone/dessiner',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const idx = Number(request.params.idx);
      const project = getProject(projectId);
      if (!project) return reply.status(404).send('Histoire introuvable.');
      const track = listTracks(projectId).find((row) => row.idx === idx);
      if (!track) return reply.status(404).send('Piste introuvable.');

      try {
        const icon = await drawIcon(request.body?.sujet?.trim() || track.title);
        const uploaded = await uploadIcon(icon, `piste-${idx + 1}.png`);
        setTrackIcon(projectId, idx, uploaded.mediaId, uploaded.url ?? null);
        // Retour a la page des icones, et non au projet : un dessin se regarde, et se refait.
        return reply.redirect(`/projets/${projectId}/pistes/${idx}/icone`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.type('text/html').send(iconPickerPage(project, track, [], [], '', message));
      }
    },
  );

  app.post<{ Params: { id: string } }>('/projets/:id/icones/dessiner', async (request, reply) => {
    const projectId = Number(request.params.id);
    const project = getProject(projectId);
    if (!project) return reply.redirect('/');

    const job = latestJobFor(projectId);
    if (job && !isTerminal(job.state)) return reply.redirect(`/projets/${projectId}`);

    enqueue('artwork', { projectId }, projectId);
    return reply.redirect(`/projets/${projectId}`);
  });

  app.get<{ Params: { id: string } }>('/projets/:id/couverture', async (request, reply) => {
    const project = getProject(Number(request.params.id));
    if (!project) return reply.status(404).send('Histoire introuvable.');
    return reply.type('text/html').send(coverPickerPage(project));
  });

  app.post<{ Params: { id: string } }>('/projets/:id/couverture', async (request, reply) => {
    const projectId = Number(request.params.id);
    const project = getProject(projectId);
    if (!project) return reply.status(404).send('Histoire introuvable.');

    const file = await request.file();
    if (!file) {
      return reply.type('text/html').send(coverPickerPage(project, 'Choisis un fichier.'));
    }

    try {
      const bytes = await file.toBuffer();
      const cover = await uploadCover(bytes, file.mimetype);
      setProjectCover(projectId, cover.mediaUrl);
      // Yoto ne rend qu'une version reduite : l'original reste ici pour l'etiquette imprimee.
      await storeCover(projectId, bytes, file.mimetype);
      return reply.redirect(`/projets/${projectId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.type('text/html').send(coverPickerPage(project, message));
    }
  });

  app.post<{ Params: { id: string }; Body: { consigne?: string } }>(
    '/projets/:id/couverture/dessiner',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const project = getProject(projectId);
      if (!project) return reply.status(404).send('Histoire introuvable.');

      // Le debut de l'histoire, quand elle existe, vaut mieux que n'importe quelle consigne :
      // le dessin parle alors de ce que la carte raconte vraiment.
      const first = listTracks(projectId).find((track) => track.text)?.text;
      const consigne = request.body?.consigne?.trim();

      try {
        const png = await drawCover({
          title: project.title,
          ...(first ? { summary: first.slice(0, 600) } : {}),
          ...(consigne ? { extra: consigne } : {}),
        });
        const cover = await uploadCover(png, 'image/png');
        setProjectCover(projectId, cover.mediaUrl);
        await storeCover(projectId, png, 'image/png');
        return reply.redirect(`/projets/${projectId}/couverture`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.type('text/html').send(coverPickerPage(project, message));
      }
    },
  );

  app.post<{ Params: { id: string } }>('/projets/:id/couverture/retirer', async (request, reply) => {
    const projectId = Number(request.params.id);
    setProjectCover(projectId, null);
    await removeCover(projectId);
    return reply.redirect(`/projets/${projectId}`);
  });

  app.post<{ Params: { id: string }; Body: { segments?: string } }>(
    '/projets/:id/decoupage',
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const project = getProject(projectId);
      if (!project?.source_path) return reply.redirect('/');

      const isSegment = (value: unknown): value is Segment =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Segment).startMs === 'number' &&
        typeof (value as Segment).endMs === 'number';

      let segments: Segment[];
      try {
        const parsed: unknown = JSON.parse(request.body?.segments ?? '[]');
        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isSegment)) {
          throw new Error('forme inattendue');
        }
        segments = parsed;
      } catch {
        return reply.redirect(`/projets/${projectId}`);
      }

      const directory = projectDir(projectId);
      const ext = extname(project.source_path);

      for (const [index, segment] of segments.entries()) {
        const destination = join(directory, `${String(index + 1).padStart(2, '0')}${ext}`);
        await cutSegment(project.source_path, segment, destination, {
          title: `Piste ${index + 1}`,
          trackNumber: index + 1,
          trackTotal: segments.length,
        });
        addTrack({ projectId, idx: index, title: `Piste ${index + 1}`, filePath: destination });
        const edges = await measureEdges(destination);
        setTrackEdges(projectId, index, edges.headDb, edges.tailDb);
      }

      await rm(project.source_path, { force: true });
      clearProjectSource(projectId);

      return reply.redirect(`/projets/${projectId}`);
    },
  );

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
              { title: 'Suppression impossible', nav: 'stories' },
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
