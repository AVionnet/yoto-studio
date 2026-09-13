/** Tests des etiquettes : geometrie de la planche, et ce que la Cricut lira du PNG. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sharp from 'sharp';

import {
  DPI,
  GAP_MM,
  LABEL_MM,
  PRINT_MAX_MM,
  px,
  renderLabel,
  renderSheet,
  SHEET_CAPACITY,
  sheetCount,
  sheetLayout,
} from './label.ts';

/** Une couverture carree, avec un reperage clair en haut a gauche. */
async function fakeCover(size = 600): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 210, g: 90, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

const mm = (pixels: number): number => (pixels / DPI) * 25.4;

describe('conversion en pixels', () => {
  it('compte 300 pixels par pouce', () => {
    assert.equal(px(25.4), 300);
    assert.equal(px(LABEL_MM.width), 976);
    assert.equal(px(LABEL_MM.height), 602);
  });
});

describe('planche', () => {
  it('tient dans ce que « Imprimer puis découper » accepte', () => {
    const full = sheetLayout(SHEET_CAPACITY);

    assert.ok(mm(full.width) <= PRINT_MAX_MM.width, `${mm(full.width)} mm de large`);
    assert.ok(mm(full.height) <= PRINT_MAX_MM.height, `${mm(full.height)} mm de haut`);
  });

  it('remplit ligne par ligne, sans marge perdue', () => {
    const layout = sheetLayout(3);
    const step = px(LABEL_MM.width) + px(GAP_MM);

    assert.equal(layout.columns, 2);
    assert.equal(layout.rows, 2);
    assert.deepEqual(layout.slots[0], { x: 0, y: 0 });
    assert.equal(layout.slots[1]!.x, step);
    assert.equal(layout.slots[2]!.y, px(LABEL_MM.height) + px(GAP_MM));
    // Deux colonnes larges, deux rangees hautes : le cadre colle aux etiquettes.
    assert.equal(layout.width, 2 * px(LABEL_MM.width) + px(GAP_MM));
  });

  it('laisse un ecart entre deux etiquettes, pour que la lame ne morde pas la voisine', () => {
    const layout = sheetLayout(2);
    assert.equal(layout.slots[1]!.x - px(LABEL_MM.width), px(GAP_MM));
  });

  it('ne deborde jamais de la feuille, meme si on en demande trop', () => {
    assert.equal(sheetLayout(99).slots.length, SHEET_CAPACITY);
    assert.equal(sheetLayout(0).slots.length, 1);
  });

  it('compte les feuilles necessaires', () => {
    assert.equal(sheetCount(1), 1);
    assert.equal(sheetCount(SHEET_CAPACITY), 1);
    assert.equal(sheetCount(SHEET_CAPACITY + 1), 2);
  });
});

describe('etiquette', () => {
  it('sort aux dimensions de la carte, a 300 ppp', async () => {
    const meta = await sharp(await renderLabel(await fakeCover())).metadata();

    assert.equal(meta.format, 'png');
    assert.equal(meta.width, px(LABEL_MM.width));
    assert.equal(meta.height, px(LABEL_MM.height));
    // Sans cette densite, Design Space importe l'image a une autre echelle.
    assert.equal(meta.density, DPI);
  });

  it('a les coins transparents : c’est le trait de coupe', async () => {
    const label = await renderLabel(await fakeCover());
    const alphaAt = async (left: number, top: number): Promise<number> => {
      const pixel = await sharp(label)
        .extract({ left, top, width: 1, height: 1 })
        .raw()
        .toBuffer();
      return pixel[3]!;
    };

    assert.equal(await alphaAt(0, 0), 0);
    assert.equal(await alphaAt(px(LABEL_MM.width) - 1, px(LABEL_MM.height) - 1), 0);
    assert.equal(await alphaAt(px(LABEL_MM.width) / 2, px(LABEL_MM.height) / 2), 255);
  });

  it('garde la couverture entiere en cadrage « image entière »', async () => {
    // Le dessin tient en hauteur : ses bords gauche et droit tombent sur le fond flou.
    const label = await renderLabel(await fakeCover(), 'contain');
    const meta = await sharp(label).metadata();

    assert.equal(meta.width, px(LABEL_MM.width));
    assert.equal(meta.height, px(LABEL_MM.height));
  });
});

describe('planche rendue', () => {
  it('pose chaque etiquette sur une toile transparente', async () => {
    const label = await renderLabel(await fakeCover());
    const sheet = await renderSheet([label, label, label]);
    const layout = sheetLayout(3);
    const meta = await sharp(sheet).metadata();

    assert.equal(meta.width, layout.width);
    assert.equal(meta.height, layout.height);
    assert.equal(meta.density, DPI);

    // L'espace entre deux colonnes reste vide, sinon la machine decouperait le rectangle entier.
    const gutter = await sharp(sheet)
      .extract({ left: px(LABEL_MM.width) + 2, top: px(LABEL_MM.height) / 2, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.equal(gutter[3], 0);
  });

  it('refuse une planche vide', async () => {
    await assert.rejects(() => renderSheet([]));
  });
});
