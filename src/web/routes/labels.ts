/**
 * Etiquettes Cricut : l'autocollant qui habille la carte.
 *
 * La page ne fait que montrer et laisser telecharger ; tout le dessin vit dans pipeline/label.
 * Rien n'est mis en cache : une etiquette se fabrique en une fraction de seconde, et la
 * couverture peut changer entre deux visites.
 */
import type { FastifyInstance } from 'fastify';

import { getProject, listProjectSummaries, type Project } from '../../db/projects.ts';
import { coverBytes } from '../../pipeline/cover.ts';
import {
  CARD_MM,
  DPI,
  LABEL_MM,
  px,
  renderLabel,
  renderSheet,
  SHEET_CAPACITY,
  sheetCount,
  type Framing,
} from '../../pipeline/label.ts';
import { html, layout, type Html } from '../html.ts';
import { requireAuth } from './auth.ts';

const framingOf = (value: unknown): Framing => (value === 'contain' ? 'contain' : 'crop');

/** Nom de fichier sans accent ni espace : certains lecteurs de carte SD n'aiment pas. */
function slug(title: string): string {
  const plain = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return plain || 'carte';
}

/** 82,6 et non 82.6 : l'application parle francais jusque dans ses nombres. */
const fr = (value: number, digits = 1): string => value.toFixed(digits).replace('.', ',');

const SIZE_MM = `${fr(LABEL_MM.width)} × ${fr(LABEL_MM.height, 0)} mm`;

/** Les millimetres, dits aussi en pouces : Design Space affiche l'un ou l'autre selon le reglage. */
const SIZE_NOTE =
  `${SIZE_MM} (${fr(LABEL_MM.width / 25.4, 3)} × ${fr(LABEL_MM.height / 25.4, 3)} po)` +
  ` · ${DPI} ppp · fond transparent`;

function framingPicker(action: string, current: Framing, extra: Html | string = ''): Html {
  const link = (value: Framing, label: string, hint: string) => html`
    <a class="button ${current === value ? '' : 'ghost'}"
       href="${action}${action.includes('?') ? '&' : '?'}cadrage=${value}" title="${hint}">
      ${label}
    </a>
  `;
  return html`
    <div class="picker">
      ${link('crop', 'Recadrer', 'La couverture remplit l’étiquette : le haut et le bas sont coupés.')}
      ${link('contain', 'Image entière', 'La couverture entière tient, sur un fond flou tiré d’elle-même.')}
      ${extra}
    </div>
  `;
}

/** Le mode d'emploi, parce que « Imprimer puis decouper » rate pour trois raisons toujours les memes. */
const howTo: Html = html`
  <section class="panel">
    <h2>Dans Design Space</h2>
    <ol>
      <li>
        <strong>Téléverser</strong> le PNG, sans toucher au fond : il est déjà transparent, et
        c'est ce contour-là que la machine suivra. L'enregistrer comme
        <em>image imprimable</em> (« Print then Cut »).
      </li>
      <li>
        <strong>Vérifier la taille</strong> une fois l'image posée : ${SIZE_MM}.
        Design Space réimporte parfois à une autre échelle, et une étiquette agrandie de 2 mm
        déborde de la carte.
      </li>
      <li>
        <strong>Imprimer à 100 %</strong>, sur papier autocollant, avec le fond perdu proposé par
        Design Space et sans « ajuster à la page ».
      </li>
      <li>Charger la feuille sur le tapis : la machine lit ses repères et découpe le contour.</li>
    </ol>
    <p class="muted">
      La carte fait ${fr(CARD_MM.width)} × ${fr(CARD_MM.height, 0)} mm ; l'étiquette est 1,5 mm plus petite
      de chaque côté. Ce liseré de carte nue absorbe le millimètre d'imprécision de la découpe —
      un autocollant qui déborde finit par accrocher dans la fente du lecteur.
    </p>
  </section>
`;

function labelPage(
  project: Project,
  framing: Framing,
  hasCover: boolean,
  /** Renseigne quand la couverture existe mais reste injoignable : ce n'est pas la meme panne. */
  failure?: string,
): string {
  const base = `/projets/${project.id}/etiquette`;

  return layout(
    { title: `Étiquette — ${project.title}`, nav: 'cards' },
    html`
      <h1>Étiquette de « ${project.title} »</h1>
      <p class="muted">
        Un autocollant à imprimer puis découper à la Cricut, aux dimensions d'une carte Yoto.
      </p>

      ${hasCover
        ? html`
            <section class="panel">
              <div class="label-preview">
                <img src="${base}.png?cadrage=${framing}" alt="Aperçu de l'étiquette"
                     width="${px(LABEL_MM.width)}" height="${px(LABEL_MM.height)}">
              </div>
              ${framingPicker(base, framing)}
              <p class="muted">${SIZE_NOTE}</p>
              <div class="picker" style="margin:0">
                <a class="button" href="${base}.png?cadrage=${framing}"
                   download="etiquette-${slug(project.title)}.png">Télécharger le PNG</a>
                <a class="button ghost" href="/cartes/etiquettes">Faire une planche</a>
              </div>
            </section>
            ${howTo}
          `
        : html`
            <section class="panel">
              <p class="alert error">
                ${failure
                  ? `L'image de couverture n'a pas pu être lue : ${failure}`
                  : "Cette carte n'a pas encore de couverture, et l'étiquette n'est que ça : l'image."}
              </p>
              <p style="margin:0">
                <a class="button" href="/projets/${project.id}/couverture">
                  ${failure ? 'Reprendre une couverture' : 'Choisir une couverture'}
                </a>
              </p>
            </section>
          `}

      <p><a href="/projets/${project.id}">Retour à la carte</a></p>
    `,
  );
}

function sheetPage(
  projects: { id: number; title: string }[],
  selected: number[],
  framing: Framing,
): string {
  const query = (page: number): string =>
    [...selected.map((id) => `ids=${id}`), `cadrage=${framing}`, `planche=${page}`].join('&');
  const sheets = selected.length > 0 ? sheetCount(selected.length) : 0;
  // Le choix de cadrage est un lien : il doit emporter la selection courante avec lui.
  const pickerBase = `/cartes/etiquettes?${selected.map((id) => `ids=${id}`).join('&')}&sel=1`;

  return layout(
    { title: 'Planche d’étiquettes', nav: 'cards' },
    html`
      <h1>Planche d'étiquettes</h1>
      <p class="muted">
        ${SHEET_CAPACITY} étiquettes par feuille, la limite de « Imprimer puis découper ».
        Au-delà, la planche suivante s'ajoute.
      </p>

      ${projects.length === 0
        ? html`
            <section class="panel">
              <p class="alert error">Aucune carte n'a encore de couverture à coller.</p>
              <p style="margin:0"><a class="button" href="/">Voir les cartes</a></p>
            </section>
          `
        : html`
            <section class="panel">
              <h2>Quelles cartes ?</h2>
              <form method="get" action="/cartes/etiquettes">
                <input type="hidden" name="sel" value="1">
                <input type="hidden" name="cadrage" value="${framing}">
                ${projects.map(
                  (project) => html`
                    <label class="check">
                      <input type="checkbox" name="ids" value="${project.id}"
                             ${selected.includes(project.id) ? html`checked` : ''}>
                      <span>${project.title}</span>
                    </label>
                  `,
                )}
                <button type="submit">Composer la planche</button>
              </form>
            </section>

            ${selected.length > 0
              ? html`
                  <section class="panel">
                    <h2>${sheets} planche${sheets > 1 ? 's' : ''}</h2>
                    ${framingPicker(pickerBase, framing)}
                    ${Array.from(
                      { length: sheets },
                      (_unused, page) => html`
                        <div class="label-preview">
                          <img src="/cartes/etiquettes.png?${query(page)}"
                               alt="Aperçu de la planche ${page + 1}">
                        </div>
                        <div class="picker">
                          <a class="button" href="/cartes/etiquettes.png?${query(page)}"
                             download="planche-etiquettes-${page + 1}.png">
                            Télécharger la planche ${page + 1}
                          </a>
                        </div>
                      `,
                    )}
                    <p class="muted">${SIZE_NOTE} par étiquette</p>
                  </section>
                  ${howTo}
                `
              : ''}
          `}
    `,
  );
}

/** `ids=1&ids=2` ou `ids=1` : Fastify rend une chaine quand il n'y en a qu'un. */
function idList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw.map((entry) => Number(entry)).filter((id) => Number.isInteger(id) && id > 0);
}

export async function labelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Params: { id: string }; Querystring: { cadrage?: string } }>(
    '/projets/:id/etiquette',
    async (request, reply) => {
      const project = getProject(Number(request.params.id));
      if (!project) return reply.status(404).send('Projet introuvable.');

      let cover: Buffer | undefined;
      let failure: string | undefined;
      try {
        cover = await coverBytes(project);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      return reply
        .type('text/html')
        .send(
          labelPage(project, framingOf(request.query.cadrage), cover !== undefined, failure),
        );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { cadrage?: string } }>(
    '/projets/:id/etiquette.png',
    async (request, reply) => {
      const project = getProject(Number(request.params.id));
      if (!project) return reply.status(404).send('Projet introuvable.');

      let cover: Buffer | undefined;
      try {
        cover = await coverBytes(project);
      } catch (error) {
        return reply.status(502).send(error instanceof Error ? error.message : String(error));
      }
      if (!cover) return reply.status(404).send('Cette carte n’a pas de couverture.');

      const png = await renderLabel(cover, framingOf(request.query.cadrage));
      return reply
        .type('image/png')
        .header('Cache-Control', 'private, no-store')
        .header('Content-Disposition', `inline; filename="etiquette-${slug(project.title)}.png"`)
        .send(png);
    },
  );

  app.get<{ Querystring: { ids?: string | string[]; cadrage?: string; sel?: string } }>(
    '/cartes/etiquettes',
    async (request, reply) => {
      const withCover = listProjectSummaries().filter((project) => project.cover_url);
      const asked = idList(request.query.ids);
      // Premiere visite : tout est coche. Apres un envoi, on respecte les cases decochees,
      // y compris quand il n'en reste aucune.
      const selected = request.query.sel
        ? withCover.filter((project) => asked.includes(project.id)).map((project) => project.id)
        : withCover.map((project) => project.id);

      return reply
        .type('text/html')
        .send(sheetPage(withCover, selected, framingOf(request.query.cadrage)));
    },
  );

  app.get<{ Querystring: { ids?: string | string[]; cadrage?: string; planche?: string } }>(
    '/cartes/etiquettes.png',
    async (request, reply) => {
      const page = Math.max(0, Number(request.query.planche ?? 0) || 0);
      const ids = idList(request.query.ids).slice(
        page * SHEET_CAPACITY,
        page * SHEET_CAPACITY + SHEET_CAPACITY,
      );
      if (ids.length === 0) return reply.status(400).send('Aucune carte sélectionnée.');

      const framing = framingOf(request.query.cadrage);
      const labels: Buffer[] = [];
      for (const id of ids) {
        const project = getProject(id);
        if (!project) continue;
        let cover: Buffer | undefined;
        try {
          cover = await coverBytes(project);
        } catch {
          continue; // une couverture injoignable ne doit pas emporter toute la planche
        }
        if (cover) labels.push(await renderLabel(cover, framing));
      }
      if (labels.length === 0) return reply.status(404).send('Aucune couverture à imprimer.');

      return reply
        .type('image/png')
        .header('Cache-Control', 'private, no-store')
        .header('Content-Disposition', `inline; filename="planche-etiquettes-${page + 1}.png"`)
        .send(await renderSheet(labels));
    },
  );
}
