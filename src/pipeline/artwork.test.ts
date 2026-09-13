/**
 * Tests du dessin : ce qu'on laisse passer d'un SVG dicte par un modele, et ce qu'on en tire
 * comme pixels. Aucun appel reseau — le SVG est ecrit a la main, comme le modele le rendrait.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sharp from 'sharp';

import {
  ArtworkError,
  COVER_SIZE,
  COVER_VIEWBOX,
  ICON_SIZE,
  ICON_VIEWBOX,
  renderIcon,
  renderIllustration,
  sanitizeSvg,
} from './artwork.ts';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${inner}</svg>`;

describe('filtrage du SVG reçu', () => {
  it('garde les formes et leurs attributs de dessin', () => {
    const clean = sanitizeSvg(
      wrap('<path d="M10 10 C 20 20, 40 20, 50 10" fill="#c0ffee" stroke-width="4"/>'),
      COVER_VIEWBOX,
    );

    assert.match(clean, /<path /);
    assert.match(clean, /d="M10 10 C 20 20, 40 20, 50 10"/);
    assert.match(clean, /fill="#c0ffee"/);
    assert.match(clean, /stroke-width="4"/);
  });

  it("refuse la reference externe, qui ferait sortir une requete du serveur", () => {
    const clean = sanitizeSvg(
      wrap('<image href="http://exemple.invalid/pixel.png" x="0" y="0"/><rect width="9" height="9"/>'),
      COVER_VIEWBOX,
    );

    assert.doesNotMatch(clean, /image|href|exemple\.invalid/);
    assert.match(clean, /<rect /);
  });

  it('jette le script et le style, contenu compris', () => {
    const clean = sanitizeSvg(
      wrap('<script>fetch("http://exemple.invalid")</script><style>*{fill:url(http://x)}</style><circle r="5"/>'),
      COVER_VIEWBOX,
    );

    assert.doesNotMatch(clean, /script|style|exemple\.invalid/);
    assert.match(clean, /<circle r="5"\/>/);
  });

  it('retire les gestionnaires d’événements sans perdre la forme', () => {
    const clean = sanitizeSvg(wrap('<rect width="9" height="9" onload="alert(1)"/>'), COVER_VIEWBOX);

    assert.doesNotMatch(clean, /onload/);
    assert.match(clean, /<rect width="9" height="9"\/>/);
  });

  it('laisse passer url(#…), qui désigne un dégradé local', () => {
    const clean = sanitizeSvg(
      wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
        '<rect width="9" height="9" fill="url(#g)"/>'),
      COVER_VIEWBOX,
    );

    assert.match(clean, /fill="url\(#g\)"/);
    assert.match(clean, /<linearGradient id="g">/);
  });

  it('impose le cadre, quel que soit celui que le modèle a choisi', () => {
    const clean = sanitizeSvg(
      '<svg viewBox="0 0 200 100" width="200"><rect width="9" height="9"/></svg>',
      ICON_VIEWBOX,
    );

    assert.match(clean, /viewBox="0 0 64 64"/);
    assert.match(clean, /width="64" height="64"/);
    assert.doesNotMatch(clean, /viewBox="0 0 200 100"/);
  });

  it('ignore ce que le modèle écrit autour du SVG', () => {
    const clean = sanitizeSvg(`Voici le dessin :\n${wrap('<circle r="5"/>')}\nVoilà.`, COVER_VIEWBOX);

    assert.ok(clean.startsWith('<svg '));
    assert.ok(clean.endsWith('</svg>'));
  });

  it('refuse ce qui ne dessine rien', () => {
    assert.throws(() => sanitizeSvg('désolé, je ne peux pas', COVER_VIEWBOX), ArtworkError);
    assert.throws(() => sanitizeSvg(wrap('<defs></defs>'), COVER_VIEWBOX), ArtworkError);
  });
});

describe('rendu de la couverture', () => {
  it('sort un carré opaque, aux dimensions attendues', async () => {
    const png = await renderIllustration(wrap('<rect width="1024" height="1024" fill="#3366cc"/>'));
    const meta = await sharp(png).metadata();

    assert.equal(meta.width, COVER_SIZE);
    assert.equal(meta.height, COVER_SIZE);
    // Une couverture transparente vire au noir dans l'application Yoto : le fond est aplati.
    assert.equal(meta.hasAlpha, false);
  });
});

describe('rendu de l’icône', () => {
  const disc =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<circle cx="32" cy="32" r="26" fill="#e05a2b" stroke="#5a2a12" stroke-width="4"/></svg>`;

  it('sort exactement 16 pixels sur 16', async () => {
    const meta = await sharp(await renderIcon(disc)).metadata();

    assert.equal(meta.width, ICON_SIZE);
    assert.equal(meta.height, ICON_SIZE);
  });

  it('ne garde que des pixels pleins ou vides : le demi-transparent n’existe pas en pixel art', async () => {
    const raw = await sharp(await renderIcon(disc)).ensureAlpha().raw().toBuffer();

    const alphas = new Set<number>();
    for (let index = 3; index < raw.length; index += 4) alphas.add(raw[index]!);

    assert.deepEqual([...alphas].sort(), [0, 255]);
  });

  it('laisse les coins vides et remplit le centre', async () => {
    const raw = await sharp(await renderIcon(disc)).ensureAlpha().raw().toBuffer();
    const alphaAt = (x: number, y: number): number => raw[(y * ICON_SIZE + x) * 4 + 3]!;

    assert.equal(alphaAt(0, 0), 0);
    assert.equal(alphaAt(ICON_SIZE - 1, ICON_SIZE - 1), 0);
    assert.equal(alphaAt(8, 8), 255);
  });
});
