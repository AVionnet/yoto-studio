/**
 * Decoupage d'un enregistrement long en pistes.
 *
 * Regle generale : **on ne fait que couper**. Pas de debruitage, pas d'egalisation, pas de
 * normalisation. La source est la source.
 *
 * La detection de silence propose, l'humain dispose. Les seuils ci-dessous sont des points de
 * depart raisonnables, pas des verites : l'ecran de validation existe parce qu'aucun reglage
 * ne marche sur tous les enregistrements.
 */
import { execa } from 'execa';

/**
 * Sur un repiquage vinyle le bruit de surface est au-dessus de -40 dB : a ce seuil la detection
 * ne trouve presque rien. -30 dB est un bien meilleur point de depart, quitte a remonter
 * beaucoup de candidats — ce sont les plus longs qui comptent, pas leur nombre.
 */
export const DEFAULT_NOISE_DB = -30;
export const DEFAULT_MIN_SILENCE_MS = 500;

/** En deca, c'est une respiration ; au-dela, c'est probablement une vraie coupure. */
export const DEFAULT_BOUNDARY_MS = 2000;

/** Une piste plus courte que ca est presque toujours une fausse detection. */
export const MIN_SEGMENT_MS = 5000;

export interface Silence {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Milieu du silence : c'est la qu'on coupe. */
  midpointMs: number;
}

export interface Segment {
  startMs: number;
  endMs: number;
}

const toMs = (seconds: string): number => Math.round(Number(seconds) * 1000);

/**
 * Analyse la sortie de `silencedetect`. ffmpeg ecrit une ligne par borne :
 *   [silencedetect @ …] silence_start: 12.345
 *   [silencedetect @ …] silence_end: 15.678 | silence_duration: 3.333
 */
export function parseSilences(stderr: string, totalMs?: number): Silence[] {
  const silences: Silence[] = [];
  let pendingStart: number | undefined;

  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start?.[1] !== undefined) {
      pendingStart = toMs(start[1]);
      continue;
    }

    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end?.[1] !== undefined && pendingStart !== undefined) {
      const endMs = toMs(end[1]);
      const startMs = pendingStart;
      pendingStart = undefined;
      if (endMs <= startMs) continue;
      silences.push({
        startMs,
        endMs,
        durationMs: endMs - startMs,
        midpointMs: Math.round((startMs + endMs) / 2),
      });
    }
  }

  // Un silence ouvert en fin de fichier n'a pas de `silence_end` : ffmpeg s'arrete avant.
  if (pendingStart !== undefined && totalMs !== undefined && totalMs > pendingStart) {
    silences.push({
      startMs: pendingStart,
      endMs: totalMs,
      durationMs: totalMs - pendingStart,
      midpointMs: Math.round((pendingStart + totalMs) / 2),
    });
  }

  return silences;
}

export async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await execa('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    path,
  ]);
  return Math.round(Number(stdout.trim()) * 1000);
}

export async function detectSilences(
  path: string,
  { noiseDb = DEFAULT_NOISE_DB, minSilenceMs = DEFAULT_MIN_SILENCE_MS } = {},
): Promise<Silence[]> {
  const totalMs = await probeDurationMs(path);
  const filter = `silencedetect=noise=${noiseDb}dB:d=${minSilenceMs / 1000}`;

  // silencedetect ecrit sur stderr au niveau info : ne surtout pas passer -v error.
  const { stderr } = await execa(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', path, '-af', filter, '-f', 'null', '-'],
    { reject: false },
  );

  return parseSilences(stderr, totalMs);
}

/**
 * Cherche le decrochage dans la distribution des durees.
 *
 * Les vraies coupures se groupent entre 2 et 7 s, les pauses internes entre 0,5 et 2 s. Plutot
 * que d'imposer un seuil, on classe les silences par duree decroissante et on repere le plus
 * grand ecart relatif entre deux voisins : c'est la frontiere naturelle entre les deux familles.
 */
export function suggestThresholdMs(silences: Silence[]): number {
  const durations = silences.map((s) => s.durationMs).sort((a, b) => b - a);
  if (durations.length < 2) return DEFAULT_BOUNDARY_MS;

  let bestGap = 0;
  let threshold = DEFAULT_BOUNDARY_MS;

  for (let i = 0; i < durations.length - 1; i += 1) {
    const upper = durations[i]!;
    const lower = durations[i + 1]!;
    if (lower < 800) break; // en dessous, ce ne sont plus que des respirations
    const gap = upper / Math.max(lower, 1);
    if (gap > bestGap) {
      bestGap = gap;
      threshold = lower + 1; // juste au-dessus du groupe inferieur
    }
  }

  // Un decrochage franc est significatif ; sinon on retombe sur le seuil par defaut.
  return bestGap >= 1.6 ? Math.max(threshold, 800) : DEFAULT_BOUNDARY_MS;
}

/** Tolerance pour considerer qu'un silence touche le debut ou la fin du fichier. */
const EDGE_TOLERANCE_MS = 1500;

/**
 * Zone reellement sonore de l'enregistrement.
 *
 * Un silence qui touche le debut ou la fin n'est pas une coupure, c'est de la matiere a rogner.
 * Observe en conditions reelles : un conte de 10 min se terminait par 16 s de silence, que la
 * detection proposait comme frontiere — produisant une derniere « piste » entierement vide.
 */
export function contentRange(silences: Silence[], totalMs: number): Segment {
  let startMs = 0;
  let endMs = totalMs;

  for (const silence of silences) {
    if (silence.startMs <= EDGE_TOLERANCE_MS && silence.endMs > startMs) startMs = silence.endMs;
    if (silence.endMs >= totalMs - EDGE_TOLERANCE_MS && silence.startMs < endMs) {
      endMs = silence.startMs;
    }
  }

  return endMs > startMs ? { startMs, endMs } : { startMs: 0, endMs: totalMs };
}

/** Un silence de bordure sert a rogner, jamais a couper. */
const isEdgeSilence = (silence: Silence, range: Segment): boolean =>
  silence.midpointMs <= range.startMs || silence.midpointMs >= range.endMs;

export interface BoundaryOptions {
  /** Nombre de pistes attendu : on retient alors les n-1 silences les plus longs. */
  targetCount?: number | undefined;
  /** Sinon, tout silence au moins aussi long devient une coupure. */
  minSilenceMs?: number | undefined;
  /** Une piste plus courte est fusionnee avec la precedente. */
  minSegmentMs?: number | undefined;
}

/** Points de coupe, en millisecondes, tries et dedoublonnes. */
export function proposeBoundaries(
  silences: Silence[],
  totalMs: number,
  options: BoundaryOptions = {},
): number[] {
  const minSegment = options.minSegmentMs ?? MIN_SEGMENT_MS;
  const range = contentRange(silences, totalMs);
  const inner = silences.filter((silence) => !isEdgeSilence(silence, range));

  const chosen =
    options.targetCount && options.targetCount > 1
      ? [...inner].sort((a, b) => b.durationMs - a.durationMs).slice(0, options.targetCount - 1)
      : inner.filter((s) => s.durationMs >= (options.minSilenceMs ?? suggestThresholdMs(inner)));

  const points = chosen
    .map((s) => s.midpointMs)
    .filter((point) => point > range.startMs + minSegment && point < range.endMs - minSegment)
    .sort((a, b) => a - b);

  // Absorbe les coupures trop rapprochees : deux frontieres a 300 ms d'intervalle ne
  // produiraient qu'un fragment.
  const kept: number[] = [];
  let previous = range.startMs;
  for (const point of points) {
    if (point - previous < minSegment) continue;
    kept.push(point);
    previous = point;
  }
  return kept;
}

/**
 * Transforme des points de coupe en intervalles.
 *
 * `range` permet de rogner les silences de bordure : sans lui, la premiere et la derniere piste
 * embarqueraient le blanc de debut et de fin.
 */
export function segmentsFrom(cutPoints: number[], totalMs: number, range?: Segment): Segment[] {
  const from = range?.startMs ?? 0;
  const to = range?.endMs ?? totalMs;
  const inside = cutPoints.filter((point) => point > from && point < to).sort((a, b) => a - b);
  const bounds = [from, ...inside, to];

  const segments: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    segments.push({ startMs: bounds[i]!, endMs: bounds[i + 1]! });
  }
  return segments;
}

export interface CutMetadata {
  title: string;
  album?: string | undefined;
  artist?: string | undefined;
  trackNumber: number;
  trackTotal: number;
}

/**
 * Coupe en **recopie de flux** : aucun ré-encodage, donc aucune perte.
 * Les trames AAC font ~23 ms, ce qui est assez precis pour une coupure dans le silence.
 * `-ss` et `-to` sont places avant `-i` (recherche a l'entree), `-vn` jette toute video.
 */
export async function cutSegment(
  source: string,
  segment: Segment,
  destination: string,
  metadata: CutMetadata,
): Promise<void> {
  const tags = [
    ['title', metadata.title],
    ['track', `${metadata.trackNumber}/${metadata.trackTotal}`],
    ...(metadata.album ? [['album', metadata.album]] : []),
    ...(metadata.artist ? [['artist', metadata.artist]] : []),
  ].flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);

  await execa('ffmpeg', [
    '-hide_banner', '-nostdin', '-y',
    '-ss', (segment.startMs / 1000).toFixed(3),
    '-to', (segment.endMs / 1000).toFixed(3),
    '-i', source,
    '-vn', '-c:a', 'copy',
    ...tags,
    destination,
  ]);
}

/** Seuil au-dela duquel une extremite n'est plus du silence : la coupe a mordu dans le son. */
export const EDGE_SILENCE_DB = -40;
const EDGE_WINDOW_S = 0.6;

export interface EdgeLevels {
  headDb: number | null;
  tailDb: number | null;
  /** Faux si une extremite depasse le seuil : une coupe est probablement tombee en plein mot. */
  clean: boolean;
}

async function meanVolumeDb(args: string[]): Promise<number | null> {
  // volumedetect ecrit au niveau info. Avec -v error la sortie est vide et le controle
  // passerait toujours, en silence.
  const { stderr } = await execa('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    reject: false,
  });
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Mesure 0,6 s en tete et en queue : detecte un mot coupe sans reecouter tout le fichier. */
export async function measureEdges(path: string): Promise<EdgeLevels> {
  const durationMs = await probeDurationMs(path);
  const tailStart = Math.max(0, durationMs / 1000 - EDGE_WINDOW_S);

  const [headDb, tailDb] = await Promise.all([
    meanVolumeDb(['-t', String(EDGE_WINDOW_S), '-i', path, '-af', 'volumedetect', '-f', 'null', '-']),
    meanVolumeDb([
      '-ss', tailStart.toFixed(3),
      '-i', path,
      '-af', 'volumedetect', '-f', 'null', '-',
    ]),
  ]);

  const loud = (value: number | null): boolean => value !== null && value > EDGE_SILENCE_DB;
  return { headDb, tailDb, clean: !loud(headDb) && !loud(tailDb) };
}
