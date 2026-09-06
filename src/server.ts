/** Point d'entree. `npm run dev` en local, `npm start` en production. */
import { config } from './config.ts';
import { db } from './db/index.ts';
import { startWorker, stopWorker } from './jobs/worker.ts';
import { buildApp } from './web/app.ts';

db(); // applique le schema avant d'accepter la moindre requete

const app = await buildApp();

startWorker({
  info: (message) => app.log.info(message),
  error: (message) => app.log.error(message),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info('arret demande');
    stopWorker();
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
