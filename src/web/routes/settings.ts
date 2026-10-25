/**
 * Reglages : le compte Yoto.
 *
 * Les cartes et le passeur ont leur page (Cartes) : on les manipule au quotidien, alors que la
 * connexion au compte ne se fait qu'une fois.
 */
import type { FastifyInstance } from 'fastify';

import { hasOfflineAccess } from '../../config.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout } from '../html.ts';
import { requireAuth } from './auth.ts';

function accountSection(connected: boolean) {
  return html`
    <section class="panel">
      <h2>Compte Yoto</h2>

      ${connected
        ? html`
            <p class="alert ok">Connecté.</p>
            <p class="muted">
              Se déconnecter efface les jetons stockés sur ce serveur. Les histoires déjà publiées
              continuent de jouer sur leurs cartes : elles vivent chez Yoto, pas ici.
            </p>
            <form method="post" action="/auth/yoto/deconnexion">
              <button class="link" type="submit">Déconnecter</button>
            </form>
          `
        : html`
            <p>L'application a besoin du compte Yoto pour publier les histoires.</p>
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
  app.get('/reglages', { preHandler: requireAuth }, async (_request, reply) =>
    reply.type('text/html').send(
      layout(
        { title: 'Réglages', nav: 'settings' },
        html`
          <h1>Réglages</h1>
          ${accountSection(isConnected())}
          <p class="muted">
            Les cartes MYO, les copies et le passeur se gèrent depuis
            <a href="/cartes">Cartes</a>.
          </p>
        `,
      ),
    ),
  );
}
