/** Tests de la logique de decoupage : analyse, choix des frontieres, bornage. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contentRange,
  parseSilences,
  proposeBoundaries,
  segmentsFrom,
  suggestThresholdMs,
  type Silence,
} from './segment.ts';

/** Fabrique un silence a partir de bornes en secondes. */
const silence = (startS: number, endS: number): Silence => ({
  startMs: startS * 1000,
  endMs: endS * 1000,
  durationMs: (endS - startS) * 1000,
  midpointMs: ((startS + endS) / 2) * 1000,
});

describe('analyse de silencedetect', () => {
  it('apparie start et end, et calcule le milieu', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 12.5',
      '[silencedetect @ 0x1] silence_end: 15.5 | silence_duration: 3',
      '[silencedetect @ 0x1] silence_start: 60',
      '[silencedetect @ 0x1] silence_end: 61.2 | silence_duration: 1.2',
    ].join('\n');

    const found = parseSilences(stderr);

    assert.equal(found.length, 2);
    assert.deepEqual(found[0], {
      startMs: 12_500,
      endMs: 15_500,
      durationMs: 3000,
      midpointMs: 14_000,
    });
    assert.equal(found[1]!.durationMs, 1200);
  });

  it('ferme un silence laisse ouvert en fin de fichier', () => {
    // ffmpeg n'emet pas de silence_end quand le fichier se termine dans le silence.
    const found = parseSilences('silence_start: 600', 624_000);

    assert.equal(found.length, 1);
    assert.equal(found[0]!.endMs, 624_000);
    assert.equal(found[0]!.durationMs, 24_000);
  });

  it('ignore un silence ouvert quand la duree totale est inconnue', () => {
    assert.deepEqual(parseSilences('silence_start: 600'), []);
  });
});

describe('zone utile', () => {
  it('rogne les silences de debut et de fin', () => {
    const range = contentRange([silence(0, 3), silence(120, 124), silence(295, 300)], 300_000);

    assert.equal(range.startMs, 3000, 'le blanc initial est rogne');
    assert.equal(range.endMs, 295_000, 'la traine finale est rognee');
  });

  it('laisse tout le fichier quand il commence et finit dans le son', () => {
    assert.deepEqual(contentRange([silence(120, 124)], 300_000), {
      startMs: 0,
      endMs: 300_000,
    });
  });
});

describe('choix des frontieres', () => {
  it("ne coupe jamais sur la traine de fin", () => {
    // Cas reel : un conte de 10 min suivi de 16 s de silence. La detection proposait cette
    // traine comme frontiere, produisant une derniere piste entierement vide.
    const totalMs = 624_000;
    const silences = [silence(608, 624), silence(300, 300.5)];

    const points = proposeBoundaries(silences, totalMs);

    assert.deepEqual(points, [], 'un enregistrement continu ne doit produire aucune coupure');
  });

  it('retient les n-1 silences les plus longs quand le nombre de pistes est connu', () => {
    const silences = [
      silence(100, 104), // 4 s
      silence(200, 200.8), // 0,8 s — respiration
      silence(300, 306), // 6 s
      silence(400, 401), // 1 s
    ];

    const points = proposeBoundaries(silences, 600_000, { targetCount: 3 });

    assert.deepEqual(points, [102_000, 303_000], 'les deux plus longs, dans l’ordre du temps');
  });

  it('fusionne des coupures trop rapprochees pour former une piste', () => {
    const silences = [silence(100, 103), silence(101.5, 104.5), silence(300, 303)];

    const points = proposeBoundaries(silences, 600_000, { minSilenceMs: 2000 });

    assert.equal(points.length, 2, 'les deux premieres ne peuvent pas encadrer une piste');
    assert.ok(points[1]! - points[0]! >= 5000);
  });

  it('ecarte les coupures trop proches des extremites', () => {
    const points = proposeBoundaries([silence(1, 4)], 600_000, { minSilenceMs: 2000 });
    assert.deepEqual(points, [], 'une premiere piste de 2,5 s n’a pas de sens');
  });
});

describe('seuil suggere', () => {
  it('trouve le decrochage entre vraies coupures et respirations', () => {
    // Deux familles nettes : 4-6 s (coupures) et 0,8-1 s (respirations).
    const silences = [
      silence(0, 6),
      silence(10, 15),
      silence(20, 24),
      silence(30, 31),
      silence(40, 40.9),
      silence(50, 50.8),
    ];

    const threshold = suggestThresholdMs(silences);

    assert.ok(threshold > 1000, `seuil ${threshold} doit exclure les respirations`);
    assert.ok(threshold <= 4000, `seuil ${threshold} doit garder les coupures de 4 s`);
  });

  it('retombe sur la valeur par defaut sans decrochage franc', () => {
    const uniform = [silence(0, 2), silence(10, 12.1), silence(20, 12.2)];
    assert.equal(suggestThresholdMs(uniform), 2000);
  });
});

describe('decoupe en intervalles', () => {
  it('couvre tout le fichier sans trou ni recouvrement', () => {
    const segments = segmentsFrom([100_000, 200_000], 300_000);

    assert.deepEqual(segments, [
      { startMs: 0, endMs: 100_000 },
      { startMs: 100_000, endMs: 200_000 },
      { startMs: 200_000, endMs: 300_000 },
    ]);
  });

  it('se limite a la zone utile quand elle est fournie', () => {
    const segments = segmentsFrom([100_000], 300_000, { startMs: 3000, endMs: 295_000 });

    assert.equal(segments[0]!.startMs, 3000, 'le blanc initial est exclu');
    assert.equal(segments.at(-1)!.endMs, 295_000, 'la traine finale est exclue');
  });

  it('ignore les points de coupe hors de la zone utile', () => {
    const segments = segmentsFrom([1000, 100_000, 299_000], 300_000, {
      startMs: 3000,
      endMs: 295_000,
    });
    assert.equal(segments.length, 2);
  });
});
