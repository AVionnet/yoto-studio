/**
 * Deux authentifications distinctes :
 *  - celle de l'application : un compte par personne (identifiant et mot de passe), parce
 *    qu'elle est sur une URL publique et detient des jetons Yoto ;
 *  - celle de Yoto (OAuth PKCE), qui s'appuie sur la premiere : chaque compte relie le sien.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { DECOY_HASH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../../accounts/password.ts';
import { config } from '../../config.ts';
import {
  USERNAME_PATTERN,
  countAccounts,
  createAccount,
  findAccount,
  getAccount,
} from '../../db/accounts.ts';
import { authorizeUrl, createPkcePair, createState, disconnect, exchangeCode } from '../../yoto/oauth.ts';
import type { SyncReport } from '../../db/cards.ts';
import { html, layout, type Html } from '../html.ts';

declare module 'fastify' {
  interface Session {
    /** Le compte connecte. Le contexte de compte (accounts/context.ts) en est tire a chaque requete. */
    accountId?: number;
    pkceVerifier?: string;
    oauthState?: string;
    /** Jeton a usage unique du formulaire de fabrication, contre la double soumission. */
    formToken?: string;
    /** Compte rendu de la derniere synchronisation, affiche une fois apres la redirection. */
    syncReport?: SyncReport | { error: string };
    /** Message a afficher une fois sur la page Reglages. */
    flash?: { kind: 'ok' | 'error'; text: string };
  }
}

/** Comparaison a temps constant, sur des empreintes pour egaliser les longueurs. */
function codeMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Le compte de la session, s'il existe encore : un compte supprime depuis un autre appareil ne
 * doit pas laisser de session vivante derriere lui.
 */
export function sessionAccount(request: FastifyRequest): number | undefined {
  const id = request.session.accountId;
  return id !== undefined && getAccount(id) ? id : undefined;
}

/**
 * Doit etre `async` : un hook Fastify a deux parametres et sans `done` doit rendre une promesse,
 * sinon la requete reste suspendue. Le symptome ne se voit que sur le chemin passant, puisque la
 * redirection envoie elle-meme la reponse.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (sessionAccount(request) !== undefined) return undefined;
  return reply.redirect('/connexion');
}

/** Ouvre la session d'un compte, sous un nouvel identifiant : pas de fixation de session. */
async function openSession(request: FastifyRequest, accountId: number): Promise<void> {
  await request.session.regenerate();
  request.session.accountId = accountId;
}

function authPage(title: string, body: Html): string {
  return layout(
    { title, bare: true },
    html`
      <section class="panel narrow">
        <h1>Yoto Studio</h1>
        ${body}
      </section>
    `,
  );
}

function loginPage(error?: string, username = ''): string {
  // Avant le premier compte, il n'y a personne a connecter : on oriente vers la creation.
  const empty = countAccounts() === 0;
  return authPage(
    'Connexion',
    html`
      <p class="muted">Fabrique des cartes pour le lecteur.</p>
      ${error ? html`<p class="alert error">${error}</p>` : ''}
      ${empty
        ? html`<p class="alert warn">
            Aucun compte pour l'instant. Le premier créé reprend les histoires, les cartes et la
            connexion Yoto déjà présentes.
          </p>`
        : html`
            <form method="post" action="/connexion">
              <label for="username">Identifiant</label>
              <input id="username" name="username" autocomplete="username" value="${username}"
                     autocapitalize="none" autofocus required>
              <label for="password">Mot de passe</label>
              <input id="password" name="password" type="password" autocomplete="current-password"
                     required>
              <button type="submit">Entrer</button>
            </form>
          `}
      <p class="muted"><a href="/inscription">Créer un compte</a></p>
    `,
  );
}

function signupPage(error?: string, username = ''): string {
  return authPage(
    'Créer un compte',
    html`
      <p class="muted">Chaque compte relie son propre compte Yoto et ne voit que ses histoires.</p>
      ${error ? html`<p class="alert error">${error}</p>` : ''}
      <form method="post" action="/inscription">
        <label for="username">Identifiant</label>
        <input id="username" name="username" autocomplete="username" value="${username}"
               autocapitalize="none" minlength="3" maxlength="40" autofocus required>
        <label for="password">Mot de passe</label>
        <input id="password" name="password" type="password" autocomplete="new-password"
               minlength="${MIN_PASSWORD_LENGTH}" required>
        <label for="confirm">Mot de passe, encore</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password"
               minlength="${MIN_PASSWORD_LENGTH}" required>
        ${config.inviteCode
          ? html`
              <label for="invite">Code d'invitation</label>
              <input id="invite" name="invite" type="password" autocomplete="off" required>
            `
          : ''}
        <button type="submit">Créer le compte</button>
      </form>
      <p class="muted"><a href="/connexion">J'ai déjà un compte</a></p>
    `,
  );
}

/** Le motif d'un nouveau mot de passe refuse, ou rien s'il convient. */
export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  if (password !== confirm) return 'Les deux mots de passe ne sont pas identiques.';
  return undefined;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const limited = { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } };

  app.get('/connexion', async (request, reply) => {
    if (sessionAccount(request) !== undefined) return reply.redirect('/');
    return reply.type('text/html').send(loginPage());
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    '/connexion',
    limited,
    async (request, reply) => {
      const username = request.body?.username?.trim() ?? '';
      const account = findAccount(username);
      // Le mot de passe est verifie meme sans compte : meme duree de reponse dans les deux cas.
      const valid = await verifyPassword(
        request.body?.password ?? '',
        account?.password_hash ?? DECOY_HASH,
      );
      if (!account || !valid) {
        return reply
          .status(401)
          .type('text/html')
          .send(loginPage('Identifiant ou mot de passe incorrect.', username));
      }
      await openSession(request, account.id);
      return reply.redirect('/');
    },
  );

  app.get('/inscription', async (request, reply) => {
    if (sessionAccount(request) !== undefined) return reply.redirect('/');
    return reply.type('text/html').send(signupPage());
  });

  app.post<{ Body: { username?: string; password?: string; confirm?: string; invite?: string } }>(
    '/inscription',
    limited,
    async (request, reply) => {
      const { password = '', confirm = '', invite = '' } = request.body ?? {};
      const username = request.body?.username?.trim() ?? '';
      const refuse = (message: string) =>
        reply.status(400).type('text/html').send(signupPage(message, username));

      if (config.inviteCode && !codeMatches(invite, config.inviteCode)) {
        return refuse("Code d'invitation incorrect.");
      }
      if (!USERNAME_PATTERN.test(username)) {
        return refuse(
          "L'identifiant fait de 3 à 40 caractères : lettres, chiffres, point, tiret ou souligné.",
        );
      }
      const problem = passwordProblem(password, confirm);
      if (problem) return refuse(problem);

      const accountId = createAccount(username, await hashPassword(password));
      if (accountId === undefined) return refuse('Cet identifiant est déjà pris.');

      await openSession(request, accountId);
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
