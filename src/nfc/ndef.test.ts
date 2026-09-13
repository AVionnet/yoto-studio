/** Tests du tag NDEF : lecture d'une URL de carte, et encombrement sur 48 octets. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TAG_CAPACITY, buildYotoUrl, encodeNdef, fits, freeBytes, parseYotoUrl, tagBytes } from './ndef.ts';

describe("lecture de l'URL d'une carte", () => {
  it('separe le cardId du token', () => {
    assert.deepEqual(parseYotoUrl('https://yoto.io/AbC12?Xy9-tokenValue'), {
      cardId: 'AbC12',
      token: 'Xy9-tokenValue',
    });
  });

  it('accepte une carte sans token', () => {
    assert.deepEqual(parseYotoUrl('https://yoto.io/AbC12'), { cardId: 'AbC12', token: '' });
  });

  it('garde le token brut, sans le lire comme des parametres', () => {
    // Un token qui contient `=` ou `&` ne doit pas etre re-serialise : on recopie tel quel.
    assert.equal(parseYotoUrl('https://yoto.io/AbC12?a=b&c')?.token, 'a=b&c');
  });

  it('tolere une barre finale et un sous-domaine', () => {
    assert.equal(parseYotoUrl('https://yoto.io/AbC12/?tok')?.cardId, 'AbC12');
    assert.equal(parseYotoUrl('https://www.yoto.io/AbC12?tok')?.cardId, 'AbC12');
  });

  it('refuse ce qui n’est pas une carte Yoto', () => {
    for (const url of [
      '',
      'pas une url',
      'https://example.com/AbC12?tok', // autre systeme
      'https://yoto.io/', // puce formatee, sans identite
      'https://yoto.io/ab', // trop court pour un cardId
      'https://notyoto.io/AbC12?tok',
      'https://yoto.io.evil.test/AbC12?tok',
    ]) {
      assert.equal(parseYotoUrl(url), undefined, url);
    }
  });

  it('fait un aller-retour avec buildYotoUrl', () => {
    const url = 'https://yoto.io/AbC12?Xy9tok';
    assert.equal(buildYotoUrl(parseYotoUrl(url)!), url);
  });
});

describe('encombrement sur la puce', () => {
  it('abrege https:// en un octet de prefixe', () => {
    const bytes = encodeNdef('https://yoto.io/AbC12');
    // 03 L | D1 01 PL 55 | 04 + « yoto.io/AbC12 » | FE
    assert.deepEqual([...bytes.slice(0, 2)], [0x03, 0x12]);
    assert.deepEqual([...bytes.slice(2, 7)], [0xd1, 0x01, 0x0e, 0x55, 0x04]);
    assert.equal(bytes.at(-1), 0xfe);
    assert.equal(bytes.length, 21); // 8 d'ossature + 13 de « yoto.io/AbC12 »
  });

  it('compte huit octets d’ossature autour de l’URL', () => {
    const url = 'https://yoto.io/AbC12?Xy9tok';
    assert.equal(tagBytes(url), url.length - 'https://'.length + 8);
  });

  it('laisse passer une URL Yoto reelle, de justesse', () => {
    // ~45 octets releves sur les cartes du commerce : ca tient, sans beaucoup de marge.
    const url = 'https://yoto.io/AbC12?fJ3kQ9vRtYs2LmNp8XwZ';
    assert.ok(fits(url));
    assert.ok(freeBytes(url) < 12, `marge inattendue : ${freeBytes(url)}`);
  });

  it('refuse ce qui depasse 48 octets', () => {
    const url = `https://yoto.io/AbC12?${'x'.repeat(48)}`;
    assert.equal(fits(url), false);
    assert.ok(freeBytes(url) < 0);
    assert.ok(tagBytes(url) > TAG_CAPACITY);
  });
});
