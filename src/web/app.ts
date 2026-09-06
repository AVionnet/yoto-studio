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

import { config } from '../config.ts';
import { authRoutes } from './routes/auth.ts';
import { cardRoutes } from './routes/cards.ts';
import { homeRoutes } from './routes/home.ts';
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

  await app.register(authRoutes);
  await app.register(homeRoutes);
  await app.register(cardRoutes);
  await app.register(projectRoutes);
  await app.register(playerRoutes);
  await app.register(settingsRoutes);
  await app.register(storyRoutes);

  return app;
}
