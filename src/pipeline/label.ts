/**
 * Etiquettes a imprimer puis decouper a la Cricut.
 *
 * Une carte Yoto est un CR80 — le format d'une carte bancaire, 85,6 x 54 mm. L'etiquette est
 * volontairement plus petite : le lisere de carte nue qui reste autour pardonne le millimetre
 * que « Imprimer puis decouper » ne garantit pas, et evite l'autocollant qui deborde et
 * accroche dans la fente du lecteur.
 *
 * Le fichier sort en PNG 300 ppp a fond transparent : Design Space suit le bord de la zone
 * opaque, donc le contour arrondi de l'etiquette *est* le trait de coupe. Rien d'autre a
 * dessiner — ni cadre, ni reperes, que la machine pose elle-meme a l'impression.
 */
import sharp from 'sharp';

/** Resolution d'impression. En deca, la trame se voit sur un dessin de 8 cm de large. */
export const DPI = 300;

/** La carte elle-meme, pour memoire : ISO/IEC 7810 CR80. */
export const CARD_MM = { width: 85.6, height: 54 } as const;

/** L'etiquette, 1,5 mm en retrait de chaque bord. Le rayon suit celui de la carte. */
export const LABEL_MM = { width: 82.6, height: 51, radius: 3 } as const;

/**
 * Ce que Design Space accepte en « Imprimer puis decouper » : 6,75 x 9,25 pouces, le reste de
 * la feuille etant mange par les reperes de calage. Une planche plus grande est refusee a
 * l'import, sans moyen de la redecouper ensuite.
 */
export const PRINT_MAX_MM = { width: 171.45, height: 234.95 } as const;

/** Entre deux etiquettes. Assez pour que la lame ne morde pas la voisine, pas plus. */
export const GAP_MM = 4;

/** Millimetres vers pixels, a 300 ppp. */
export const px = (mm: number): number => Math.round((mm / 25.4) * DPI);

const COLUMNS = Math.floor((PRINT_MAX_MM.width + GAP_MM) / (LABEL_MM.width + GAP_MM));
const ROWS = Math.floor((PRINT_MAX_MM.height + GAP_MM) / (LABEL_MM.height + GAP_MM));

/** Nombre d'etiquettes sur une planche. Au-dela, il faut une seconde feuille. */
export const SHEET_CAPACITY = COLUMNS * ROWS;

/**
 * Cadrage du dessin dans l'etiquette, qui n'a pas les memes proportions qu'une couverture :
 * celle-ci est presque toujours carree, l'etiquette est un rectangle allonge.
 *  - `crop`    : on remplit, quitte a perdre le haut et le bas. Rend une carte pleine page.
 *  - `contain` : le dessin entier tient, le vide est comble par le meme dessin, agrandi et flou.
 */
export type Framing = 'crop' | 'contain';

export interface Slot {
  x: number;
  y: number;
}

export interface SheetLayout {
  columns: number;
  rows: number;
  /** Dimensions de la planche en pixels, au plus juste : pas de marge perdue. */
  width: number;
  height: number;
  /** Coin haut-gauche de chaque etiquette, dans l'ordre de lecture. */
  slots: Slot[];
}

/** Grille d'une planche de `count` etiquettes, plafonnee a ce qu'une feuille accepte. */
export function sheetLayout(count: number): SheetLayout {
  const total = Math.min(Math.max(count, 1), SHEET_CAPACITY);
  const columns = Math.min(COLUMNS, total);
  const rows = Math.ceil(total / COLUMNS);

  const labelWidth = px(LABEL_MM.width);
  const labelHeight = px(LABEL_MM.height);
  const gap = px(GAP_MM);

  const slots: Slot[] = [];
  for (let index = 0; index < total; index += 1) {
    slots.push({
      x: (index % COLUMNS) * (labelWidth + gap),
      y: Math.floor(index / COLUMNS) * (labelHeight + gap),
    });
  }

  return {
    columns,
    rows,
    width: columns * labelWidth + (columns - 1) * gap,
    height: rows * labelHeight + (rows - 1) * gap,
    slots,
  };
}

/** Combien de planches pour `count` etiquettes. */
export const sheetCount = (count: number): number => Math.max(1, Math.ceil(count / SHEET_CAPACITY));

/** Le masque aux coins arrondis. Blanc opaque dedans, rien dehors. */
function roundedMask(width: number, height: number): Buffer {
  const radius = px(LABEL_MM.radius);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
}

/**
 * Une etiquette, a partir des octets d'une image de couverture.
 *
 * `rotate()` sans argument n'applique que l'orientation EXIF : une photo prise de travers sur
 * un telephone arrive droite, et rien ne bouge pour les autres.
 */
export async function renderLabel(cover: Buffer, framing: Framing = 'crop'): Promise<Buffer> {
  const width = px(LABEL_MM.width);
  const height = px(LABEL_MM.height);
  const source = sharp(cover, { failOn: 'none' }).rotate();

  const layers: sharp.OverlayOptions[] = [];
  let base: sharp.Sharp;

  if (framing === 'contain') {
    // Le fond est le dessin lui-meme, recadre plein cadre puis noye : la couleur dominante
    // vient de l'image, donc le remplissage ne jure jamais avec elle.
    base = sharp(
      await source
        .clone()
        .resize(width, height, { fit: 'cover' })
        .blur(30)
        .modulate({ brightness: 0.92, saturation: 1.1 })
        .toBuffer(),
    );
    layers.push({
      input: await source.clone().resize(width, height, { fit: 'inside' }).png().toBuffer(),
      gravity: 'centre',
    });
  } else {
    base = source.clone().resize(width, height, { fit: 'cover' });
  }

  layers.push({ input: roundedMask(width, height), blend: 'dest-in' });

  return base
    .ensureAlpha()
    .composite(layers)
    .png()
    .withMetadata({ density: DPI })
    .toBuffer();
}

/**
 * Une planche : jusqu'a `SHEET_CAPACITY` etiquettes deja rendues, posees sur une toile
 * transparente. Le fond reste vide, sinon Design Space decouperait le rectangle de la planche
 * au lieu de chaque etiquette.
 */
export async function renderSheet(labels: Buffer[]): Promise<Buffer> {
  if (labels.length === 0) throw new Error('Une planche vide n’a rien à découper.');

  const layout = sheetLayout(labels.length);

  return sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(
      layout.slots.map((slot, index) => ({
        input: labels[index]!,
        left: slot.x,
        top: slot.y,
      })),
    )
    .png()
    .withMetadata({ density: DPI })
    .toBuffer();
}
