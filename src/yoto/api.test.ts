/**
 * Tests cibles sur les pieges reels de l'API Yoto, pas sur du remplissage.
 * Chaque cas correspond a un bug qui passerait autrement silencieusement en production.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'yoto-studio-test-'));
process.env.YOTO_CLIENT_ID = 'client-de-test';
process.env.PUBLIC_BASE_URL = 'https://exemple.test';
process.env.SESSION_SECRET = 'x'.repeat(32);

const { setSetting, getSetting } = await import('../db/index.ts');
const api = await import('./api.ts');
const { putSigned } = await import('./http.ts');

const API = 'https://api.yotoplay.com';
const AUTH = 'https://login.yotoplay.com';

let agent: MockAgent;

/** Un jeton valide longtemps, pour que les tests d'API ne declenchent aucun rafraichissement. */
function seedValidToken(): void {
  setSetting(
    'yoto.tokens',
    JSON.stringify({
      accessToken: 'jeton-valide',
      refreshToken: 'refresh-initial',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

before(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

after(async () => {
  await agent.close();
});

describe('upload audio', () => {
  it("ne fait aucun PUT quand Yoto a deja le fichier (uploadUrl absent = deduplication)", async () => {
    seedValidToken();
    let putCount = 0;

    agent
      .get(API)
      .intercept({ path: /\/media\/transcode\/audio\/uploadUrl/, method: 'GET' })
      .reply(200, { upload: { uploadId: 'up-1' } }); // pas d'uploadUrl

    agent
      .get('https://s3.exemple.test')
      .intercept({ path: '/objet', method: 'PUT' })
      .reply(() => {
        putCount += 1;
        return { statusCode: 200, data: '' };
      });

    const slot = await api.requestUploadSlot('abc123', 'piste.m4a');

    assert.equal(slot.uploadId, 'up-1');
    assert.equal(slot.uploadUrl, undefined, 'uploadUrl doit etre absent');
    assert.equal(putCount, 0, "aucun transfert ne doit partir quand le fichier est deduplique");
  });

  it("traite 202 et 404 comme « transcodage en cours », pas comme des erreurs", async () => {
    seedValidToken();
    const pool = agent.get(API);

    pool.intercept({ path: /\/media\/upload\/up-2\/transcoded/, method: 'GET' }).reply(202, {});
    pool.intercept({ path: /\/media\/upload\/up-2\/transcoded/, method: 'GET' }).reply(404, {});
    // 200 sans transcodedSha256 : toujours pas pret.
    pool
      .intercept({ path: /\/media\/upload\/up-2\/transcoded/, method: 'GET' })
      .reply(200, { transcode: {} });
    pool.intercept({ path: /\/media\/upload\/up-2\/transcoded/, method: 'GET' }).reply(200, {
      transcode: { transcodedSha256: 'sha-final', transcodedInfo: { duration: 185 } },
    });

    assert.equal(await api.getTranscode('up-2'), undefined, '202 = en attente');
    assert.equal(await api.getTranscode('up-2'), undefined, '404 = en attente');
    assert.equal(await api.getTranscode('up-2'), undefined, 'sha absent = en attente');

    const done = await api.getTranscode('up-2');
    assert.equal(done?.transcodedSha256, 'sha-final');
    assert.equal(done?.transcodedInfo?.duration, 185);
  });

  it("n'envoie jamais d'en-tete Authorization sur une URL S3 pre-signee", async () => {
    let sawAuthorization: unknown = 'non-appele';

    agent
      .get('https://s3.exemple.test')
      .intercept({ path: '/signe', method: 'PUT' })
      .reply((request) => {
        const headers = request.headers as Record<string, string>;
        sawAuthorization = headers['authorization'] ?? headers['Authorization'] ?? null;
        return { statusCode: 200, data: '' };
      });

    await putSigned('https://s3.exemple.test/signe', Buffer.from('audio'), 'audio/mpeg');
    assert.equal(sawAuthorization, null, 'la signature EST l authentification');
  });

  it('derive trackUrl du sha du transcode, pas du fichier local', () => {
    assert.equal(api.trackRef('sha-du-transcode'), 'yoto:#sha-du-transcode');
  });
});

describe('mise a jour de carte', () => {
  it('preserve les champs non documentes renvoyes par l API', async () => {
    seedValidToken();
    let posted: Record<string, unknown> | undefined;

    agent.get(API).intercept({ path: '/content/AbCdE', method: 'GET' }).reply(200, {
      card: {
        cardId: 'AbCdE',
        title: 'Ancien titre',
        sortkey: 'valeur-non-documentee',
        userId: 'u-42',
        content: {
          activity: 'yoto_Player',
          chapters: [{ key: '01', title: 'Un', ambient: 'nuit', tracks: [] }],
        },
      },
    });

    agent
      .get(API)
      .intercept({ path: '/content', method: 'POST' })
      .reply((request) => {
        posted = JSON.parse(String(request.body)) as Record<string, unknown>;
        return { statusCode: 200, data: { card: posted } };
      });

    await api.updateCard('AbCdE', { title: 'Nouveau titre' });

    assert.equal(posted?.['title'], 'Nouveau titre');
    assert.equal(posted?.['cardId'], 'AbCdE');
    assert.equal(posted?.['sortkey'], 'valeur-non-documentee', 'sortkey ne doit pas etre efface');
    assert.equal(posted?.['userId'], 'u-42');
    const content = posted?.['content'] as Record<string, unknown>;
    assert.equal(content['activity'], 'yoto_Player', 'content.activity ne doit pas etre efface');
  });

  it('remplace les tableaux au lieu de les fusionner element par element', () => {
    const merged = api.deepMerge(
      { content: { chapters: [{ key: '01' }, { key: '02' }] }, garde: 1 },
      { content: { chapters: [{ key: '01' }] } },
    );
    const chapters = (merged.content as { chapters: unknown[] }).chapters;
    assert.equal(chapters.length, 1, 'un tableau du patch remplace celui de la base');
    assert.equal(merged.garde, 1);
  });
});

describe('icones et covers', () => {
  it('serialise icon16x16 avec un x minuscule', () => {
    const display = { icon16x16: api.iconRef('media-1') };
    assert.equal(JSON.stringify(display), '{"icon16x16":"yoto:#media-1"}');
    assert.ok(!JSON.stringify(display).includes('16X16'), 'un X majuscule est ignore par Yoto');
  });

  it('utilise autoConvert en camelCase pour les icones', async () => {
    seedValidToken();
    let query = '';

    agent
      .get(API)
      .intercept({ path: /\/media\/displayIcons\/user\/me\/upload/, method: 'POST' })
      .reply((request) => {
        query = String(request.path);
        return { statusCode: 200, data: { displayIcon: { mediaId: 'm-1' } } };
      });

    await api.uploadIcon(Buffer.from('png'), 'lapin.png');

    assert.ok(query.includes('autoConvert=true'), `attendu autoConvert, recu : ${query}`);
    assert.ok(!query.includes('autoconvert='), 'la casse minuscule appartient aux covers');
  });

  it('utilise autoconvert en minuscules pour les covers', async () => {
    seedValidToken();
    let query = '';

    agent
      .get(API)
      .intercept({ path: /\/media\/coverImage\/user\/me\/upload/, method: 'POST' })
      .reply((request) => {
        query = String(request.path);
        return { statusCode: 200, data: { coverImage: { mediaUrl: 'https://cdn/c.png' } } };
      });

    const cover = await api.uploadCover(Buffer.from('jpg'), 'image/jpeg', 'myo');

    assert.equal(cover.mediaUrl, 'https://cdn/c.png');
    assert.ok(query.includes('autoconvert=true'), `attendu autoconvert, recu : ${query}`);
    assert.ok(!query.includes('autoConvert='), 'la casse camelCase appartient aux icones');
  });
});

describe('rotation du jeton de rafraichissement', () => {
  it('persiste le nouveau refresh token avant de rendre le nouvel access token', async () => {
    // Jeton deja expire : le prochain appel doit declencher un rafraichissement.
    setSetting(
      'yoto.tokens',
      JSON.stringify({
        accessToken: 'jeton-perime',
        refreshToken: 'refresh-ancien',
        expiresAt: Math.floor(Date.now() / 1000) - 10,
      }),
    );

    agent.get(AUTH).intercept({ path: '/oauth/token', method: 'POST' }).reply(200, {
      access_token: 'jeton-neuf',
      refresh_token: 'refresh-pivote',
      expires_in: 3600,
    });

    agent.get(API).intercept({ path: '/content/mine', method: 'GET' }).reply(200, { cards: [] });

    await api.listMyCards();

    const stored = JSON.parse(getSetting('yoto.tokens') ?? '{}') as Record<string, unknown>;
    assert.equal(stored['refreshToken'], 'refresh-pivote', 'le jeton pivote doit etre persiste');
    assert.equal(stored['accessToken'], 'jeton-neuf');
  });
});
