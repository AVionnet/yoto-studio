/**
 * Du SVG dicte par un modele aux pixels.
 *
 * DeepSeek ne sait pas produire d'image : il n'a que du texte. En revanche il decrit tres
 * correctement un dessin en formes vectorielles — c'est la qu'on rasterise.
 *
 * Ce SVG vient d'un modele, donc d'une source qu'on ne controle pas : il est filtre avant
 * d'atteindre le moteur de rendu. La menace n'est pas le script (librsvg n'en execute pas) mais
 * la reference externe — un `<image href="http://…">` ferait emettre une requete au serveur, vers
 * une adresse choisie par le modele. La liste blanche ci-dessous ne laisse passer que des formes.
 */
import sharp from 'sharp';

/** Elements de dessin, et rien d'autre : ni image, ni use, ni texte, ni objet etranger. */
const ALLOWED_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
]);

/** Elements dont le contenu doit disparaitre avec eux, pas seulement la balise. */
const DROP_WITH_CONTENT = ['script', 'style', 'foreignObject', 'text', 'textPath', 'tspan', 'a'];

const ALLOWED_ATTRS = new Set([
  'viewBox',
  'width',
  'height',
  'xmlns',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'clip-path',
  'id',
]);

/**
 * Une valeur d'attribut sure : pas de reference externe. `url(#…)` reste admis, c'est ainsi
 * qu'un degrade ou un masque local se designe.
 */
const isSafeValue = (value: string): boolean => {
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:') || lower.includes('&#')) return false;
  if (!lower.includes('url(')) return true;
  return /^[^u]*url\(\s*#[\w-]+\s*\)[^u]*$/.test(lower);
};

/** Au-dela, ce n'est plus un dessin : on refuse avant de rasteriser. */
const MAX_SVG_BYTES = 256 * 1024;

export class ArtworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtworkError';
  }
}

/**
 * Ne garde du SVG recu que des formes, et impose le cadre.
 *
 * Le filtrage est textuel plutot qu'arborescent : sans analyseur XML, on ne peut pas garantir
 * une structure valide — mais ce n'est pas le role de cette fonction. Un SVG mal ferme sera
 * rejete par le moteur de rendu juste apres, et la generation sera rejouee.
 */
export function sanitizeSvg(raw: string, viewBox: string): string {
  if (raw.length > MAX_SVG_BYTES) throw new ArtworkError('Le dessin reçu est démesuré.');

  const opening = raw.indexOf('<svg');
  const closing = raw.lastIndexOf('</svg>');
  if (opening === -1 || closing === -1) throw new ArtworkError("La réponse ne contient pas de SVG.");

  let svg = raw.slice(opening, closing + '</svg>'.length);

  // Commentaires, doctype, entites et instructions de traitement : rien de tout cela ne dessine.
  svg = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<[!?][\s\S]*?>/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    svg = svg
      .replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
      .replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }

  svg = svg.replace(/<\/?([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, name: string, attrs: string) => {
    if (!ALLOWED_TAGS.has(name)) return '';
    if (whole.startsWith('</')) return `</${name}>`;

    const kept: string[] = [];
    const pattern = /([A-Za-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    for (let found = pattern.exec(attrs); found; found = pattern.exec(attrs)) {
      const key = found[1]!;
      const value = found[3] ?? found[4] ?? '';
      if (!ALLOWED_ATTRS.has(key) || !isSafeValue(value)) continue;
      kept.push(`${key}="${value.replace(/"/g, '')}"`);
    }

    const selfClosing = whole.endsWith('/>') ? '/' : '';
    return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClosing}>`;
  });

  // Le cadre est impose, pas negocie : le modele se trompe regulierement de viewBox, et un
  // dessin cale sur un autre repere sort du cadre ou flotte au milieu du vide.
  const [, , width, height] = viewBox.split(/\s+/);
  const root = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">`;
  svg = svg.replace(/^<svg[^>]*>/, root);

  if (!/<(path|rect|circle|ellipse|polygon|polyline|line)\b/.test(svg)) {
    throw new ArtworkError("Le dessin reçu ne contient aucune forme.");
  }
  return svg;
}

/** Le cadre d'une couverture : carre, c'est ce qu'attend la bibliotheque Yoto. */
export const COVER_VIEWBOX = '0 0 1024 1024';

/** Celui d'une icone : quatre fois la taille finale, pour dessiner sans compter les pixels. */
export const ICON_VIEWBOX = '0 0 64 64';

export const COVER_SIZE = 1024;
export const ICON_SIZE = 16;

/**
 * La couverture, en PNG carre. Le fond est aplati sur du blanc : un modele oublie parfois de
 * peindre le ciel, et une couverture transparente devient noire dans l'application Yoto.
 */
export async function renderIllustration(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 96 })
    .resize(COVER_SIZE, COVER_SIZE, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/**
 * L'icone, en 16x16 exactement.
 *
 * Deux passes apres la reduction, sans lesquelles le resultat est une bouillie de demi-teintes :
 * l'alpha est ramene a tout ou rien — un pixel a moitie transparent n'existe pas en pixel art —
 * puis la palette est reduite a huit couleurs sans tramage, ce qui reforme des aplats nets.
 */
export async function renderIcon(svg: string): Promise<Buffer> {
  const reduced = await sharp(Buffer.from(svg), { density: 600 })
    .resize(ICON_SIZE, ICON_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer();

  for (let index = 3; index < reduced.length; index += 4) {
    reduced[index] = reduced[index]! > 110 ? 255 : 0;
  }

  return sharp(reduced, { raw: { width: ICON_SIZE, height: ICON_SIZE, channels: 4 } })
    .png({ palette: true, colours: 8, dither: 0 })
    .toBuffer();
}
