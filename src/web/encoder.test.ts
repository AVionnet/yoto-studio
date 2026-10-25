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

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const COMMON = readFileSync(join(PUBLIC, 'nfc.js'), 'utf8');
const ENCODER = readFileSync(join(PUBLIC, 'encoder.js'), 'utf8');
const READER = readFileSync(join(PUBLIC, 'lecteur.js'), 'utf8');

/** Les identifiants que les pages /cartes/encoder et /cartes/verifier exposent aux scripts. */
const IDS = [
  'encodeur', 'indispo', 'chk-nfc', 'chk-perm', 'lire', 'lire-etat', 'lire-resultat', 'reprise',
  'source', 'source-histoire', 'source-verdict', 'source-card', 'source-size', 'source-token',
  'connue', 'ecriture', 'ecrire', 'verrou', 'etat', 'resultat',
  'lecteur', 'scanner', 'rapport',
];

/** Ce que POST /cartes/identifier renvoie pour CARD_URL. */
const IDENTITY = {
  cardId: 'AbC12',
  title: 'Jack et le haricot magique',
  chapters: ['Le marché', 'Le haricot', 'Le géant'],
  library: 'ok',
  project: { id: 1, title: 'Jack et le haricot magique' },
  nickname: 'Jack',
  chip: null,
  notes: [],
  tags: 1,
};

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
  /** Ce que les prochains scans renverront, dans l'ordre. Une Error fait echouer le scan. */
  scans: unknown[];
  writes: { records: { recordType: string; data: string }[] }[];
  locks: number;
  /** Erreur a lever au prochain write(), le cas echeant. */
  writeError: Error | undefined;
  /** Les appels fetch du script, hors identification. */
  calls: { url: string; body: Record<string, string> }[];
  /** Les adresses envoyees a /cartes/identifier. */
  identified: { url: string; uid: string }[];
  /** Reponse de /cartes/identifier. */
  identity: Record<string, unknown>;
  /** Reponse des autres fetch. */
  reply: Record<string, unknown>;
  settle(): Promise<void>;
}

/** Une erreur telle que Web NFC la leve : un DOMException dont seul le nom compte. */
const nfcError = (name: string, message = 'refusé'): Error =>
  Object.assign(new Error(message), { name });

function load(dataset: Record<string, string>, script = ENCODER, root = 'encodeur'): Harness {
  const el = Object.fromEntries(IDS.map((id) => [id, fakeElement()]));
  Object.assign(el[root]!.dataset, dataset);
  el['connue']!.value = 'AbC12';
  el['source']!.hidden = true;
  el['ecriture']!.hidden = true;

  const harness: Harness = {
    el,
    scans: [],
    writes: [],
    locks: 0,
    writeError: undefined,
    calls: [],
    identified: [],
    identity: IDENTITY,
    reply: { cardId: 'AbC12', nickname: 'Jack', tags: 2 },
    // Plusieurs tours de boucle : le scan differe sa lecture, et la chaine de promesses suit.
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };

  class NDEFReader {
    private handlers: Record<string, ((event: unknown) => void)[]> = {};

    addEventListener(type: string, fn: (event: unknown) => void): void {
      (this.handlers[type] ??= []).push(fn);
    }

    scan(): Promise<void> {
      const next = harness.scans.shift();
      if (!next) return Promise.reject(nfcError('NotReadableError', 'aucune carte'));
      if (next instanceof Error) return Promise.reject(next);
      const type = next === 'illisible' ? 'readingerror' : 'reading';
      setTimeout(() => (this.handlers[type] ?? []).forEach((fn) => fn(next)), 0);
      return Promise.resolve();
    }

    write(message: { records: { recordType: string; data: string }[] }): Promise<void> {
      if (harness.writeError) return Promise.reject(harness.writeError);
      harness.writes.push(message);
      return Promise.resolve();
    }

    makeReadOnly(): Promise<void> {
      harness.locks += 1;
      return Promise.resolve();
    }
  }

  const window: Record<string, unknown> = { NDEFReader };
  const sandbox: Record<string, unknown> = {
    window,
    NDEFReader,
    AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, console, Date,
    document: { getElementById: (id: string) => el[id] ?? null },
    fetch: (url: string, options?: { body?: string }) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (url === '/cartes/identifier') harness.identified.push(body);
      else harness.calls.push({ url, body });
      const answer = url === '/cartes/identifier' ? harness.identity : harness.reply;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
    },
  };
  sandbox['globalThis'] = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(COMMON, sandbox);
  vm.runInContext(script, sandbox);
  return harness;
}

const TARGET = { capacity: '48', targetCard: 'AbC12', targetTitle: 'Jack et le haricot magique', projet: '1' };
const FREE = { capacity: '48', targetCard: '', targetTitle: '', projet: '' };

describe('relevé du passeur', () => {
  it('affiche le titre de l’histoire et ses pistes, pas seulement l’identifiant', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2:3b:11'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.deepEqual(h.identified, [{ url: CARD_URL, uid: '04:a2:3b:11' }]);
    assert.match(h.el['source-histoire']!.innerHTML, /« Jack et le haricot magique »/);
    assert.match(h.el['source-histoire']!.innerHTML, /<li>Le géant<\/li>/);
    assert.match(h.el['source-histoire']!.innerHTML, /3 pistes/);
    assert.match(h.el['source-verdict']!.innerHTML, /C’est bon/);
    assert.equal(h.el['source']!.hidden, false);
    assert.equal(h.el['ecriture']!.hidden, false);
    // 8 octets d'ossature NDEF + l'URL sans « https:// » : la meme arithmetique que tagBytes().
    assert.equal(h.el['source-size']!.textContent, '38 / 48 octets (10 libres)');
    assert.equal(h.el['source-token']!.className, 'masked');
  });

  it('nomme les deux histoires quand le passeur porte la mauvaise', async () => {
    const h = load(TARGET);
    h.identity = { ...IDENTITY, cardId: 'OTHER', title: 'Boucle d’or', chapters: [] };
    h.scans.push(reading('https://yoto.io/OTHER?tok', '04:11'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.match(
      h.el['source-verdict']!.innerHTML,
      /Le passeur porte « Boucle d’or », pas « Jack et le haricot magique »/,
    );
    assert.match(h.el['source-verdict']!.innerHTML, /Comment corriger/);
  });

  it('relaie les problèmes trouvés par le serveur, avec leur correction', async () => {
    const h = load(FREE);
    h.identity = {
      ...IDENTITY,
      title: null,
      chapters: [],
      library: 'introuvable',
      notes: [{ kind: 'error', text: 'Le contenu AbC12 n’existe pas', fix: 'Relie-le dans l’app' }],
    };
    h.scans.push(reading(CARD_URL, '04:11'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.match(h.el['source-histoire']!.innerHTML, /Histoire inconnue/);
    assert.doesNotMatch(h.el['source-verdict']!.innerHTML, /C’est bon/);
    assert.match(h.el['source-verdict']!.innerHTML, /n’existe pas[\s\S]*Comment corriger :<\/strong> Relie-le/);
  });

  it('affiche l’erreur de lecture à l’étape 2, là où on la voit', async () => {
    const h = load(FREE);
    h.scans.push(nfcError('NotAllowedError'));

    await h.el['lire']!.fire('click');
    await h.settle();

    // Avant, l'erreur partait dans le panneau d'ecriture — encore masque a ce stade.
    assert.match(h.el['lire-resultat']!.innerHTML, /Chrome n’a pas le droit d’utiliser le NFC/);
    assert.match(h.el['lire-resultat']!.innerHTML, /Appareils NFC → Autoriser/);
    assert.match(h.el['lire-resultat']!.innerHTML, /NotAllowedError — refusé/);
    assert.equal(h.el['lire']!.disabled, false);
  });

  it('explique qu’une puce vide n’est pas le passeur', async () => {
    const h = load(FREE);
    h.scans.push(blankReading('04:22'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.equal(h.el['source']!.hidden, true);
    assert.match(h.el['lire-resultat']!.innerHTML, /Cette carte est vide/);
    assert.equal(h.identified.length, 0);
  });

  it('refuse d’écrire une adresse qui dépasse la capacité de la puce', async () => {
    const h = load(FREE);
    h.scans.push(reading(`https://yoto.io/AbC12?${'x'.repeat(48)}`, '04:33'));

    await h.el['lire']!.fire('click');
    await h.settle();

    assert.equal(h.el['ecrire']!.disabled, true);
    assert.match(h.el['source-verdict']!.innerHTML, /ne tient pas sur une carte de 48 octets/);
  });

  it('reprend une adresse déjà relevée sans repasser par le tag', async () => {
    const h = load(TARGET);
    h.reply = { url: CARD_URL };

    await h.el['reprise']!.fire('submit');
    await h.settle();

    assert.equal(h.calls[0]?.url, '/cartes/AbC12/adresse');
    assert.equal(h.el['source-card']!.textContent, 'AbC12');
    assert.match(h.el['source-histoire']!.innerHTML, /Jack et le haricot magique/);
  });
});

/** Releve le passeur, puis ecrit : le parcours complet jusqu'au message final. */
async function readThenWrite(h: Harness): Promise<void> {
  await h.el['lire']!.fire('click');
  await h.settle();
  await h.el['ecrire']!.fire('click');
  await h.settle();
  await h.settle();
}

describe('écriture sur la carte vierge', () => {
  it('écrit l’URL, relit la puce, enregistre son uid et nomme l’histoire', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2:3b:11'), reading(CARD_URL, '04:ff:ff:99'));

    await readThenWrite(h);

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
    assert.match(h.el['resultat']!.innerHTML, /Carte encodée et vérifiée/);
    assert.match(h.el['resultat']!.innerHTML, /« Jack et le haricot magique »/);
  });

  it('reconnaît le passeur réécrit à la place de la vierge, et n’enregistre rien', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2'), reading(CARD_URL, '04:a2'));

    await readThenWrite(h);

    assert.equal(h.calls.length, 0);
    assert.match(h.el['resultat']!.innerHTML, /C’est le passeur qui a été réécrit/);
    assert.match(h.el['resultat']!.innerHTML, /Éloigne-le/);
  });

  it('ne verrouille la puce que si la case est cochée', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2'), reading(CARD_URL, '04:ff'));

    await readThenWrite(h);
    assert.equal(h.locks, 0);

    h.scans.push(reading(CARD_URL, '04:bb'), reading(CARD_URL, '04:cc'));
    h.el['verrou']!.checked = true;
    await readThenWrite(h);
    assert.equal(h.locks, 1);
  });

  it('garde la trace de l’encodage même quand la relecture échoue', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2:3b:11')); // rien pour la vérification

    await readThenWrite(h);

    assert.equal(h.writes.length, 1);
    assert.equal(h.calls.at(-1)?.body['uid'], '');
    assert.match(h.el['resultat']!.innerHTML, /pas vérifiée/);
    assert.match(h.el['resultat']!.innerHTML, /Lire une carte/);
  });

  it('refuse un relevé qui ne correspond pas à ce qui a été écrit', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2'), reading('https://yoto.io/WRONG?x', '04:ff'));

    await readThenWrite(h);

    assert.equal(h.calls.length, 0, 'rien ne doit être enregistré si la relecture diffère');
    assert.match(h.el['resultat']!.innerHTML, /ne porte pas l’adresse qui vient d’être écrite/);
    assert.doesNotMatch(h.el['resultat']!.innerHTML, /\?x/, 'le jeton relu reste masqué');
  });

  it('traduit un échec d’écriture en geste à faire', async () => {
    const h = load(TARGET);
    h.scans.push(reading(CARD_URL, '04:a2'));
    h.writeError = nfcError('NotSupportedError');

    await readThenWrite(h);

    assert.match(h.el['resultat']!.innerHTML, /n’est pas formatée NDEF/);
    assert.match(h.el['resultat']!.innerHTML, /Si ça bloque/);
    assert.equal(h.el['ecrire']!.disabled, false);
  });
});

describe('lecture et vérification d’une carte', () => {
  const loadReader = () => load({ capacity: '48' }, READER, 'lecteur');

  it('affiche l’histoire jouée par une carte valide', async () => {
    const h = loadReader();
    h.scans.push(reading(CARD_URL, '04:a2'));

    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.deepEqual(h.identified, [{ url: CARD_URL, uid: '04:a2' }]);
    assert.match(h.el['rapport']!.innerHTML, /Carte valide/);
    assert.match(h.el['rapport']!.innerHTML, /« Jack et le haricot magique »/);
    assert.match(h.el['rapport']!.innerHTML, /04:a2/);
    assert.doesNotMatch(h.el['rapport']!.innerHTML, /fJ3kQ9/, 'le jeton reste masqué');
  });

  it('ne déclare pas valide une carte dont le contenu est introuvable', async () => {
    const h = loadReader();
    h.identity = {
      ...IDENTITY,
      title: null,
      chapters: [],
      notes: [{ kind: 'error', text: 'introuvable', fix: 'relie-la' }],
    };
    h.scans.push(reading(CARD_URL, '04:a2'));

    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.doesNotMatch(h.el['rapport']!.innerHTML, /Carte valide/);
    assert.match(h.el['rapport']!.innerHTML, /introuvable[\s\S]*relie-la/);
  });

  it('signale une puce vide comme prête à encoder', async () => {
    const h = loadReader();
    h.scans.push(blankReading('04:22'));

    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.match(h.el['rapport']!.innerHTML, /Carte vide/);
    assert.equal(h.identified.length, 0);
  });

  it('explique une puce détectée mais illisible', async () => {
    const h = loadReader();
    h.scans.push('illisible');

    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.match(h.el['rapport']!.innerHTML, /Chrome ne lit pas son contenu/);
  });

  it('montre l’erreur de scan et sa correction', async () => {
    const h = loadReader();
    h.scans.push(nfcError('NotReadableError'));

    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.match(h.el['rapport']!.innerHTML, /NFC du téléphone est indisponible/);
    assert.match(h.el['rapport']!.innerHTML, /Comment corriger/);
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
    vm.runInContext(COMMON, sandbox);
    vm.runInContext(ENCODER, sandbox);

    assert.equal(el['indispo']!.hidden, false);
    assert.equal(el['lire']!.disabled, true);
    assert.equal(el['ecrire']!.disabled, true);
    assert.match(el['chk-nfc']!.innerHTML, /Web NFC absent/);
  });
});
