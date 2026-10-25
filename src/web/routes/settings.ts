/**
 * Reglages : le compte Yoto.
 *
 * Les cartes et le passeur ont leur page (Cartes) : on les manipule au quotidien, alors que la
 * connexion au compte ne se fait qu'une fois.
 */
import type { FastifyInstance } from 'fastify';

import { hasOfflineAccess } from '../../config.ts';
import { syncContents, type SyncReport } from '../../db/cards.ts';
import { listMyCards } from '../../yoto/api.ts';
import { AuthRequiredError } from '../../yoto/errors.ts';
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

function syncSection(report: SyncReport | { error: string } | undefined) {
  return html`
    <section class="panel">
      <h2>Synchroniser avec Yoto</h2>
      <p class="muted">
        Relit ton compte Yoto : les contenus publiés ailleurs (app, autre appareil) entrent ici,
        les titres changés sont mis à jour, et les histoires retrouvent leurs cartes. Un contenu
        supprimé chez Yoto est retiré d'ici, avec son adresse relevée.
      </p>
      ${report ? syncResult(report) : ''}
      <form method="post" action="/reglages/synchro" data-guard>
        <button type="submit" data-busy-label="Synchronisation…">Synchroniser maintenant</button>
      </form>
      <script src="/static/form.js"></script>
    </section>
  `;
}

function syncResult(report: SyncReport | { error: string }) {
  if ('error' in report) return html`<p class="alert error">${report.error}</p>`;
  const changed =
    report.added.length + report.retitled.length + report.relinked + report.removed.length;
  return html`
    <div class="alert ${report.removed.some((entry) => entry.copies) ? 'warn' : 'ok'}" style="display:block">
      <p><strong>Synchronisé :</strong> ${report.contents} contenu(s) sur ton compte Yoto${changed
        ? ''
        : ', rien n’avait changé'}.</p>
      ${report.added.length
        ? html`<p>Nouveau(x) : ${report.added.map((title) => `« ${title} »`).join(', ')}.</p>`
        : ''}
      ${report.retitled.length ? html`<p>Titre(s) changé(s) : ${report.retitled.join(' ; ')}.</p>` : ''}
      ${report.relinked ? html`<p>${report.relinked} histoire(s) rattachée(s) à leur contenu.</p>` : ''}
      ${report.removed.length
        ? html`<p>
            <strong>Supprimé(s) chez Yoto, retiré(s) d'ici :</strong>
            ${report.removed.map((entry) => entry.label).join(', ')}.
            ${report.removed.some((entry) => entry.copies)
              ? html`Les copies qui les portent ne jouent plus : réécris-les avec une autre histoire.`
              : ''}
          </p>`
        : ''}
    </div>
  `;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reglages', { preHandler: requireAuth }, async (request, reply) => {
    const report = request.session.syncReport;
    delete request.session.syncReport;
    const connected = isConnected();
    return reply.type('text/html').send(
      layout(
        { title: 'Réglages', nav: 'settings' },
        html`
          <h1>Réglages</h1>
          ${accountSection(connected)}
          ${connected ? syncSection(report) : ''}
          <p class="muted">
            Les copies et le passeur se gèrent depuis
            <a href="/cartes">Cartes</a>.
          </p>
        `,
      ),
    );
  });

  app.post('/reglages/synchro', { preHandler: requireAuth }, async (request, reply) => {
    try {
      request.session.syncReport = syncContents(await listMyCards());
    } catch (error) {
      request.session.syncReport = {
        error: error instanceof AuthRequiredError
          ? 'La connexion à Yoto a expiré : reconnecte-toi, puis relance la synchronisation.'
          : `Yoto n’a pas répondu : ${(error as Error).message}`,
      };
    }
    return reply.redirect('/reglages');
  });
}
