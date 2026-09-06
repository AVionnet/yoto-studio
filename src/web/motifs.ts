/**
 * Motifs 8x8 pour la vignette d'un projet.
 *
 * Tant qu'un projet n'a pas ses vraies icones de pistes, on lui attribue un motif stable,
 * derive de son identifiant : deux visites montrent le meme dessin, et deux projets voisins
 * en montrent deux differents.
 */

/** Codes couleur, resolus en variables CSS du theme. */
const PALETTE: Record<string, string> = {
  '.': 'transparent',
  a: 'var(--sun)',
  A: 'var(--coral)',
  p: 'var(--berry)',
  P: 'var(--coral-ink)',
  b: 'var(--grass)',
  B: 'var(--teal)',
  g: 'var(--sky)',
  n: 'var(--neutral-100)',
  c: 'var(--berry-ink)',
};

const MOTIFS: string[][] = [
  // etoile
  ['...aa...', '...aa...', '.aaaaaa.', 'aaaaaaaa', '..aaaa..', '..aaaa..', '.aa..aa.', '.a....a.'],
  // lune
  ['..nnn...', '.nn.....', 'nn......', 'nn......', 'nn......', 'nn......', '.nn.....', '..nnn...'],
  // feuille
  ['.....bb.', '...bbbb.', '..bbbbb.', '.bbBbbb.', 'bbBbbb..', 'bBbbb...', 'B.bb....', 'B.......'],
  // maison
  ['...AA...', '..AAAA..', '.AAAAAA.', 'AAAAAAAA', '.PPPPPP.', '.PggPPP.', '.PggPPP.', '.PPPPPP.'],
  // note
  ['.....ppp', '.....p.p', '.....ppp', '.....p..', '.....p..', '..ppp.p.', '.ppppp..', '..ppp...'],
  // vague
  ['........', '..BB..BB', '.BBBBBBB', 'BBBBBBB.', 'BB..BB..', '........', '..gg..gg', '.gggggg.'],
  // soleil
  ['..a..a..', '...aa...', '.aAAAAa.', '.AAAAAA.', 'aAAAAAAa', '.AAAAAA.', '..AAAA..', '..a..a..'],
  // chat
  ['.c....c.', 'cc....cc', 'cccccccc', 'cnccccnc', 'cccpcccc', 'cc.cc.cc', '.cccccc.', '..cc.cc.'],
];

/** Hachage stable et court : meme entree, meme motif, sans dependance externe. */
function pick(seed: number | string): string[] {
  const text = String(seed);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return MOTIFS[hash % MOTIFS.length]!;
}

/** Les 64 couleurs de la vignette, dans l'ordre de lecture. */
export function motifCells(seed: number | string): string[] {
  return pick(seed)
    .join('')
    .split('')
    .map((char) => PALETTE[char] ?? 'transparent');
}
