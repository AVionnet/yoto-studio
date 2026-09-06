/**
 * Reglages : le compte Yoto et les cartes physiques enrolees.
 *
 * L'enrolement vit ici parce que c'est une operation d'installation — une fois par carte,
 * pour toujours — et non un geste du quotidien.
 */
import type { FastifyInstance } from 'fastify';

import { hasOfflineAccess } from '../../config.ts';
import { listPool, setTrackCount } from '../../db/cards.ts';
import { getCard, listMyCards } from '../../yoto/api.ts';
import { AuthRequiredError } from '../../yoto/errors.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout, raw } from '../html.ts';
import { requireAuth } from './auth.ts';

/** Limite dure de l'API. */
const MAX_TRACKS = 100;

const countTracks = (card: { content?: { chapters?: unknown[] } }): number =>
  card.content?.chapters?.length ?? 0;

const durationOf = (card: Record<string, unknown>): number => {
  const metadata = card['metadata'] as { media?: { duration?: number } } | undefined;
  return metadata?.media?.duration ?? 0;
};

const formatDuration = (seconds: number): string => {
  if (!seconds) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60}`;
};

function accountSection(connected: boolean, poolSize: number) {
  return html`
    <section class="panel">
      <h2>Compte Yoto</h2>

      ${connected
        ? html`
            <p class="alert ok">Connecté — ${poolSize} carte(s) dans le pool.</p>
            <p class="muted">
              Se déconnecter efface les jetons stockés sur ce serveur. Les cartes déjà publiées
              continuent de jouer : leur contenu vit chez Yoto, pas ici.
            </p>
            <form method="post" action="/auth/yoto/deconnexion">
              <button class="link" type="submit">Déconnecter</button>
            </form>
          `
        : html`
            <p>L'application a besoin du compte Yoto pour lister et publier des cartes.</p>
            <a class="button" href="/auth/yoto/start">Se connecter à Yoto</a>
          `}

      ${!hasOfflineAccess
        ? html`
            <p class="alert error">
              Le scope <code>offline_access</code> n'est pas demandé : la connexion expirera et
              devra être refaite à la main. Coche-le dans le portail développeur si tu peux, puis
              retire <code>YOTO_SCOPES</code> du fichier <code>.env</code>.
            </p>
          `
        : ''}
    </section>
  `;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reglages', { preHandler: requireAuth }, async (_request, reply) => {
    const connected = isConnected();
    const pool = listPool();

    if (!connected) {
      return reply.type('text/html').send(
        layout(
          { title: 'Réglages', nav: 'settings' },
          html`<h1>Réglages</h1>
            ${accountSection(false, 0)}`,
        ),
      );
    }

    let remote;
    try {
      remote = await listMyCards();
    } catch (error) {
      if (!(error instanceof AuthRequiredError)) throw error;
      return reply.type('text/html').send(
        layout(
          { title: 'Réglages', nav: 'settings' },
          html`<h1>Réglages</h1>
            ${accountSection(false, 0)}`,
        ),
      );
    }

    // `/content/mine` renvoie un objet `content` sans les chapitres : le nombre reel de pistes
    // n'existe que sur la fiche complete, qu'on ne va chercher que pour le pool.
    const details = new Map<string, number>();
    await Promise.all(
      pool.map(async (card) => {
        try {
          details.set(card.card_id, countTracks(await getCard(card.card_id)));
        } catch {
          // Une carte supprimée chez Yoto ne doit pas casser la page.
        }
      }),
    );
    for (const [cardId, count] of details) setTrackCount(cardId, count);

    const enrolled = new Set(pool.map((card) => card.card_id));

    const poolRows = listPool().map((card) => {
      const source = remote.find((entry) => entry.cardId === card.card_id);
      const used = details.get(card.card_id) ?? card.track_count;
      return html`
        <tr>
          <td><strong>${card.nickname}</strong></td>
          <td><code>${card.card_id}</code></td>
          <td>${source ? source.title : raw('<span class="muted">introuvable chez Yoto</span>')}</td>
          <td class="${used >= MAX_TRACKS ? 'alert-text' : ''}">${used} / ${MAX_TRACKS}</td>
          <td>
            <form method="post" action="/cartes/retirer" class="inline">
              <input type="hidden" name="cardId" value="${card.card_id}">
              <button class="link" type="submit">Retirer</button>
            </form>
          </td>
        </tr>
      `;
    });

    const candidates = remote
      .filter((card) => !enrolled.has(card.cardId))
      .map(
        (card) => html`
          <tr>
            <td>${card.title}</td>
            <td><code>${card.cardId}</code></td>
            <td>${formatDuration(durationOf(card as unknown as Record<string, unknown>))}</td>
            <td>
              <form method="post" action="/cartes/enroler" class="inline">
                <input type="hidden" name="cardId" value="${card.cardId}">
                <input name="nickname" placeholder="son surnom" required maxlength="60">
                <button type="submit">Enrôler</button>
              </form>
            </td>
          </tr>
        `,
      );

    return reply.type('text/html').send(
      layout(
        { title: 'Réglages', nav: 'settings' },
        html`
          <h1>Réglages</h1>

          ${accountSection(true, pool.length)}

          <section class="panel">
            <h2>Cartes physiques</h2>
            <p class="muted">
              Ces cartes sont reconnues. Publier dessus ne touche jamais au tag NFC : seul leur
              contenu change.
            </p>
            ${pool.length === 0
              ? html`<p class="muted">Aucune carte enrôlée pour l'instant.</p>`
              : html`<table>
                  <thead>
                    <tr><th>Surnom</th><th>cardId</th><th>Contenu</th><th>Pistes</th><th></th></tr>
                  </thead>
                  <tbody>${poolRows}</tbody>
                </table>`}
          </section>

          <section class="panel">
            <h2>Contenu MYO non enrôlé</h2>
            <p class="muted">
              Tout ce que ton compte Yoto contient et qui n'est pas encore dans le pool. Donne un
              surnom à celles qui correspondent à une carte physique que tu possèdes —
              « la bleue », « celle du dinosaure ».
            </p>
            ${candidates.length === 0
              ? html`<p class="muted">Rien à enrôler.</p>`
              : html`<table>
                  <thead><tr><th>Titre</th><th>cardId</th><th>Durée</th><th></th></tr></thead>
                  <tbody>${candidates}</tbody>
                </table>`}
          </section>

          <section class="panel">
            <h2>Outils</h2>
            <p>
              <a href="/static/spike-nfc.html">Sonde NFC</a> — lire ce que porte une carte.
              Nécessite Chrome sur Android, en HTTPS.
            </p>
          </section>
        `,
      ),
    );
  });
}
