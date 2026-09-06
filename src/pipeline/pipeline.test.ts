/** Tests du flux d'upload et de la construction de carte. */
import assert from 'node:assert/strict';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MockAgent, setGlobalDispatcher } from 'undici';

const workDir = mkdtempSync(join(tmpdir(), 'yoto-pipeline-'));
process.env.DATA_DIR = workDir;
process.env.YOTO_CLIENT_ID = 'client-de-test';
process.env.PUBLIC_BASE_URL = 'https://exemple.test';
process.env.SESSION_SECRET = 'x'.repeat(32);

const { setSetting } = await import('../db/index.ts');
const { buildCard, titleFromFilename } = await import('./publish.ts');
const upload = await import('./upload.ts');

const API = 'https://api.yotoplay.com';
let agent: MockAgent;

const track = (over: Partial<Parameters<typeof buildCard>[0]['tracks'][number]> = {}) => ({
  path: '/tmp/a.m4a',
  transcodedSha256: 'sha-a',
  info: { duration: 185.4, fileSize: 2_960_000, format: 'aac' },
  title: 'Une piste',
  ...over,
});

before(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  setSetting(
    'yoto.tokens',
    JSON.stringify({
      accessToken: 'jeton',
      refreshToken: 'refresh',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
});

after(async () => {
  await agent.close();
});

describe('construction de la carte', () => {
  it('numerote les chapitres 01..NN et garde la piste en 01', () => {
    const card = buildCard({
      title: 'Album',
      tracks: [track({ title: 'Un' }), track({ title: 'Deux' }), track({ title: 'Trois' })],
    });

    const chapters = card.content!.chapters;
    assert.deepEqual(
      chapters.map((chapter) => chapter.key),
      ['01', '02', '03'],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.tracks[0]!.key),
      ['01', '01', '01'],
    );
    assert.equal(chapters[2]!.overlayLabel, '3');
  });

  it('prefixe trackUrl avec yoto:# et pose l icone en x minuscule', () => {
    const card = buildCard({
      title: 'Album',
      tracks: [track({ iconMediaId: 'media-9' })],
    });

    const chapter = card.content!.chapters[0]!;
    assert.equal(chapter.tracks[0]!.trackUrl, 'yoto:#sha-a');
    assert.equal(chapter.display?.icon16x16, 'yoto:#media-9');
    assert.equal(chapter.tracks[0]!.display?.icon16x16, 'yoto:#media-9');

    const serialised = JSON.stringify(card);
    assert.ok(serialised.includes('"icon16x16"'));
    assert.ok(!serialised.includes('16X16'), 'un X majuscule serait ignore par Yoto');
  });

  it('additionne duree et taille dans metadata.media', () => {
    const card = buildCard({
      title: 'Album',
      tracks: [
        track({ info: { duration: 100.4, fileSize: 1000 } }),
        track({ info: { duration: 200.4, fileSize: 2000 } }),
      ],
    });

    assert.equal(card.metadata?.media?.duration, 301); // 100.4 + 200.4 arrondi
    assert.equal(card.metadata?.media?.fileSize, 3000);
  });

  it('omet les champs absents au lieu d envoyer des nulls', () => {
    const card = buildCard({ title: 'Album', tracks: [track({ info: undefined })] });
    const serialised = JSON.stringify(card);

    assert.ok(!serialised.includes('null'), 'aucun null ne doit partir sur le fil');
    assert.equal(card.metadata?.cover, undefined);
    assert.equal(card.content!.chapters[0]!.tracks[0]!.duration, undefined);
  });

  it('refuse une carte vide ou au-dela de 100 pistes', () => {
    assert.throws(() => buildCard({ title: 'Vide', tracks: [] }), /au moins une piste/);
    assert.throws(
      () => buildCard({ title: 'Trop', tracks: Array.from({ length: 101 }, () => track()) }),
      /101 pistes/,
    );
  });

  it('nettoie les titres deduits des noms de fichiers', () => {
    assert.equal(titleFromFilename('/m/04 Le Renard.m4a'), 'Le Renard');
    assert.equal(titleFromFilename('/m/01_Chapitre_un.mp3'), 'Chapitre un');
    assert.equal(titleFromFilename('/m/12.mp3'), '12'); // pas de titre restant : on garde le stem
  });
});

describe('upload', () => {
  it('saute le transfert quand Yoto connait deja le fichier', async () => {
    const path = join(workDir, 'connu.mp3');
    writeFileSync(path, 'contenu audio');
    let putCount = 0;

    agent
      .get(API)
      .intercept({ path: /\/media\/transcode\/audio\/uploadUrl/, method: 'GET' })
      .reply(200, { upload: { uploadId: 'up-dedup' } });

    agent
      .get('https://s3.exemple.test')
      .intercept({ path: /.*/, method: 'PUT' })
      .reply(() => {
        putCount += 1;
        return { statusCode: 200, data: '' };
      });

    const pending = await upload.uploadOne(path);

    assert.equal(pending.deduplicated, true);
    assert.equal(pending.uploadId, 'up-dedup');
    assert.equal(putCount, 0);
  });

  it('refuse un fichier trop gros avant le moindre appel reseau', async () => {
    const path = join(workDir, 'enorme.mp3');
    // Fichier creux : la taille est reelle pour stat(), sans rien ecrire sur le disque.
    writeFileSync(path, '');
    truncateSync(path, upload.MAX_FILE_BYTES + 1);

    // Aucune interception n'est declaree : si un appel partait, MockAgent le ferait echouer.
    await assert.rejects(upload.uploadOne(path), /100 Mo par piste/);
  });

  it('attend tous les transcodages en parallele et rend les pistes dans l ordre d entree', async () => {
    const pending = [
      { path: '/m/01.m4a', uploadId: 'up-1', deduplicated: false },
      { path: '/m/02.m4a', uploadId: 'up-2', deduplicated: false },
    ];
    const pool = agent.get(API);

    // Premier tour : la deuxieme piste est prete, la premiere non.
    pool.intercept({ path: /\/media\/upload\/up-1\/transcoded/, method: 'GET' }).reply(202, {});
    pool
      .intercept({ path: /\/media\/upload\/up-2\/transcoded/, method: 'GET' })
      .reply(200, { transcode: { transcodedSha256: 'sha-2', transcodedInfo: { duration: 20 } } });
    // Second tour : la premiere arrive.
    pool
      .intercept({ path: /\/media\/upload\/up-1\/transcoded/, method: 'GET' })
      .reply(200, { transcode: { transcodedSha256: 'sha-1', transcodedInfo: { duration: 10 } } });

    const tracks = await upload.awaitTranscodes(pending, () => {}, () => false, {
      intervalMs: 250,
      timeoutMs: 10_000,
    });

    assert.deepEqual(
      tracks.map((entry) => entry.transcodedSha256),
      ['sha-1', 'sha-2'],
      "l'ordre des pistes sur la carte est celui d'entree, pas celui d'arrivee",
    );
  });

  it('honore l annulation pendant l attente des transcodages', async () => {
    agent
      .get(API)
      .intercept({ path: /\/media\/upload\/up-x\/transcoded/, method: 'GET' })
      .reply(202, {});

    await assert.rejects(
      upload.awaitTranscodes(
        [{ path: '/m/x.m4a', uploadId: 'up-x', deduplicated: false }],
        () => {},
        () => true,
        { intervalMs: 100, timeoutMs: 5000 },
      ),
      /annul/i,
    );
  });
});
