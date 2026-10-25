/**
 * Les cartes : les copies sur puce qu'on pose sur le lecteur, et l'histoire que chacune porte.
 *
 * Une copie porte l'adresse d'un contenu Yoto ; elle change d'histoire en la reecrivant, et se
 * nomme pour s'y retrouver. Le passeur, la carte MYO qui sert a relever ces adresses, est a part.
 */
import type { FastifyInstance } from 'fastify';

import {
  forgetAnonymousTags,
  forgetTag,
  getPasseur,
  listPool,
  listTags,
  registerTag,
  relinkByTitle,
  rememberTitles,
  renameTag,
  tagLabel,
} from '../../db/cards.ts';
import { findProjectByCard, findProjectByTitle } from '../../db/projects.ts';
import { listMyCards } from '../../yoto/api.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout, type Html } from '../html.ts';
import { requireAuth } from './auth.ts';

/** « 25 oct. 2026 », depuis un datetime SQLite (UTC). */
function frenchDate(stamp: string): string {
  const date = new Date(stamp.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris',
  });
}

interface Remote {
  cardId: string;
  title: string;
}

/** Le titre de l'histoire qu'un contenu joue, avec un lien vers elle quand on l'a fabriquee ici. */
function storyOf(cardId: string, remote: Remote[]): Html {
  const title =
    remote.find((card) => card.cardId === cardId)?.title ??
    listPool().find((card) => card.card_id === cardId)?.title;
  const project = findProjectByCard(cardId) ?? (title ? findProjectByTitle(title) : undefined);
  if (project) return html`<a href="/projets/${project.id}">${project.title}</a>`;
  return title ? html`${title}` : html`<span class="muted">contenu <code>${cardId}</code></span>`;
}

function cardsPage(remote: Remote[]): string {
  const tags = listTags();
  const known = tags.filter((tag) => tag.uid || tag.name);
  // Les ecritures sans numero de puce ne designent aucune carte : on les compte par histoire.
  const anonymous = new Map<string, number>();
  for (const tag of tags) {
    if (!tag.uid && !tag.name) anonymous.set(tag.card_id, (anonymous.get(tag.card_id) ?? 0) + 1);
  }
  const passeur = getPasseur();

  return layout(
    { title: 'Cartes', nav: 'cards' },
    html`
      <section class="hero">
        <h1>Tes cartes</h1>
        <p>
          Une carte est ce qu'on pose sur le lecteur. Elle porte une histoire à la fois, et une
          même histoire peut être sur plusieurs cartes.
        </p>
        <span class="hero-actions">
          <a class="button" href="/cartes/encoder">Fabriquer une carte</a>
          <a class="button ghost" href="/cartes/verifier">Lire une carte</a>
        </span>
      </section>

      <section class="panel">
        <h2>Copies sur puce</h2>
        <p class="muted">
          Les puces du commerce qui portent une histoire. Pour savoir laquelle tu as en main et la
          nommer, lis-la avec <a href="/cartes/verifier">Lire une carte</a> ; pour changer son
          histoire, réécris-la depuis <a href="/cartes/encoder">Fabriquer une carte</a>.
        </p>
        ${known.length === 0
          ? html`<p class="muted">Aucune puce connue pour l'instant.</p>`
          : html`<table class="stack">
              <thead><tr><th>Carte</th><th>Histoire</th><th>Écrite</th><th></th></tr></thead>
              <tbody>
                ${known.map(
                  (tag) => html`<tr>
                    <td data-label="Carte">
                      <form method="post" action="/cartes/copies/${tag.id}/nom" class="inline">
                        <input name="name" value="${tag.name ?? ''}" maxlength="60"
                               placeholder="${tagLabel(tag)}" aria-label="Nom de la carte">
                        <button class="link" type="submit">Nommer</button>
                      </form>
                    </td>
                    <td data-label="Histoire">${storyOf(tag.card_id, remote)}</td>
                    <td data-label="Écrite">${frenchDate(tag.written_at)}</td>
                    <td class="act">
                      <form method="post" action="/cartes/copies/${tag.id}/oublier" class="inline"
                            onsubmit="return confirm('Oublier cette puce ? Elle garde son histoire.')">
                        <button class="link" type="submit">Oublier</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>`}

        ${anonymous.size > 0
          ? html`
              <h3>Écritures sans numéro de puce</h3>
              <p class="muted">
                Faites avant que l'appli relève le numéro des puces : elles ne désignent aucune
                carte précise, et ce sont souvent les mêmes puces réécrites. Les oublier ne touche
                à aucune carte ; une puce qui porte encore l'histoire se retrouve en la lisant.
              </p>
              <ul class="plain-list">
                ${[...anonymous].map(
                  ([cardId, count]) => html`<li>
                    ${count} écriture${count > 1 ? 's' : ''} de ${storyOf(cardId, remote)}
                    <form method="post" action="/cartes/copies/anonymes/oublier" class="inline-link">
                      <input type="hidden" name="cardId" value="${cardId}">
                      · <button class="link" type="submit">Oublier</button>
                    </form>
                  </li>`,
                )}
              </ul>
            `
          : ''}
      </section>

      <section class="panel">
        <h2>Le passeur</h2>
        <p class="muted">
          La carte MYO qu'on relie à une histoire dans l'app Yoto, le temps d'en relever l'adresse
          pour les copies.
        </p>
        ${passeur
          ? html`<div class="muted passeur-ligne">
              Numéro <code>${passeur}</code> ·
              <form class="inline-link" method="post" action="/cartes/passeur/oublier">
                <input type="hidden" name="retour" value="/cartes">
                <button class="link" type="submit">changer de passeur</button>
              </form>
            </div>`
          : html`<p class="muted">Aucun passeur enregistré : « Fabriquer une carte » le demandera.</p>`}
      </section>
    `,
  );
}

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/cartes', async (_request, reply) => {
    let remote: Remote[] = [];
    if (isConnected()) {
      try {
        remote = await listMyCards();
        rememberTitles(remote);
        relinkByTitle();
      } catch {
        // Sans la bibliotheque Yoto, les titres des histoires d'ici suffisent.
      }
    }
    return reply.type('text/html').send(cardsPage(remote));
  });

  app.post<{ Params: { id: string } }>('/cartes/copies/:id/oublier', async (request, reply) => {
    forgetTag(Number(request.params.id));
    return reply.redirect('/cartes');
  });

  app.post<{ Body: { cardId?: string } }>('/cartes/copies/anonymes/oublier', async (request, reply) => {
    if (request.body.cardId) forgetAnonymousTags(request.body.cardId);
    return reply.redirect('/cartes');
  });

  /**
   * Nommer une puce lue sur le telephone (Lire une carte) : elle entre parmi les copies si on ne
   * la connaissait pas. Le passeur n'en est pas une.
   */
  app.post<{ Body: { uid?: string; cardId?: string; name?: string } }>(
    '/cartes/copies',
    async (request, reply) => {
      // L'identifiant de contenu suffit : l'adresse complete porte un jeton qui n'a pas a
      // transiter par la page.
      const uid = request.body?.uid?.trim();
      const cardId = request.body?.cardId?.trim() ?? '';
      if (!uid || !/^[A-Za-z0-9]{3,20}$/.test(cardId)) {
        return reply.code(400).send({ error: 'Il faut le numéro de la puce et son contenu Yoto.' });
      }
      if (uid === getPasseur()) {
        return reply.code(400).send({ error: 'C’est le passeur : il se gère à part.' });
      }
      const tag = registerTag(uid, cardId, request.body?.name ?? '');
      return reply.send({ id: tag.id, name: tag.name });
    },
  );

  /** Nommer une copie. Depuis la page d'encodage, la reponse est en JSON. */
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/cartes/copies/:id/nom',
    async (request, reply) => {
      renameTag(Number(request.params.id), request.body?.name ?? '');
      if (request.headers.accept?.includes('application/json')) return reply.send({ ok: true });
      return reply.redirect('/cartes');
    },
  );
}
