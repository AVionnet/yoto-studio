import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type CardFacts, identify } from './identify.ts';

const URL = 'https://yoto.io/AbC12?fJ3kQ9vRtYs2LmNp';

const facts = (patch: Partial<CardFacts> = {}): CardFacts => ({
  cardId: 'AbC12',
  url: URL,
  library: 'ok',
  remote: { title: 'Jack et le haricot magique', chapters: ['Le marché', 'Le géant'] },
  ...patch,
});

describe('identify', () => {
  it('nomme l’histoire d’après la bibliothèque Yoto, sans rien à signaler', () => {
    const identity = identify(facts({ project: { id: 3, title: 'Jack (brouillon)' } }));
    assert.equal(identity.title, 'Jack et le haricot magique');
    assert.deepEqual(identity.chapters, ['Le marché', 'Le géant']);
    assert.deepEqual(identity.project, { id: 3, title: 'Jack (brouillon)' });
    assert.deepEqual(identity.notes, []);
  });

  it('se rabat sur le projet, puis sur le surnom, quand Yoto ne répond pas', () => {
    const offline = { library: 'non-connecte' as const, remote: undefined };
    assert.equal(
      identify(facts({ ...offline, project: { id: 1, title: 'Projet' } })).title,
      'Projet',
    );
    assert.equal(
      identify(facts({ ...offline, pool: { nickname: 'la bleue', ndefUrl: null } })).title,
      'la bleue',
    );
    const notes = identify(facts(offline)).notes;
    assert.equal(notes[0]?.kind, 'warn');
    assert.match(notes[0]?.fix ?? '', /Reconnecte-toi/);
  });

  it('explique un contenu absent de la bibliothèque et comment relier le passeur', () => {
    const identity = identify(facts({ library: 'introuvable', remote: undefined }));
    assert.equal(identity.title, null);
    assert.equal(identity.notes[0]?.kind, 'error');
    assert.match(identity.notes[0]?.text ?? '', /AbC12 n'existe pas dans ta bibliothèque/);
    assert.match(identity.notes[0]?.fix ?? '', /Link to a card/);
  });

  it('prévient d’une histoire publiée sans piste', () => {
    const notes = identify(facts({ remote: { title: 'Vide', chapters: [] } })).notes;
    assert.match(notes[0]?.text ?? '', /aucune piste/);
  });

  it('signale un jeton différent de celui déjà enregistré', () => {
    const notes = identify(
      facts({ pool: { nickname: 'Jack', ndefUrl: 'https://yoto.io/AbC12?ancien' } }),
    ).notes;
    assert.match(notes[0]?.text ?? '', /jeton différent/);
    assert.deepEqual(identify(facts({ pool: { nickname: 'Jack', ndefUrl: URL } })).notes, []);
  });

  it('ne reproche rien au passeur, qui change d’histoire à chaque liaison', () => {
    const notes = identify(
      facts({ passeur: true, chip: { cardId: 'ZZZ99', writtenAt: '2026-10-01 10:00:00', title: 'Autre' } }),
    ).notes;
    assert.deepEqual(notes, []);
  });

  it('signale une puce que le registre associe à une autre histoire', () => {
    const notes = identify(
      facts({ chip: { cardId: 'ZZZ99', writtenAt: '2026-10-01 10:00:00', title: 'Boucle d’or' } }),
    ).notes;
    assert.match(notes[0]?.text ?? '', /portait « Boucle d’or » \(ZZZ99\)/);
    assert.deepEqual(
      identify(facts({ chip: { cardId: 'AbC12', writtenAt: '2026-10-01 10:00:00' } })).notes,
      [],
    );
  });
});
