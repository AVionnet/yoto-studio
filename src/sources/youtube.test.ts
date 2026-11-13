import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playlistIdOf } from './youtube.ts';

test('playlistIdOf : une adresse de playlist donne son identifiant', () => {
  assert.equal(playlistIdOf('https://www.youtube.com/playlist?list=PLabc123'), 'PLabc123');
});

test('playlistIdOf : une video partagee depuis une playlist prend la playlist entiere', () => {
  assert.equal(playlistIdOf('https://www.youtube.com/watch?v=xyz&list=PLabc123&index=3'), 'PLabc123');
});

test('playlistIdOf : une video seule, un mix ou une adresse invalide ne sont pas des playlists', () => {
  assert.equal(playlistIdOf('https://www.youtube.com/watch?v=xyz'), undefined);
  assert.equal(playlistIdOf('https://www.youtube.com/watch?v=xyz&list=RDxyz'), undefined);
  assert.equal(playlistIdOf('pas une adresse'), undefined);
});
