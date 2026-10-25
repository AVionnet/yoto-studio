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
  classList: { add(c: string): void; remove(c: string): void };
  appendChild(option: Option): void;
  addEventListener(type: string, fn: (event: unknown) => unknown): void;
  fire(type: string, event?: unknown): Promise<unknown[]>;
}

function fakeElement(): FakeElement {
  const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
  const element: FakeElement = {
    textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, value: '',
    dataset: {}, options: [], selectedIndex: 0,
    classList: { add() {}, remove() {} },
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
  'indispo', 'enregistrer', 'etat', 'resultat', 'atelier', 'histoire', 'relever', 'etat-relever',
  'panneau-ecrire', 'changer', 'ecrire', 'etat-ecrire', 'consigne', 'journal', 'lecteur', 'scanner', 'rapport',
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

/** Charge l'atelier (passeur déjà enregistré). */
async function atelier(options: Parameters<typeof load>[0] = {}): Promise<Harness> {
  const h = load({ without: ATELIER_ONLY, ...options });
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

describe('atelier — relever le passeur', () => {
  it('relève le passeur, nomme son histoire et arme l’écriture', async () => {
    const h = await atelier();
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));

    assert.deepEqual(h.posts[0], { url: '/cartes/releve', body: { url: CARD_URL, uid: PASSEUR } });
    assert.match(h.el['journal']!.innerHTML, /Passeur relevé :<\/strong> « Jack et le haricot magique »/);
    assert.equal(h.el['histoire']!.value, 'AbC12');
    assert.equal(h.el['panneau-ecrire']!.hidden, false);
    assert.equal(h.writes.length, 0, 'relever ne doit rien écrire');
  });

  it('refuse une carte qui n’est pas le passeur enregistré', async () => {
    const h = await atelier();
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, '04:99:99:99:99:99:90'));

    assert.equal(h.posts.length, 0);
    assert.match(h.el['journal']!.innerHTML, /n’est pas le passeur enregistré/);
  });

  it('refuse une carte sans adresse Yoto', async () => {
    const h = await atelier();
    await h.el['relever']!.fire('click');
    await h.present(blankReading(PASSEUR));

    assert.equal(h.posts.length, 0);
    assert.match(h.el['journal']!.innerHTML, /ne porte pas d’adresse Yoto/);
  });

  it('prévient quand le passeur porte une autre histoire que le projet ouvert', async () => {
    const h = await atelier({ dataset: { targetCard: 'OTHER' } });
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));

    assert.match(h.el['journal']!.innerHTML, /alert warn[\s\S]*pas l’histoire du projet ouvert/);
  });

  it('relaie les problèmes trouvés au relevé, avec leur correction', async () => {
    const h = await atelier();
    h.replies['/cartes/releve'] = {
      ...IDENTITY,
      title: null,
      notes: [{ kind: 'error', text: 'Le contenu AbC12 n’existe pas', fix: 'Relie-le dans l’app' }],
    };
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));

    assert.doesNotMatch(h.el['journal']!.innerHTML, /Passeur relevé/);
    assert.match(h.el['journal']!.innerHTML, /n’existe pas[\s\S]*Comment corriger :<\/strong> Relie-le/);
  });

  it('montre l’erreur de scan et sa correction', async () => {
    const h = await atelier();
    h.scanError = nfcError('NotAllowedError');
    await h.el['relever']!.fire('click');
    await h.settle();

    assert.match(h.el['journal']!.innerHTML, /Chrome n’a pas le droit d’utiliser le NFC/);
    assert.match(h.el['journal']!.innerHTML, /NotAllowedError — refusé/);
  });
});

describe('atelier — écrire sur une vierge', () => {
  it('écrit l’histoire choisie dans la liste, sans aucun scan', async () => {
    const h = await atelier({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    assert.deepEqual(h.gets, ['/cartes/AbC12/adresse']);
    assert.equal(h.el['panneau-ecrire']!.hidden, false);

    await h.el['ecrire']!.fire('click');
    await h.settle();

    assert.deepEqual(h.writes, [CARD_URL]);
    assert.deepEqual(h.posts.at(-1), { url: '/cartes/encoder', body: { url: CARD_URL, uid: '' } });
    assert.match(h.el['journal']!.innerHTML, /Copie prête :<\/strong> la carte porte « Jack et le haricot magique »/);
  });

  it('copie plusieurs vierges, un appui par carte', async () => {
    const h = await atelier({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    await h.el['ecrire']!.fire('click');
    await h.settle();
    await h.el['ecrire']!.fire('click');
    await h.settle();

    assert.deepEqual(h.writes, [CARD_URL, CARD_URL]);
    assert.equal(h.posts.filter((p) => p.url === '/cartes/encoder').length, 2);
  });

  it('n’écrit rien tant qu’aucune histoire n’est choisie', async () => {
    const h = await atelier();
    assert.equal(h.el['panneau-ecrire']!.hidden, true);
  });

  it('rappelle de formater la carte avec NFC Tools dès qu’une écriture échoue', async () => {
    const h = await atelier({ stories: [JACK], dataset: { targetCard: 'AbC12' } });
    h.writeError = nfcError('NetworkError', 'Failed to write due to an IO error');
    await h.el['ecrire']!.fire('click');
    await h.settle();

    assert.match(h.el['journal']!.innerHTML, /Formate d’abord ta carte avec l’app NFC Tools/);
    assert.match(h.el['journal']!.innerHTML, /Effacer le tag/);
    assert.equal(h.posts.filter((p) => p.url === '/cartes/encoder').length, 0);
  });

  it('écrit sur une vierge après avoir relevé une histoire inconnue de la liste', async () => {
    const h = await atelier();
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));
    await h.el['ecrire']!.fire('click');
    await h.settle();

    assert.deepEqual(h.writes, [CARD_URL]);
  });
});

describe('atelier — lire puis écrire une carte', () => {
  const OTHER_URL = 'https://yoto.io/XyZ98?aaaaBBBBccccDDDD';
  const jack = () => atelier({ stories: [JACK], dataset: { targetCard: 'AbC12' } });

  it('change l’histoire d’une carte déjà écrite, et note son uid et ce qu’elle portait', async () => {
    const h = await jack();
    h.replies['/cartes/encoder'] = {
      cardId: 'AbC12', tags: 2, replaced: 'Les trois petits cochons', tag: { id: 7, name: 'la rouge' },
    };
    await h.el['changer']!.fire('click');
    await h.present(reading(OTHER_URL, BLANK));

    assert.deepEqual(h.writes, [CARD_URL]);
    assert.deepEqual(h.posts.at(-1), {
      url: '/cartes/encoder',
      body: { url: CARD_URL, uid: BLANK, previous: OTHER_URL },
    });
    assert.match(
      h.el['journal']!.innerHTML,
      /Carte réécrite :<\/strong> « la rouge » passe de « Les trois petits cochons » à « Jack/,
    );
    assert.match(h.el['journal']!.innerHTML, /data-tag="7"[\s\S]*value="la rouge"/, 'on peut la renommer');
  });

  it('écrit une puce formatée vide sans rien demander', async () => {
    const h = await jack();
    await h.el['changer']!.fire('click');
    await h.present(emptyReading(BLANK));

    assert.deepEqual(h.writes, [CARD_URL]);
    assert.deepEqual(h.posts.at(-1)!.body, { url: CARD_URL, uid: BLANK });
  });

  it('n’écrit rien sur une carte qui porte déjà l’histoire', async () => {
    const h = await jack();
    await h.el['changer']!.fire('click');
    await h.present(reading(CARD_URL, BLANK));

    assert.equal(h.writes.length, 0);
    assert.match(h.el['journal']!.innerHTML, /Rien à écrire/);
  });

  it('relève le passeur posé au lieu de l’écraser, puis écrit la carte suivante', async () => {
    const h = await atelier();
    await h.el['relever']!.fire('click');
    await h.present(reading(OTHER_URL, PASSEUR)); // une histoire quelconque, pour armer l'écriture
    h.posts.length = 0;

    await h.el['changer']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));
    assert.equal(h.writes.length, 0, 'le passeur ne doit jamais être écrit');
    assert.deepEqual(h.posts[0], { url: '/cartes/releve', body: { url: CARD_URL, uid: PASSEUR } });

    await h.present(blankReading(BLANK));
    assert.deepEqual(h.writes, [CARD_URL]);
  });

  it('demande de reposer une carte qui porte autre chose avant de l’écraser', async () => {
    const h = await jack();
    const foreign = reading('https://example.com/menu', BLANK);
    await h.el['changer']!.fire('click');
    await h.present(foreign);
    assert.equal(h.writes.length, 0);
    assert.match(h.el['journal']!.innerHTML, /porte autre chose qu’une histoire Yoto/);

    await h.el['changer']!.fire('click');
    await h.present(foreign);
    assert.deepEqual(h.writes, [CARD_URL]);
  });

  it('tente l’écriture sur une puce illisible, et rappelle le formatage si elle échoue', async () => {
    const h = await jack();
    h.writeError = nfcError('NetworkError', 'Failed to write due to an IO error');
    await h.el['changer']!.fire('click');
    await h.present('illisible');

    assert.match(h.el['journal']!.innerHTML, /Formate d’abord ta carte/);
  });

  it('ne parle pas de formatage quand une carte lue échoue à l’écriture', async () => {
    const h = await jack();
    h.writeError = nfcError('NetworkError', 'Failed to write due to an IO error');
    await h.el['changer']!.fire('click');
    await h.present(reading(OTHER_URL, BLANK));

    assert.doesNotMatch(h.el['journal']!.innerHTML, /Formate d’abord ta carte/);
    assert.match(h.el['journal']!.innerHTML, /NetworkError/);
  });

  it('envoie le projet ouvert au relevé, et ne prévient plus quand le serveur l’y a rattaché', async () => {
    const h = await atelier({ dataset: { projet: '1' } });
    await h.el['relever']!.fire('click');
    await h.present(reading(CARD_URL, PASSEUR));

    assert.deepEqual(h.posts[0]!.body, { url: CARD_URL, uid: PASSEUR, projet: '1' });
    assert.doesNotMatch(h.el['journal']!.innerHTML, /pas l’histoire du projet ouvert/);
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
    assert.equal(h.el['relever']!.disabled, true);
    assert.equal(h.el['ecrire']!.disabled, true);
  });
});
