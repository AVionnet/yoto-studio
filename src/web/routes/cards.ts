/**
 * Les cartes : les objets qu'on pose sur le lecteur, et l'histoire que chacune porte.
 *
 * Une carte MYO officielle reste liee a un contenu Yoto : publier une histoire sur ce contenu
 * change ce qu'elle joue. Une copie est une puce du commerce qui porte l'adresse d'un contenu ;
 * elle change d'histoire en la reecrivant. Les deux se nomment, pour s'y retrouver.
 */
import type { FastifyInstance } from 'fastify';

import {
  forgetMyoCard,
  getPasseur,
  listMyoCards,
  listPool,
  listTags,
  nameMyoCard,
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

function cardsPage(remote: Remote[], connected: boolean): string {
  const myo = listMyoCards();
  const tags = listTags();
  const known = tags.filter((tag) => tag.uid || tag.name);
  // Les copies ecrites sans numero de puce ne se distinguent pas : on les compte par histoire.
  const anonymous = new Map<string, number>();
  for (const tag of tags) {
    if (!tag.uid && !tag.name) anonymous.set(tag.card_id, (anonymous.get(tag.card_id) ?? 0) + 1);
  }
  const candidates = remote.filter((card) => !myo.some((entry) => entry.card_id === card.cardId));
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
        <h2>Cartes MYO officielles</h2>
        <p class="muted">
          Liées une fois dans l'app Yoto, elles se reprogramment sans NFC : publie une histoire
          « sur » l'une d'elles, et c'est ce qu'elle jouera.
        </p>
        ${myo.length === 0
          ? html`<p class="muted">Aucune carte MYO nommée pour l'instant.</p>`
          : html`<table class="stack">
              <thead><tr><th>Carte</th><th>Histoire</th><th></th></tr></thead>
              <tbody>
                ${myo.map(
                  (card) => html`<tr>
                    <td data-label="Carte">
                      <form method="post" action="/cartes/enroler" class="inline">
                        <input type="hidden" name="cardId" value="${card.card_id}">
                        <input name="nickname" value="${card.nickname}" required maxlength="60"
                               aria-label="Nom de la carte">
                        <button class="link" type="submit">Renommer</button>
                      </form>
                    </td>
                    <td data-label="Histoire">${storyOf(card.card_id, remote)}</td>
                    <td class="act">
                      <form method="post" action="/cartes/retirer" class="inline">
                        <input type="hidden" name="cardId" value="${card.card_id}">
                        <button class="link" type="submit">Je ne l'ai plus</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>`}

        <h3>Ajouter une carte MYO</h3>
        ${!connected
          ? html`<p class="muted">Connecte ton compte Yoto (Réglages) pour retrouver ses contenus.</p>`
          : candidates.length === 0
            ? html`<p class="muted">Tous les contenus de ton compte sont déjà sur une carte nommée.</p>`
            : html`
                <p class="muted">
                  Choisis l'histoire que la carte joue aujourd'hui, et donne-lui un nom —
                  « la bleue », « celle du dinosaure ».
                </p>
                <form method="post" action="/cartes/enroler">
                  <label for="cardId">Histoire qu'elle joue</label>
                  <select id="cardId" name="cardId">
                    ${candidates.map(
                      (card) => html`<option value="${card.cardId}">${card.title}</option>`,
                    )}
                  </select>
                  <label for="nickname">Nom de la carte</label>
                  <input id="nickname" name="nickname" required maxlength="60"
                         placeholder="la bleue">
                  <button type="submit">Ajouter</button>
                </form>
              `}
      </section>

      <section class="panel">
        <h2>Copies sur puce</h2>
        <p class="muted">
          Les puces du commerce écrites ici. Pour changer leur histoire, réécris-les depuis
          « Fabriquer une carte ».
        </p>
        ${known.length === 0 && anonymous.size === 0
          ? html`<p class="muted">Aucune copie pour l'instant.</p>`
          : html`<table class="stack">
              <thead><tr><th>Carte</th><th>Histoire</th><th>Écrite le</th></tr></thead>
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
                    <td data-label="Écrite le">${tag.written_at.slice(0, 10)}</td>
                  </tr>`,
                )}
                ${[...anonymous].map(
                  ([cardId, count]) => html`<tr>
                    <td data-label="Carte">
                      <span class="muted">${count} copie(s) sans numéro de puce</span>
                    </td>
                    <td data-label="Histoire">${storyOf(cardId, remote)}</td>
                    <td data-label="Écrite le">—</td>
                  </tr>`,
                )}
              </tbody>
            </table>`}
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
    const connected = isConnected();
    let remote: Remote[] = [];
    if (connected) {
      try {
        remote = await listMyCards();
        rememberTitles(remote);
        relinkByTitle();
      } catch {
        // Sans la bibliotheque Yoto, les titres des histoires d'ici suffisent.
      }
    }
    return reply.type('text/html').send(cardsPage(remote, connected));
  });

  /** Nommer (ou renommer) la carte MYO qui porte ce contenu. */
  app.post<{ Body: { cardId?: string; nickname?: string } }>(
    '/cartes/enroler',
    async (request, reply) => {
      const { cardId, nickname } = request.body;
      if (cardId && nickname?.trim()) nameMyoCard(cardId, nickname);
      return reply.redirect('/cartes');
    },
  );

  app.post<{ Body: { cardId?: string } }>('/cartes/retirer', async (request, reply) => {
    if (request.body.cardId) forgetMyoCard(request.body.cardId);
    return reply.redirect('/cartes');
  });

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
