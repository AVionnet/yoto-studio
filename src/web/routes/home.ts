/** Accueil : la bibliotheque de cartes. Un projet EST une carte, il n'y a qu'une liste. */
import type { FastifyInstance } from 'fastify';

import { listProjectSummaries, type ProjectSummary } from '../../db/projects.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout, raw } from '../html.ts';
import { motifCells } from '../motifs.ts';

/** Aplats de couleur, parcourus en boucle pour que deux voisines diffèrent. */
const PALETTES: [string, string][] = [
  ['var(--sun)', 'var(--sun-ink)'],
  ['var(--teal)', 'var(--teal-ink)'],
  ['var(--coral)', 'var(--coral-ink)'],
  ['var(--grass)', 'var(--grass-ink)'],
  ['var(--berry)', 'var(--berry-ink)'],
  ['var(--sky)', 'var(--sky-ink)'],
];

const ETATS: Record<string, string> = {
  draft: 'Brouillon',
  fetching: 'Téléchargement',
  segmenting: 'Découpage',
  reviewing: 'À valider',
  uploading: 'Envoi vers Yoto',
  published: 'Sur la carte',
  failed: 'Échec',
};

function duration(totalMs: number): string {
  if (!totalMs) return '—';
  const seconds = Math.round(totalMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** « il y a 3 jours », à partir d'un datetime SQLite (UTC). */
function since(stamp: string): string {
  const then = Date.parse(stamp.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 2) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'hier' : `il y a ${days} jours`;
}

function tile(seed: number): string {
  return motifCells(seed)
    .map((colour) => `<span style="background:${colour}"></span>`)
    .join('');
}

function storyCard(project: ProjectSummary, index: number) {
  const [fill, ink] = PALETTES[index % PALETTES.length]!;
  const published = project.state === 'published';
  const failed = project.state === 'failed';

  const meta = [
    `${project.track_count} piste${project.track_count > 1 ? 's' : ''}`,
    duration(project.total_ms),
    project.source_kind ?? 'inconnu',
  ].join(' · ');

  return html`
    <article class="story-card" style="--fill:${fill};--fill-ink:${ink}">
      <div class="story-head">
        <div class="icon-tile" aria-hidden="true">
          ${project.cover_url
            ? html`<img class="photo" src="${project.cover_url}" alt="">`
            : project.icon_url
              ? html`<img src="${project.icon_url}" alt="">`
              : raw(tile(project.id))}
        </div>
        <div>
          <a class="story-title" href="/projets/${project.id}">${project.title}</a>
          <div class="story-meta">${meta}</div>
        </div>
      </div>

      <div class="story-status">
        <span class="chip ${published ? '' : 'pale'}">${ETATS[project.state] ?? project.state}</span>
        <span class="story-when">
          ${project.card_id ? html`<code>${project.card_id}</code>` : since(project.updated_at)}
        </span>
      </div>

      <div class="story-actions">
        <a class="button" href="/projets/${project.id}">${failed ? 'Voir l’erreur' : 'Ouvrir'}</a>
        ${project.track_count > 0
          ? html`<a class="button btn-round" href="/projets/${project.id}/ecouter"
                    title="Écouter" aria-label="Écouter">${raw(PLAY_ICON)}</a>`
          : ''}
      </div>
    </article>
  `;
}

const PLAY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
  '<path d="M7 4l13 8-13 8z"/></svg>';

const PLUS_ICON =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.75" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

/** Ce que l'application sait faire, dit sans promettre ce qui n'existe pas encore. */
const ETAPES: [string, string, string][] = [
  [
    'var(--coral)',
    'Écrire',
    "Décris l'histoire que tu veux — un hérisson timide, une cabane sous les draps — et " +
      "elle s'écrit en chapitres, dans un vocabulaire adapté à l'âge de l'enfant.",
  ],
  [
    'var(--teal)',
    'Raconter',
    'Lis les chapitres à voix haute au micro. Ta voix devient les pistes de la carte. ' +
      "Sinon, dépose des fichiers audio ou colle une adresse.",
  ],
  [
    'var(--grass)',
    'Publier',
    'Choisis une carte, et son contenu est remplacé. Le tag NFC n’est jamais retouché : ' +
      'une carte enrôlée une fois se reprogramme à volonté.',
  ],
];

function landingPage(): string {
  return layout(
    { title: 'Accueil', bare: true },
    html`
      <div class="landing">
        <section class="hero">
          <h1>Yoto Studio</h1>
          <p>
            Fabriquer des cartes à écouter pour le lecteur Yoto, sans rien connaître au découpage
            audio ni aux formats de fichiers.
          </p>
          <a class="button" href="/connexion">Entrer</a>
        </section>

        <div class="card-grid">
          ${ETAPES.map(
            ([fill, title, body]) => html`
              <article class="story-card" style="--fill:${fill};--fill-ink:var(--neutral-900)">
                <h2>${title}</h2>
                <p style="margin:0">${body}</p>
              </article>
            `,
          )}
        </div>

        <p class="muted landing-note">
          Application personnelle, non affiliée à Yoto. Le contenu publié vit sur ton compte
          Yoto ; cette application n'en garde que les fichiers de travail.
        </p>
      </div>
    `,
  );
}

export async function homeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    // Page publique tant qu'on n'est pas entré : la bibliothèque, elle, reste privée.
    if (!request.session.authenticated) {
      return reply.type('text/html').send(landingPage());
    }

    const connected = isConnected();
    const projects = listProjectSummaries();

    return reply.type('text/html').send(
      layout(
        { title: 'Cartes', nav: 'cards' },
        html`
          <section class="hero">
            <h1>Vos cartes</h1>
            <p>Une histoire, une image, et la carte est prête à être posée sur le lecteur.</p>
            ${connected
              ? html`
                  <span class="hero-actions">
                    <a class="button" href="/histoire/nouvelle">Écrire une histoire</a>
                    <a class="button ghost" href="/projets/nouveau">Depuis un fichier</a>
                  </span>
                `
              : html`<a class="button" href="/auth/yoto/start">Connecter Yoto</a>`}
          </section>

          <div class="card-grid">
            ${projects.map(storyCard)}

            <a class="new-card" href="${connected ? '/projets/nouveau' : '/auth/yoto/start'}">
              <span aria-hidden="true">${raw(PLUS_ICON)}</span>
              Carte vierge
            </a>
          </div>
        `,
      ),
    );
  });
}
