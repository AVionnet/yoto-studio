/**
 * Deux authentifications distinctes :
 *  - celle de l'application (mot de passe unique), parce qu'elle est sur une URL publique
 *    et detient les jetons Yoto ;
 *  - celle de Yoto (OAuth PKCE), qui s'appuie sur la premiere.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../../config.ts';
import { authorizeUrl, createPkcePair, createState, disconnect, exchangeCode } from '../../yoto/oauth.ts';
import { html, layout } from '../html.ts';

declare module 'fastify' {
  interface Session {
    authenticated?: boolean;
    pkceVerifier?: string;
    oauthState?: string;
    /** Jeton a usage unique du formulaire de fabrication, contre la double soumission. */
    formToken?: string;
  }
}

/** Comparaison a temps constant, sur des empreintes pour egaliser les longueurs. */
function passwordMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Doit etre `async` : un hook Fastify a deux parametres et sans `done` doit rendre une promesse,
 * sinon la requete reste suspendue. Le symptome ne se voit que sur le chemin passant, puisque la
 * redirection envoie elle-meme la reponse.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (request.session.authenticated) return undefined;
  return reply.redirect('/connexion');
}

function loginPage(error?: string): string {
  return layout(
    { title: 'Connexion', bare: true },
    html`
      <section class="panel narrow">
        <h1>Yoto Studio</h1>
        <p class="muted">Fabrique des cartes pour le lecteur.</p>
        ${error ? html`<p class="alert error">${error}</p>` : ''}
        <form method="post" action="/connexion">
          <label for="password">Mot de passe</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
                 autofocus required>
          <button type="submit">Entrer</button>
        </form>
      </section>
    `,
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/connexion', async (request, reply) => {
    if (request.session.authenticated) return reply.redirect('/');
    return reply.type('text/html').send(loginPage());
  });

  app.post<{ Body: { password?: string } }>(
    '/connexion',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      if (!passwordMatches(request.body?.password ?? '', config.appPassword)) {
        return reply.status(401).type('text/html').send(loginPage('Mot de passe incorrect.'));
      }
      request.session.authenticated = true;
      return reply.redirect('/');
    },
  );

  app.post('/deconnexion', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/connexion');
  });

  // --- OAuth Yoto ---

  app.get('/auth/yoto/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!config.yoto.clientId) {
      return reply.status(500).send('YOTO_CLIENT_ID absent de la configuration.');
    }
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    request.session.pkceVerifier = verifier;
    request.session.oauthState = state;
    return reply.redirect(authorizeUrl(challenge, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/auth/yoto/callback',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { code, state, error, error_description: description } = request.query;

      if (error) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            layout(
              { title: 'Connexion Yoto refusée' },
              html`<section class="panel">
                <h1>Connexion Yoto refusée</h1>
                <p class="alert error">${description || error}</p>
                <p><a href="/">Revenir</a></p>
              </section>`,
            ),
          );
      }

      const expected = request.session.oauthState;
      const verifier = request.session.pkceVerifier;
      // Le state est a usage unique : on le consomme avant toute validation.
      delete request.session.oauthState;
      delete request.session.pkceVerifier;

      if (!state || !expected || state !== expected) {
        return reply.status(403).send('State invalide — tentative de CSRF possible.');
      }
      if (!code || !verifier) return reply.status(400).send('Code ou verifier manquant.');

      await exchangeCode(code, verifier);
      return reply.redirect('/cartes');
    },
  );

  app.post('/auth/yoto/deconnexion', { preHandler: requireAuth }, async (_request, reply) => {
    disconnect();
    return reply.redirect('/');
  });
}
