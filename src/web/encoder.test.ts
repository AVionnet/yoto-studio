/**
 * Tests de public/encoder.js, le client qui ecrit sur les cartes vierges.
 *
 * Web NFC n'existe que sur Chrome pour Android : ce code ne peut pas s'essayer sur la machine de
 * developpement, et il ecrit sur du materiel — une carte mal encodee se constate carte en main.
 * D'ou ce harnais : un DOM reduit aux identifiants de la page, un NDEFReader simule, et le script
 * execute tel quel dans un contexte vm.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'encoder.js');

/** Les identifiants que la page /cartes/encoder expose au script. */
const IDS = [
  'encodeur', 'indispo', 'lire', 'reprise', 'source', 'ecriture', 'ecrire', 'verrou', 'etat',
  'resultat', 'source-verdict', 'source-card', 'source-size', 'source-token', 'connue',
];

const CARD_URL = 'https://yoto.io/AbC12?fJ3kQ9vRtYs2LmNp';

interface FakeElement {
  textContent: string;
  innerHTML: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  dataset: Record<string, string>;
  classList: { add(): void; remove(): void };
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  querySelector(): FakeElement;
  scrollIntoView(): void;
  fire(type: string): Promise<unknown[]>;
}

function fakeElement(): FakeElement {
  const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
  const element: FakeElement = {
    textContent: '', innerHTML: '', className: '', hidden: false, disabled: false,
    checked: false, value: '', dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    querySelector: () => fakeElement(),
    scrollIntoView() {},
    fire: (type) =>
      Promise.all((handlers[type] ?? []).map((fn) => fn({ preventDefault() {} }))),
  };
  return element;
}

/** Une lecture NFC telle que Web NFC la livre : l'URL arrive en octets. */
const reading = (url: string, serialNumber: string) => ({
  serialNumber,
  message: { records: [{ recordType: 'url', data: new TextEncoder().encode(url) }] },
});

const blankReading = (serialNumber: string) => ({ serialNumber, message: { records: [] } });

interface Harness {
  el: Record<string, FakeElement>;
  /** Ce que les prochains scans renverront, dans l'ordre. */
  scans: unknown[];
  writes: { records: { recordType: string; data: string }[] }[];
  locks: number;
  /** Tous les appels fetch du script, GET compris. */
  calls: { url: string; body: Record<string, string> }[];
  /** Reponse du prochain fetch. */
  reply: Record<string, unknown>;
  settle(): Promise<void>;
}

function load(dataset: Record<string, string>): Harness {
  const el = Object.fromEntries(IDS.map((id) => [id, fakeElement()]));
  Object.assign(el['encodeur']!.dataset, dataset);
  el['connue']!.value = 'AbC12';

  const harness: Harness = {
    el,
    scans: [],
    writes: [],
    locks: 0,
    calls: [],
    reply: { cardId: 'AbC12', nickname: 'Jack et le haricot magique', tags: 2 },
    // Deux tours de boucle : le scan differe sa lecture, et la chaine de promesses suit.
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };

  class NDEFReader {
    private handlers: Record<string, ((event: unknown) => void)[]> = {};

    addEventListener(type: string, fn: (event: unknown) => void): void {
      (this.handlers[type] ??= []).push(fn);
    }

    scan(): Promise<void> {
      const next = harness.scans.shift();
      if (!next) {
        return Promise.reject(Object.assign(new Error('aucune carte'), { name: 'NotReadableError' }));
      }
      setTimeout(() => (this.handlers['reading'] ?? []).forEach((fn) => fn(next)), 0);
      return Promise.resolve();
    }

    write(message: { records: { recordType: string; data: string }[] }): Promise<void> {
      harness.writes.push(message);
      return Promise.resolve();
    }

    makeReadOnly(): Promise<void> {
      harness.locks += 1;
      return Promise.resolve();
    }
  }

  const sandbox: Record<string, unknown> = {
    window: { NDEFReader },
    NDEFReader,
    AbortController, URL, TextEncoder, TextDecoder, setTimeout, console,
    document: { getElementById: (id: string) => el[id] ?? null },
    fetch: (url: string, options?: { body?: string }) => {
      harness.calls.push({ url, body: options?.body ? JSON.parse(options.body) : {} });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(harness.reply) });
    },
  };
  sandbox['globalThis'] = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SCRIPT, 'utf8'), sandbox);
  return harness;
}

describe('relevé de la carte source', () => {
  it('affiche le contenu, le jeton masqué et l’occupation sur la puce', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading(CARD_URL, '04:a2:3b:11'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.equal(h.el['source']!.hidden, false);
    assert.equal(h.el['ecriture']!.hidden, false);
    assert.equal(h.el['source-card']!.textContent, 'AbC12');
    // 8 octets d'ossature NDEF + l'URL sans « https:// » : la meme arithmetique que tagBytes().
    assert.equal(h.el['source-size']!.textContent, '38 / 48 octets (10 libres)');
    assert.equal(h.el['source-token']!.className, 'masked');
    assert.match(h.el['source-verdict']!.innerHTML, /Adresse relevée/);
  });

  it('signale une carte qui porte un autre contenu que celui visé', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading('https://yoto.io/OTHER?tok', '04:11'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.match(h.el['source-verdict']!.innerHTML, /porte le contenu <code>OTHER<\/code>/);
  });

  it('explique qu’une puce vierge n’a rien à recopier', async () => {
    const h = load({ capacity: '48', targetCard: '', projet: '' });
    h.scans.push(blankReading('04:22'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.equal(h.el['source']!.hidden, true);
    assert.match(h.el['resultat']!.innerHTML, /ne porte pas d'adresse Yoto/);
  });

  it('refuse d’écrire une adresse qui dépasse la capacité de la puce', async () => {
    const h = load({ capacity: '48', targetCard: '', projet: '' });
    h.scans.push(reading(`https://yoto.io/AbC12?${'x'.repeat(48)}`, '04:33'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.equal(h.el['ecrire']!.disabled, true);
    assert.match(h.el['source-verdict']!.innerHTML, /ne tient pas sur une carte de 48 octets/);
  });

  it('reprend une adresse déjà relevée sans repasser par le tag', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.reply = { url: CARD_URL };

    await h.el['reprise']!.fire('submit');
    await h.settle();

    assert.equal(h.calls[0]?.url, '/cartes/AbC12/adresse');
    assert.equal(h.el['source-card']!.textContent, 'AbC12');
  });
});

describe('écriture sur la carte vierge', () => {
  it('écrit l’URL, relit la puce, puis enregistre son uid', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading(CARD_URL, '04:a2:3b:11'), reading(CARD_URL, '04:ff:ff:99'));

    await h.el['lire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();
    await h.settle();

    assert.equal(
      JSON.stringify(h.writes),
      JSON.stringify([{ records: [{ recordType: 'url', data: CARD_URL }] }]),
    );
    // L'uid ne vient pas de l'ecriture — Web NFC ne l'expose pas — mais de la relecture.
    assert.equal(
      JSON.stringify(h.calls),
      JSON.stringify([
        { url: '/cartes/encoder', body: { url: CARD_URL, uid: '04:ff:ff:99', projet: '1' } },
      ]),
    );
    assert.match(h.el['resultat']!.innerHTML, /Carte encodée/);
  });

  it('ne verrouille la puce que si la case est cochée', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading(CARD_URL, '04:a2'), reading(CARD_URL, '04:ff'));

    await h.el['lire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();
    assert.equal(h.locks, 0);

    h.scans.push(reading(CARD_URL, '04:bb'), reading(CARD_URL, '04:cc'));
    h.el['verrou']!.checked = true;
    await h.el['lire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();
    await h.settle();
    assert.equal(h.locks, 1);
  });

  it('garde la trace de l’encodage même quand la relecture échoue', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading(CARD_URL, '04:a2:3b:11')); // rien pour la vérification

    await h.el['lire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();
    await h.settle();

    assert.equal(h.writes.length, 1);
    assert.equal(h.calls.at(-1)?.body['uid'], '');
    assert.match(h.el['resultat']!.innerHTML, /Vérification impossible/);
  });

  it('refuse un relevé qui ne correspond pas à ce qui a été écrit', async () => {
    const h = load({ capacity: '48', targetCard: 'AbC12', projet: '1' });
    h.scans.push(reading(CARD_URL, '04:a2'), reading('https://yoto.io/WRONG?x', '04:ff'));

    await h.el['lire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();
    await h.settle();

    assert.equal(h.calls.length, 0, 'rien ne doit être enregistré si la relecture diffère');
    assert.match(h.el['resultat']!.innerHTML, /ne renvoie pas l'adresse écrite/);
  });
});

describe('navigateur sans Web NFC', () => {
  it('désactive les boutons et l’explique, au lieu de planter', () => {
    const el = Object.fromEntries(IDS.map((id) => [id, fakeElement()]));
    const sandbox: Record<string, unknown> = {
      window: {}, AbortController, URL, TextEncoder, TextDecoder, setTimeout, console,
      document: { getElementById: (id: string) => el[id] ?? null },
    };
    sandbox['globalThis'] = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(SCRIPT, 'utf8'), sandbox);

    assert.equal(el['indispo']!.hidden, false);
    assert.equal(el['lire']!.disabled, true);
    assert.equal(el['ecrire']!.disabled, true);
  });
});
