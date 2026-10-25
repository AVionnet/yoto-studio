/**
 * Tests de public/encoder.js (l'atelier d'encodage) et de public/lecteur.js (lire une carte).
 *
 * Web NFC n'existe que sur Chrome pour Android : ce code ne peut pas s'essayer sur la machine de
 * developpement, et il ecrit sur du materiel — une carte mal encodee se constate carte en main.
 * D'ou ce harnais : un DOM reduit aux identifiants des pages, un NDEFReader simule sur lequel on
 * « pose » des cartes, et les scripts executes tels quels dans un contexte vm.
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

const CARD_URL = 'https://yoto.io/AbC12?fJ3kQ9vRtYs2LmNp';
const PASSEUR = '04:aa:bb:cc:dd:ee:90';
const BLANK = '04:11:22:33:44:55:90';

/** Ce que le serveur renvoie pour CARD_URL, au releve comme a l'identification. */
const IDENTITY = {
  cardId: 'AbC12',
  title: 'Jack et le haricot magique',
  chapters: ['Le marché', 'Le haricot', 'Le géant'],
  library: 'ok',
  project: { id: 1, title: 'Jack et le haricot magique' },
  nickname: 'Jack',
  passeur: false,
  chip: null,
  notes: [],
  tags: 1,
};

interface Option { value: string; textContent: string }

interface FakeElement {
  textContent: string;
  innerHTML: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  dataset: Record<string, string>;
  options: Option[];
  selectedIndex: number;
  appendChild(option: Option): void;
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  fire(type: string, event?: unknown): Promise<unknown[]>;
}

function fakeElement(): FakeElement {
  const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
  const element: FakeElement = {
    textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, value: '',
    dataset: {}, options: [], selectedIndex: 0,
    appendChild(option) {
      element.options.push(option);
    },
    addEventListener(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    fire: (type, event = { preventDefault() {} }) =>
      Promise.all((handlers[type] ?? []).map((fn) => fn(event))),
  };
  return element;
}

/** Une lecture NFC telle que Web NFC la livre : l'URL arrive en octets. */
const reading = (url: string, serialNumber: string) => ({
  serialNumber,
  message: { records: [{ recordType: 'url', data: new TextEncoder().encode(url) }] },
});

const blankReading = (serialNumber: string) => ({ serialNumber, message: { records: [] } });

/** Une puce formatée mais sans contenu : un unique enregistrement NDEF vide. */
const emptyReading = (serialNumber: string) => ({
  serialNumber,
  message: { records: [{ recordType: 'empty', data: new Uint8Array() }] },
});

/** Une erreur telle que Web NFC la leve : un DOMException dont seul le nom compte. */
const nfcError = (name: string, message = 'refusé'): Error =>
  Object.assign(new Error(message), { name });

const IDS = [
  'indispo', 'enregistrer', 'etat', 'resultat', 'atelier', 'histoire', 'demarrer', 'consigne',
  'journal', 'lecteur', 'scanner', 'rapport',
];

interface Harness {
  el: Record<string, FakeElement>;
  /** Pose une carte sur le telephone : chaque scan actif la recoit. */
  present(card: unknown): Promise<void>;
  /** Erreur a lever au prochain scan(), le cas echeant. */
  scanError: Error | undefined;
  writes: string[];
  writeError: Error | undefined;
  /** Les appels POST, dans l'ordre. */
  posts: { url: string; body: Record<string, string> }[];
  gets: string[];
  /** Reponse de chaque route, par URL. */
  replies: Record<string, unknown>;
  reloaded: boolean;
  settle(): Promise<void>;
}

function load(options: {
  script?: string;
  /** Les identifiants absents de la page simulee. */
  without?: string[];
  dataset?: Record<string, string>;
  stories?: Option[];
  nfc?: boolean;
} = {}): Harness {
  const el: Record<string, FakeElement> = {};
  for (const id of IDS) if (!options.without?.includes(id)) el[id] = fakeElement();
  const root = el['atelier'] ?? el['lecteur'];
  if (root) Object.assign(root.dataset, { passeur: PASSEUR, capacity: '48', ...options.dataset });
  const select = el['histoire'];
  if (select) {
    select.options = [{ value: '', textContent: 'Celle que porte le passeur' }, ...(options.stories ?? [])];
    const chosen = select.options.findIndex((o) => o.value === options.dataset?.['targetCard']);
    select.selectedIndex = Math.max(chosen, 0);
    select.value = select.options[select.selectedIndex]!.value;
  }

  const readers: { fire(type: string, event: unknown): void; signal: AbortSignal }[] = [];
  const harness: Harness = {
    el,
    present: async (card) => {
      for (const reader of readers.filter((r) => !r.signal.aborted)) {
        reader.fire(card === 'illisible' ? 'readingerror' : 'reading', card);
      }
      await harness.settle();
    },
    scanError: undefined,
    writes: [],
    writeError: undefined,
    posts: [],
    gets: [],
    replies: {
      '/cartes/releve': IDENTITY,
      '/cartes/identifier': IDENTITY,
      '/cartes/encoder': { cardId: 'AbC12', tags: 1 },
      '/cartes/passeur': { uid: PASSEUR },
      '/cartes/AbC12/adresse': { url: CARD_URL },
    },
    reloaded: false,
    settle: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };

  class NDEFReader {
    private handlers: Record<string, ((event: unknown) => void)[]> = {};

    addEventListener(type: string, fn: (event: unknown) => void): void {
      (this.handlers[type] ??= []).push(fn);
    }

    scan({ signal }: { signal: AbortSignal }): Promise<void> {
      if (harness.scanError) return Promise.reject(harness.scanError);
      readers.push({ signal, fire: (type, event) => (this.handlers[type] ?? []).forEach((fn) => fn(event)) });
      return Promise.resolve();
    }

    write(message: { records: { data: string }[] }): Promise<void> {
      if (harness.writeError) return Promise.reject(harness.writeError);
      harness.writes.push(message.records[0]!.data);
      return Promise.resolve();
    }
  }

  const window: Record<string, unknown> = {
    location: { reload: () => { harness.reloaded = true; } },
  };
  if (options.nfc !== false) window['NDEFReader'] = NDEFReader;
  const sandbox: Record<string, unknown> = {
    window, NDEFReader,
    AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, console, Date,
    document: {
      getElementById: (id: string) => el[id] ?? null,
      createElement: () => ({ value: '', textContent: '' }),
    },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') harness.posts.push({ url, body: JSON.parse(init.body ?? '{}') });
      else harness.gets.push(url);
      const answer = harness.replies[url] ?? {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
    },
  };
  sandbox['globalThis'] = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(COMMON, sandbox);
  vm.runInContext(options.script ?? ENCODER, sandbox);
  return harness;
}

const ATELIER_ONLY = ['enregistrer', 'lecteur'];
const JACK = { value: 'AbC12', textContent: 'Jack et le haricot magique · 1 copie(s)' };

/** Ouvre l'atelier et lance la lecture continue. */
async function start(options: Parameters<typeof load>[0] = {}): Promise<Harness> {
  const h = load({ without: ATELIER_ONLY, ...options });
  await h.settle();
  await h.el['demarrer']!.fire('click');
  await h.settle();
  return h;
}

describe('enregistrer le passeur', () => {
  const page = () => load({ without: ['atelier', 'histoire', 'lecteur'] });

  it('enregistre l’uid de la carte MYO posée, puis recharge la page', async () => {
    const h = page();
    await h.el['enregistrer']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));

    assert.deepEqual(h.posts, [{ url: '/cartes/passeur', body: { uid: PASSEUR } }]);
    assert.equal(h.reloaded, true);
  });

  it('refuse une carte qui ne porte pas d’adresse Yoto', async () => {
    const h = page();
    await h.el['enregistrer']!.fire('click');
    await h.present(blankReading(BLANK));

    assert.equal(h.posts.length, 0);
    assert.match(h.el['resultat']!.innerHTML, /Ce n’est pas une carte Yoto/);
    assert.match(h.el['resultat']!.innerHTML, /Comment corriger/);
  });
});

describe('atelier', () => {
  it('relève le passeur, nomme son histoire, puis copie sur la vierge suivante', async () => {
    const h = await start();
    assert.match(h.el['consigne']!.innerHTML, /pose le passeur/);

    await h.present(reading(CARD_URL, PASSEUR));
    assert.deepEqual(h.posts[0], { url: '/cartes/releve', body: { url: CARD_URL, uid: PASSEUR } });
    assert.match(h.el['journal']!.innerHTML, /Passeur relevé :<\/strong> « Jack et le haricot magique »/);
    assert.equal(h.el['histoire']!.value, 'AbC12');
    assert.match(h.el['consigne']!.innerHTML, /Pose une carte vierge/);
    assert.equal(h.writes.length, 0, 'le passeur ne se réécrit jamais');

    await h.present(blankReading(BLANK));
    assert.deepEqual(h.writes, [CARD_URL]);
    assert.deepEqual(h.posts[1], { url: '/cartes/encoder', body: { url: CARD_URL, uid: BLANK } });
    assert.match(h.el['journal']!.innerHTML, /Copie prête :<\/strong> « Jack et le haricot magique »/);
  });

  it('copie une histoire déjà relevée sans repasser par le passeur', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    assert.deepEqual(h.gets, ['/cartes/AbC12/adresse']);

    await h.present(blankReading(BLANK));
    assert.deepEqual(h.writes, [CARD_URL]);
  });

  it('ne réécrit pas une carte déjà prête', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.present(reading(CARD_URL, BLANK));

    assert.equal(h.writes.length, 0);
    assert.match(h.el['journal']!.innerHTML, /déjà prête/);
  });

  it('demande confirmation avant d’écraser une carte qui porte autre chose', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    const other = reading('https://yoto.io/ZZZ99?x', BLANK);

    await h.present(other);
    assert.equal(h.writes.length, 0);
    assert.match(h.el['journal']!.innerHTML, /n’est pas vierge[\s\S]*<code>ZZZ99<\/code>/);

    await h.el['journal']!.fire('click', { target: { dataset: { ecraser: BLANK }, parentNode: {} } });
    await h.present(other);
    assert.deepEqual(h.writes, [CARD_URL]);
  });

  it('ignore une carte laissée en place, qui se relit en boucle', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.present(blankReading(BLANK));
    await h.present(blankReading(BLANK));

    assert.equal(h.writes.length, 1);
  });

  it('écrit sur une puce neuve illisible, que Chrome formate', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.present('illisible');

    assert.deepEqual(h.writes, [CARD_URL]);
    assert.equal(h.posts.at(-1)?.body['uid'], '');
  });

  it('traite une puce au contenu NDEF vide comme une vierge, sans confirmation', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.present(emptyReading(BLANK));

    assert.deepEqual(h.writes, [CARD_URL]);
    assert.doesNotMatch(h.el['journal']!.innerHTML, /n’est pas vierge/);
  });

  it('n’écrit rien tant qu’aucune histoire n’est choisie', async () => {
    const h = await start();
    await h.present(blankReading(BLANK));

    assert.equal(h.writes.length, 0);
    assert.match(h.el['journal']!.innerHTML, /Aucune histoire choisie/);
  });

  it('prévient quand le passeur porte une autre histoire que le projet ouvert', async () => {
    const h = await start({ dataset: { targetCard: 'OTHER' } });
    await h.present(reading(CARD_URL, PASSEUR));

    assert.match(h.el['journal']!.innerHTML, /alert warn[\s\S]*pas l’histoire du projet ouvert/);
  });

  it('relaie les problèmes trouvés au relevé, avec leur correction', async () => {
    const h = await start();
    h.replies['/cartes/releve'] = {
      ...IDENTITY,
      title: null,
      notes: [{ kind: 'error', text: 'Le contenu AbC12 n’existe pas', fix: 'Relie-le dans l’app' }],
    };
    await h.present(reading(CARD_URL, PASSEUR));

    assert.doesNotMatch(h.el['journal']!.innerHTML, /Passeur relevé/);
    assert.match(h.el['journal']!.innerHTML, /n’existe pas[\s\S]*Comment corriger :<\/strong> Relie-le/);
  });

  it('signale une puce qui n’est pas une Ultralight EV1 de NXP', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.present(blankReading('8e:d1:f9:04'));

    assert.match(h.el['journal']!.innerHTML, /pas une Ultralight EV1/);
  });

  it('traduit un échec d’écriture en geste à faire', async () => {
    const h = await start({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    h.writeError = nfcError('NotSupportedError');
    await h.present(blankReading(BLANK));

    assert.match(h.el['journal']!.innerHTML, /n’est pas formatée NDEF/);
    assert.equal(h.posts.length, 0);
  });

  it('explique un refus d’accès au NFC', async () => {
    const h = load({ without: ATELIER_ONLY });
    h.scanError = nfcError('NotAllowedError');
    await h.el['demarrer']!.fire('click');
    await h.settle();

    assert.match(h.el['journal']!.innerHTML, /Chrome n’a pas le droit d’utiliser le NFC/);
    assert.match(h.el['journal']!.innerHTML, /NotAllowedError — refusé/);
    assert.equal(h.el['demarrer']!.textContent, 'Commencer');
  });
});

describe('lecture et vérification d’une carte', () => {
  const loadReader = () =>
    load({ script: READER, without: ['atelier', 'histoire', 'enregistrer'] });

  async function readCard(h: Harness, card: unknown): Promise<string> {
    await h.el['scanner']!.fire('click');
    await h.settle();
    await h.present(card);
    return h.el['rapport']!.innerHTML;
  }

  it('affiche l’histoire dont une copie porte l’adresse, et où elle jouera', async () => {
    const report = await readCard(loadReader(), reading(CARD_URL, BLANK));

    assert.match(report, /Adresse correcte :<\/strong> « Jack et le haricot magique »/);
    assert.match(report, /pas dans l’app Yoto du téléphone/);
    assert.match(report, /<li>Le géant<\/li>/);
    assert.doesNotMatch(report, /fJ3kQ9/, 'le jeton reste masqué');
  });

  it('reconnaît le passeur', async () => {
    const h = loadReader();
    h.replies['/cartes/identifier'] = { ...IDENTITY, passeur: true };
    const report = await readCard(h, reading(CARD_URL, PASSEUR));

    assert.match(report, /C’est ton passeur/);
  });

  it('ne déclare pas correcte une carte dont le contenu est introuvable', async () => {
    const h = loadReader();
    h.replies['/cartes/identifier'] = {
      ...IDENTITY,
      title: null,
      notes: [{ kind: 'error', text: 'introuvable', fix: 'relie-la' }],
    };
    const report = await readCard(h, reading(CARD_URL, BLANK));

    assert.doesNotMatch(report, /Adresse correcte/);
    assert.match(report, /introuvable[\s\S]*relie-la/);
  });

  it('signale une puce vide comme prête à encoder', async () => {
    assert.match(await readCard(loadReader(), blankReading(BLANK)), /Carte vide/);
  });

  it('explique une puce détectée mais illisible', async () => {
    assert.match(await readCard(loadReader(), 'illisible'), /Chrome ne lit pas son contenu/);
  });

  it('montre l’erreur de scan et sa correction', async () => {
    const h = loadReader();
    h.scanError = nfcError('NotReadableError');
    await h.el['scanner']!.fire('click');
    await h.settle();

    assert.match(h.el['rapport']!.innerHTML, /NFC du téléphone est indisponible/);
    assert.match(h.el['rapport']!.innerHTML, /Comment corriger/);
  });
});

describe('navigateur sans Web NFC', () => {
  it('désactive l’atelier et l’explique, au lieu de planter', () => {
    const h = load({ without: ATELIER_ONLY, nfc: false });
    assert.equal(h.el['indispo']!.hidden, false);
    assert.equal(h.el['demarrer']!.disabled, true);
  });
});
