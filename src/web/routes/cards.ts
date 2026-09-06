/**
 * Actions sur le pool de cartes.
 *
 * L'affichage vit dans Reglages : un projet EST une carte, il n'y a donc qu'une seule liste,
 * et l'enrolement est une operation d'installation, pas un geste du quotidien.
 */
import type { FastifyInstance } from 'fastify';

import { enroll, unenroll } from '../../db/cards.ts';
import { requireAuth } from './auth.ts';

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Ancienne adresse, gardée pour ne pas casser un signet.
  app.get('/cartes', async (_request, reply) => reply.redirect('/'));

  app.post<{ Body: { cardId?: string; nickname?: string } }>(
    '/cartes/enroler',
    async (request, reply) => {
      const { cardId, nickname } = request.body;
      if (cardId && nickname?.trim()) enroll(cardId, nickname);
      return reply.redirect('/reglages');
    },
  );

  app.post<{ Body: { cardId?: string } }>('/cartes/retirer', async (request, reply) => {
    if (request.body.cardId) unenroll(request.body.cardId);
    return reply.redirect('/reglages');
  });
}
