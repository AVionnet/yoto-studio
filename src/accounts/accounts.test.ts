/**
 * Comptes : migration d'une base d'avant les comptes, cloisonnement des donnees, parcours HTTP.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(join(tmpdir(), 'yoto-comptes-'));
process.env.DATA_DIR = dataDir;
process.env.MEDIA_DIR = join(dataDir, 'media');
process.env.YOTO_CLIENT_ID = 'client-de-test';
process.env.PUBLIC_BASE_URL = 'http://exemple.test';
process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.INVITE_CODE = 'sesame';

// Une base telle que l'application la laissait avant les comptes : un projet publie, son contenu,
// une copie, un travail en file et la connexion Yoto.
const here = dirname(fileURLToPath(import.meta.url));
const legacy = new Database(join(dataDir, 'yoto-studio.db'));
legacy.exec(readFileSync(join(here, 'fixtures', 'schema-avant-comptes.sql'), 'utf8'));
legacy.exec(`
  INSERT INTO cards (card_id, nickname, title) VALUES ('abc12', 'Le loup', 'Le loup');
  INSERT INTO projects (title, state, card_id) VALUES ('Le loup', 'published', 'abc12');
  INSERT INTO card_tags (uid, name, card_id) VALUES ('04aa', 'la rouge', 'abc12');
  INSERT INTO jobs (project_id, kind) VALUES (1, 'artwork');
  INSERT INTO settings (key, value) VALUES ('yoto.tokens', '{"accessToken":"ancien"}');
  INSERT INTO settings (key, value) VALUES ('passeur_uid', '04pp');
`);
legacy.close();

const { db } = await import('../db/index.ts');
const accounts = await import('../db/accounts.ts');
const cards = await import('../db/cards.ts');
const projects = await import('../db/projects.ts');
const queue = await import('../jobs/queue.ts');
const { runAs } = await import('./context.ts');
const { hashPassword, verifyPassword } = await import('./password.ts');

describe('migration', () => {
  it('garde les donnees existantes, sans compte, jusqu’au premier compte', () => {
    db();
    const orphans = db().prepare('SELECT count(*) AS n FROM projects WHERE account_id IS NULL').get();
    assert.deepEqual(orphans, { n: 1 });
    assert.equal(queue.claimNext(), undefined, 'un travail sans compte ne doit pas partir');
  });

  it('le premier compte reprend tout, jetons Yoto et passeur compris', () => {
    const first = accounts.createAccount('alice', 'scrypt$x$y')!;
    runAs(first, () => {
      assert.equal(projects.listProjects().length, 1);
      assert.equal(cards.findByCardId('abc12')?.title, 'Le loup');
      assert.equal(cards.findTag('04aa')?.name, 'la rouge');
      assert.equal(cards.getPasseur(), '04pp');
      assert.equal(accounts.getAccountSetting('yoto.tokens'), '{"accessToken":"ancien"}');
    });
    assert.equal(queue.claimNext()?.account_id, first);
  });
});

describe('cloisonnement', () => {
  it('un second compte ne voit rien du premier, et peut connaitre le meme contenu', () => {
    const alice = accounts.findAccount('ALICE')!.id; // identifiant insensible a la casse
    const bob = accounts.createAccount('bob', 'scrypt$x$y')!;
    const aliceProject = runAs(alice, () => projects.listProjects()[0]!.id);

    runAs(bob, () => {
      assert.equal(projects.getProject(aliceProject), undefined);
      assert.deepEqual(projects.listTracks(aliceProject), []);
      assert.deepEqual(cards.listPool(), []);
      assert.equal(cards.getPasseur(), undefined);
      assert.equal(accounts.getAccountSetting('yoto.tokens'), undefined);

      cards.enroll('abc12', 'Autre titre');
      cards.recordTag('abc12', '04aa');
      projects.deleteProject(aliceProject); // sans effet : pas le sien
    });

    runAs(alice, () => {
      assert.equal(cards.findByCardId('abc12')?.nickname, 'Le loup');
      assert.equal(cards.findTag('04aa')?.name, 'la rouge');
      assert.ok(projects.getProject(aliceProject));
    });
  });

  it('retirer un contenu detache les histoires du compte qui le designaient', () => {
    const alice = accounts.findAccount('alice')!.id;
    runAs(alice, () => {
      cards.unenroll('abc12');
      assert.equal(projects.listProjects()[0]!.card_id, null);
    });
  });

  it('refuse d’agir hors de tout compte', () => {
    assert.throws(() => projects.listProjects(), /Aucun compte actif/);
  });

  it('refuse un identifiant deja pris', () => {
    assert.equal(accounts.createAccount('Bob', 'scrypt$x$y'), undefined);
  });
});

describe('mots de passe', () => {
  it('verifie le bon et refuse le mauvais', async () => {
    const stored = await hashPassword('correct horse');
    assert.ok(await verifyPassword('correct horse', stored));
    assert.ok(!(await verifyPassword('battery staple', stored)));
    assert.ok(!(await verifyPassword('correct horse', 'n’importe quoi')));
  });
});

describe('parcours HTTP', async () => {
  const { buildApp } = await import('../web/app.ts');
  const app = await buildApp();

  const form = (body: Record<string, string>) => ({
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers['set-cookie']).split(';')[0]!;

  it('exige le code d’invitation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/inscription',
      ...form({ username: 'carole', password: 'motdepasse', confirm: 'motdepasse', invite: 'faux' }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(accounts.findAccount('carole'), undefined);
  });

  it('inscrit, puis interdit les histoires des autres', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/inscription',
      ...form({ username: 'carole', password: 'motdepasse', confirm: 'motdepasse', invite: 'sesame' }),
    });
    assert.equal(signup.statusCode, 302);
    const cookie = cookieOf(signup);

    const aliceProject = runAs(accounts.findAccount('alice')!.id, () => projects.listProjects()[0]!.id);
    for (const url of [`/projets/${aliceProject}`, `/projets/${aliceProject}/pistes/0/audio`]) {
      const response = await app.inject({ url, headers: { cookie } });
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.body, 'Histoire introuvable.', url);
    }
    // Controle : sa propre histoire, elle, s'ouvre.
    const own = runAs(accounts.findAccount('carole')!.id, () =>
      projects.createProject({ title: 'La mienne', sourceKind: 'upload' }),
    );
    assert.equal((await app.inject({ url: `/projets/${own}`, headers: { cookie } })).statusCode, 200);
    const cancel = await app.inject({
      method: 'POST',
      url: `/projets/${aliceProject}/annuler`,
      headers: { cookie },
    });
    assert.equal(cancel.statusCode, 404);

    const home = await app.inject({ url: '/', headers: { cookie } });
    assert.equal(home.statusCode, 200);
    assert.ok(!home.body.includes('Le loup'), 'l’accueil ne doit montrer que ses histoires');

    const settings = await app.inject({ url: '/reglages', headers: { cookie } });
    assert.ok(settings.body.includes('carole'));
  });

  it('connecte avec le bon mot de passe seulement', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/connexion',
      ...form({ username: 'carole', password: 'mauvais!' }),
    });
    assert.equal(wrong.statusCode, 401);

    const right = await app.inject({
      method: 'POST',
      url: '/connexion',
      ...form({ username: 'Carole', password: 'motdepasse' }),
    });
    assert.equal(right.statusCode, 302);
    assert.equal(right.headers.location, '/');
  });

  it('change le mot de passe et ferme les autres sessions', async () => {
    const login = (password: string) =>
      app.inject({ method: 'POST', url: '/connexion', ...form({ username: 'carole', password }) });
    const here = cookieOf(await login('motdepasse'));
    const elsewhere = cookieOf(await login('motdepasse'));

    const change = await app.inject({
      method: 'POST',
      url: '/compte/mot-de-passe',
      headers: { cookie: here, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ current: 'motdepasse', password: 'nouveau-mdp', confirm: 'nouveau-mdp' }).toString(),
    });
    assert.equal(change.headers.location, '/reglages');

    assert.equal((await app.inject({ url: '/reglages', headers: { cookie: here } })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/reglages', headers: { cookie: elsewhere } })).headers.location,
      '/connexion',
    );
    assert.equal((await login('nouveau-mdp')).statusCode, 302);
  });

  it('supprime le compte et tout ce qu’il possede', async () => {
    const cookie = cookieOf(
      await app.inject({ method: 'POST', url: '/connexion', ...form({ username: 'carole', password: 'nouveau-mdp' }) }),
    );
    const carole = accounts.findAccount('carole')!.id;
    runAs(carole, () => projects.createProject({ title: 'À effacer', sourceKind: 'upload' }));

    const response = await app.inject({
      method: 'POST',
      url: '/compte/supprimer',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=nouveau-mdp',
    });
    assert.equal(response.headers.location, '/connexion');
    assert.equal(accounts.getAccount(carole), undefined);
    const left = db().prepare('SELECT count(*) AS n FROM projects WHERE account_id = ?').get(carole);
    assert.deepEqual(left, { n: 0 });
    await app.close();
  });
});
