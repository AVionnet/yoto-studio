/**
 * Pistes : suppression d'un chapitre et renumerotation sans trou.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'yoto-pistes-'));
process.env.DATA_DIR = dataDir;
process.env.MEDIA_DIR = join(dataDir, 'media');
process.env.YOTO_CLIENT_ID = 'client-de-test';
process.env.PUBLIC_BASE_URL = 'http://exemple.test';
process.env.SESSION_SECRET = 'x'.repeat(32);

const accounts = await import('./accounts.ts');
const projects = await import('./projects.ts');
const { runAs } = await import('../accounts/context.ts');

describe('deleteTrack', () => {
  const account = accounts.createAccount('bob', 'scrypt$x$y')!;

  it('retire la piste et decale les suivantes', () => {
    runAs(account, () => {
      const id = projects.createProject({ title: 'Quatre', sourceKind: 'upload' });
      for (const idx of [0, 1, 2, 3]) {
        projects.addTrack({ projectId: id, idx, title: `T${idx}`, filePath: `/x/0${idx + 1}.mp3` });
      }

      const shifted = projects.deleteTrack(id, 1);

      assert.deepEqual(shifted, [{ from: 2, to: 1 }, { from: 3, to: 2 }]);
      assert.deepEqual(
        projects.listTracks(id).map((track) => [track.idx, track.title]),
        [[0, 'T0'], [1, 'T2'], [2, 'T3']],
      );
    });
  });

  it('ne touche pas au projet d’un autre compte', () => {
    const id = runAs(account, () => {
      const created = projects.createProject({ title: 'A bob', sourceKind: 'upload' });
      projects.addTrack({ projectId: created, idx: 0, title: 'seul' });
      projects.addTrack({ projectId: created, idx: 1, title: 'second' });
      return created;
    });
    const other = accounts.createAccount('eve', 'scrypt$x$y')!;
    runAs(other, () => assert.deepEqual(projects.deleteTrack(id, 0), []));
    runAs(account, () => assert.equal(projects.listTracks(id).length, 2));
  });
});
