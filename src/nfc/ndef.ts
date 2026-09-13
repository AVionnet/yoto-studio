/**
 * Ce qu'une carte Yoto porte reellement : un unique enregistrement NDEF de type URI,
 * `https://yoto.io/<cardId>?<token>`, loge dans les 48 octets d'un MIFARE Ultralight EV1.
 *
 * Le token est frappe par le serveur et lie au `cardId`, jamais a la puce. Recopier cette URL
 * sur une carte vierge du meme type donne donc une carte qui joue le meme contenu — c'est tout
 * le mecanisme de l'encodage, et c'est aussi sa limite : aucune URL ne se fabrique hors-ligne.
 */

/**
 * MF0UL11 : pages 4 a 15, soit 48 octets utiles. C'est la puce que Yoto emploie, et la variante
 * a acheter — les 128 octets du MF0UL21 se formatent differemment.
 */
export const TAG_CAPACITY = 48;

/**
 * Repli quand le telephone refuse de formater lui-meme une puce sortie d'usine : les deux
 * ecritures brutes qui en font un tag NDEF vide. `A2 <page> <4 octets>`.
 *   page 3 — capability container : NDEF, v1.0, 6 x 8 = 48 octets, lecture/ecriture
 *   page 4 — un message NDEF vide (`03 00`) suivi du terminateur (`FE`)
 */
export const FORMAT_COMMANDS = ['A2 03 E1 10 06 00', 'A2 04 03 00 FE 00'] as const;

/** Codes de prefixe URI de la norme NDEF, du plus long au plus court : le plus long gagne. */
const PREFIXES: readonly [number, string][] = [
  [0x02, 'https://www.'],
  [0x01, 'http://www.'],
  [0x04, 'https://'],
  [0x03, 'http://'],
];

export interface TagIdentity {
  /** Identifiant de contenu attribue par Yoto, 5 caracteres a ce jour. */
  cardId: string;
  /** Jeton d'acces frappe par le serveur. Un secret : il ne se journalise pas. */
  token: string;
}

/** Un cardId reste volontairement large : Yoto en tient 5, rien ne garantit que ca durera. */
const CARD_ID = /^[A-Za-z0-9]{3,20}$/;

/**
 * Lit l'URL relevee sur un tag. Rend `undefined` des que ce n'est pas une carte Yoto :
 * une puce vierge, une carte d'un autre systeme, une URL tronquee.
 */
export function parseYotoUrl(raw: string): TagIdentity | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!/^(.+\.)?yoto\.io$/i.test(url.hostname)) return undefined;

  const cardId = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!CARD_ID.test(cardId)) return undefined;

  // Le token est la query brute, pas un couple cle=valeur : `?abc123`, sans nom de parametre.
  return { cardId, token: url.search.replace(/^\?/, '') };
}

export const buildYotoUrl = ({ cardId, token }: TagIdentity): string =>
  `https://yoto.io/${cardId}${token ? `?${token}` : ''}`;

const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/**
 * Le bloc exact qu'un telephone depose sur la puce, terminateur compris. On ne l'ecrit pas
 * nous-memes — Web NFC s'en charge — mais c'est la seule facon de savoir si ca rentre.
 */
export function encodeNdef(url: string): Uint8Array {
  const hit = PREFIXES.find(([, prefix]) => url.toLowerCase().startsWith(prefix));
  const payload = new Uint8Array([
    hit ? hit[0] : 0x00,
    ...new TextEncoder().encode(hit ? url.slice(hit[1].length) : url),
  ]);

  // Enregistrement court tant que la charge tient sur un octet : MB | ME | SR, TNF « well-known »,
  // type « U ». Au-dela, en-tete long — hors sujet sur 48 octets, mais pas une troncature muette.
  const header =
    payload.length < 0x100
      ? [0xd1, 0x01, payload.length, 0x55]
      : [0xc1, 0x01, ...be32(payload.length), 0x55];
  const record = [...header, ...payload];

  const length = record.length < 0xff ? [record.length] : [0xff, ...be32(record.length).slice(2)];
  return new Uint8Array([0x03, ...length, ...record, 0xfe]);
}

/** Octets occupes sur la puce par cette URL. */
export const tagBytes = (url: string): number => encodeNdef(url).length;

/** Vrai si l'URL tient sur une carte de 48 octets. Une vraie URL Yoto laisse peu de marge. */
export const fits = (url: string): boolean => tagBytes(url) <= TAG_CAPACITY;

/** Ce qui reste libre, pour le dire a l'ecran. Negatif quand ca depasse. */
export const freeBytes = (url: string): number => TAG_CAPACITY - tagBytes(url);
