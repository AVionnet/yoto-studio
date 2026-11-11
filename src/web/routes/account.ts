/**
 * Le compte de l'application : mot de passe, suppression. Ses panneaux s'affichent dans Reglages,
 * sous la connexion Yoto du compte.
 */
import { rm } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { currentAccountId } from '../../accounts/context.ts';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../../accounts/password.ts';
import { deleteAccount, getAccount, setPasswordHash, type Account } from '../../db/accounts.ts';
import { projectDir } from '../../jobs/worker.ts';
import { html } from '../html.ts';
import { dropSessions } from '../session-store.ts';
import { passwordProblem, requireAuth } from './auth.ts';

/** Le compte connecte. Appele derriere requireAuth : il existe forcement. */
export const currentAccount = (): Account => getAccount(currentAccountId())!;

export function accountPanels(account: Account) {
  return html`
    <section class="panel">
      <h2>Ton compte</h2>
      <p>Connecté en tant que <strong>${account.username}</strong>.</p>

      <h3>Changer de mot de passe</h3>
      <form method="post" action="/compte/mot-de-passe">
        <input type="text" name="username" value="${account.username}" autocomplete="username"
               hidden>
        <label for="current">Mot de passe actuel</label>
        <input id="current" name="current" type="password" autocomplete="current-password" required>
        <label for="password">Nouveau mot de passe</label>
        <input id="password" name="password" type="password" autocomplete="new-password"
               minlength="${MIN_PASSWORD_LENGTH}" required>
        <label for="confirm">Nouveau mot de passe, encore</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password"
               minlength="${MIN_PASSWORD_LENGTH}" required>
        <button type="submit">Changer</button>
      </form>
      <p class="muted">Les autres appareils connectés à ce compte seront déconnectés.</p>
    </section>

    <section class="panel danger">
      <h2>Supprimer le compte</h2>
      <p class="muted">
        Efface d'ici tes histoires, leurs fichiers de travail, tes cartes et ta connexion Yoto. Ce
        qui est publié chez Yoto n'est pas touché : les cartes continuent de jouer.
      </p>
      <form method="post" action="/compte/supprimer">
        <label for="delete-password">Mot de passe, pour confirmer</label>
        <input id="delete-password" name="password" type="password" autocomplete="current-password"
               required>
        <button class="danger" type="submit">Supprimer définitivement</button>
      </form>
    </section>
  `;
}

function back(request: FastifyRequest, reply: FastifyReply, kind: 'ok' | 'error', text: string) {
  request.session.flash = { kind, text };
  return reply.redirect('/reglages');
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  const limited = { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } };

  app.post<{ Body: { current?: string; password?: string; confirm?: string } }>(
    '/compte/mot-de-passe',
    limited,
    async (request, reply) => {
      const { current = '', password = '', confirm = '' } = request.body ?? {};
      const account = currentAccount();
      if (!(await verifyPassword(current, account.password_hash))) {
        return back(request, reply, 'error', 'Mot de passe actuel incorrect.');
      }
      const problem = passwordProblem(password, confirm);
      if (problem) return back(request, reply, 'error', problem);

      setPasswordHash(account.id, await hashPassword(password));
      dropSessions(account.id, request.session.sessionId);
      return back(request, reply, 'ok', 'Mot de passe changé.');
    },
  );

  app.post<{ Body: { password?: string } }>(
    '/compte/supprimer',
    limited,
    async (request, reply) => {
      const account = currentAccount();
      if (!(await verifyPassword(request.body?.password ?? '', account.password_hash))) {
        return back(request, reply, 'error', 'Mot de passe incorrect : le compte n’a pas été supprimé.');
      }
      const projects = deleteAccount(account.id);
      for (const id of projects) await rm(projectDir(id), { recursive: true, force: true });
      dropSessions(account.id);
      await request.session.destroy();
      return reply.redirect('/connexion');
    },
  );
}
