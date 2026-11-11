/** Assemblage du serveur Fastify. */
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAs } from '../accounts/context.ts';
import { config } from '../config.ts';
import { getProject } from '../db/projects.ts';
import { accountRoutes } from './routes/account.ts';
import { authRoutes, sessionAccount } from './routes/auth.ts';
import { cardRoutes } from './routes/cards.ts';
import { encodeRoutes } from './routes/encode.ts';
import { homeRoutes } from './routes/home.ts';
import { labelRoutes } from './routes/labels.ts';
import { playerRoutes } from './routes/player.ts';
import { projectRoutes } from './routes/projects.ts';
import { settingsRoutes } from './routes/settings.ts';
import { storyRoutes } from './routes/story.ts';
import { sqliteSessionStore } from './session-store.ts';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isProduction
      ? true
      : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } },
    trustProxy: true, // derriere Caddy
  });

  await app.register(formbody);
  await app.register(multipart, {
    // 100 Mo par piste, la limite basse retenue cote Yoto ; 100 pistes par carte.
    limits: { fileSize: 100 * 1024 * 1024, files: 100 },
  });
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    store: sqliteSessionStore(),
    cookieName: 'yoto_studio',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // En clair sur localhost en developpement, sinon le cookie ne serait jamais pose.
      secure: config.publicBaseUrl.startsWith('https://'),
      maxAge: 7 * 24 * 3600 * 1000,
      path: '/',
    },
    saveUninitialized: false,
  });
  await app.register(rateLimit, { global: false });

  await app.register(fastifyStatic, {
    root: join(projectRoot, 'public'),
    prefix: '/static/',
  });

  // Tout ce qui suit s'execute au nom du compte de la session : base et Yoto lisent ce contexte.
  // En preHandler, et non en onRequest : le corps d'un POST est lu entre les deux, sur des
  // evenements de flux qui ne porteraient pas le contexte jusqu'au handler.
  app.addHook('preHandler', (request, _reply, done) => {
    runAs(sessionAccount(request), done);
  });

  // Une histoire d'un autre compte n'existe pas, quelle que soit la route qui la designe : ce garde
  // couvre d'un coup les pistes, l'audio, la couverture, le flux de progression et l'annulation.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.url?.startsWith('/projets/:id')) return undefined;
    if (request.session.accountId === undefined) return undefined; // requireAuth redirigera
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || !getProject(id)) {
      return reply.status(404).send('Histoire introuvable.');
    }
    return undefined;
  });

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(homeRoutes);
  await app.register(cardRoutes);
  await app.register(encodeRoutes);
  await app.register(projectRoutes);
  await app.register(labelRoutes);
  await app.register(playerRoutes);
  await app.register(settingsRoutes);
  await app.register(storyRoutes);

  return app;
}
