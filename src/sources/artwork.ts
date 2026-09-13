/**
 * Faire dessiner DeepSeek.
 *
 * Le modele n'a pas de sortie image : il n'ecrit que du texte. On lui demande donc le dessin
 * sous la seule forme d'image qu'un modele de texte sait produire — du SVG — et c'est le serveur
 * qui rasterise (voir pipeline/artwork).
 *
 * Consequence sur le style : ce sont des aplats decoupes, pas une peinture. Les consignes
 * ci-dessous poussent dans cette direction plutot que de lutter contre elle, parce qu'un modele
 * a qui on demande du realisme rend un tas de cercles.
 */
import {
  ArtworkError,
  COVER_VIEWBOX,
  ICON_VIEWBOX,
  renderIcon,
  renderIllustration,
  sanitizeSvg,
} from '../pipeline/artwork.ts';
import { chatJson, type ChatMessage } from './deepseek.ts';

const COVER_PROMPT = `Tu es illustrateur de livres pour enfants et tu dessines en SVG, comme on
découperait du papier coloré.

FORMAT
- Un seul <svg viewBox="0 0 1024 1024">, sans texte, sans image externe, sans filtre.
- Formes autorisées : path, rect, circle, ellipse, polygon, polyline, line, g.
- Les courbes viennent de <path> avec des commandes C, S et Q. Une illustration faite seulement
  de cercles et de rectangles ressemble à un diagramme, pas à un dessin.

COMPOSITION — la carte est vue en vignette de 3 cm : ce qui compte est la silhouette.
1. Un fond de couleur pleine, puis deux ou trois plans successifs qui se chevauchent et sortent
   du cadre.
2. UN sujet principal, nettement plus grand que tout le reste : il occupe la moitié de la
   hauteur, légèrement décentré, et se détache par le contraste, pas par le détail.
3. Des éléments secondaires plus petits et plus pâles, répétés, qui donnent du rythme.
4. Le sujet a des bords arrondis, des yeux simples, et une ombre portée douce sous lui.

COULEUR
- Six à huit teintes chaudes et franches. Le sujet porte la plus saturée, les fonds sont sourds.
- Pas de noir pur : les contours sombres sont des bruns ou des bleus très foncés.

QUANTITÉ — entre 25 et 60 formes.

Réponds uniquement par un objet json de cette forme : {"svg": "<svg …>…</svg>"}`;

const ICON_PROMPT = `Tu dessines l'icône d'un chapitre, affichée en 16 pixels sur 16 sur l'écran
d'un lecteur audio pour enfant. Tu la dessines en SVG sur une grille de 64 par 64, sachant
qu'elle sera réduite quatre fois : tout détail plus fin que 4 unités disparaîtra.

RÈGLES
- UN seul objet, centré, vu de face ou de profil. Aucun décor, aucun sol, aucun ciel, aucun cadre.
- L'objet occupe au moins 44 des 64 unités dans sa plus grande dimension, et laisse 4 unités de
  marge tout autour.
- Fond entièrement transparent : ne dessine aucun rectangle de fond.
- Trois à cinq couleurs franches, très contrastées entre elles. Un liseré foncé (stroke de 3 à 4
  unités, stroke-linejoin="round") cerne le sujet et le détache de l'écran.
- Grosses formes pleines : path avec des courbes C et Q, circle, ellipse, polygon. Pas de trait
  fin, pas de texte, pas de dégradé, pas de filtre.
- La silhouette prime : un enfant doit nommer l'objet d'un coup d'œil.

Réponds uniquement par un objet json de cette forme : {"svg": "<svg viewBox=\\"0 0 64 64\\">…</svg>"}`;

/**
 * Temperature basse : a 1,3 — le reglage des histoires — le modele produit régulièrement du SVG
 * mal forme, attribut sans valeur ou balise jamais fermee. Le dessin y perd peu, la fiabilite
 * beaucoup.
 */
const TEMPERATURE = 0.8;

/** Deux essais : une syntaxe cassee est un accident isole, pas un refus. */
const ATTEMPTS = 2;

function extractSvg(raw: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ArtworkError("La réponse du modèle n'était pas du JSON exploitable.");
  }
  const svg = (payload as { svg?: unknown }).svg;
  if (typeof svg !== 'string' || !svg.trim()) {
    throw new ArtworkError('La réponse du modèle ne contenait pas de dessin.');
  }
  return svg;
}

/** sharp remonte l'echec de l'analyseur XML de librsvg sous forme d'en-tete corrompu. */
const isRenderFailure = (error: unknown): boolean =>
  error instanceof Error && /corrupt header|XML parse error|unsupported image format/i.test(error.message);

/**
 * Demande, filtre, rasterise — et recommence si le dessin recu ne tient pas debout. Le rendu
 * fait partie de la validation : un SVG mal ferme ne se voit qu'au moment ou on le dessine.
 */
async function draw(
  prompt: string,
  subject: string,
  viewBox: string,
  render: (svg: string) => Promise<Buffer>,
  timeoutMs: number,
): Promise<Buffer> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt },
    { role: 'user', content: subject },
  ];

  let last: Error | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const raw = await chatJson(messages, { temperature: TEMPERATURE, timeoutMs });
      return await render(sanitizeSvg(extractSvg(raw), viewBox));
    } catch (error) {
      // Une panne d'API ne se rejoue pas : elle se reproduira a l'identique, et l'utilisateur
      // attend deja. Seul un dessin bancal merite un second essai.
      if (!(error instanceof ArtworkError) && !isRenderFailure(error)) throw error;
      last = error as Error;
      messages.push({
        role: 'user',
        content:
          'Le dessin précédent était inutilisable (XML invalide ou vide). Recommence, en ' +
          'fermant chaque balise et en donnant une valeur à chaque attribut.',
      });
    }
  }

  throw new ArtworkError(`Le modèle n'a pas produit de dessin exploitable : ${last?.message}`);
}

export interface CoverBrief {
  title: string;
  /** Quelques lignes de l'histoire, quand elle existe : le dessin colle alors au recit. */
  summary?: string | undefined;
  /** Ce que le parent ajoute de sa main. */
  extra?: string | undefined;
}

/** La couverture d'une carte, en PNG 1024x1024. */
export async function drawCover(brief: CoverBrief): Promise<Buffer> {
  const parts = [`Couverture de la carte « ${brief.title} ».`];
  if (brief.summary) parts.push(`L'histoire commence ainsi : ${brief.summary}`);
  if (brief.extra) parts.push(brief.extra);

  return draw(COVER_PROMPT, parts.join('\n\n'), COVER_VIEWBOX, renderIllustration, 120_000);
}

/** L'icone d'une piste, en PNG 16x16. */
export async function drawIcon(subject: string): Promise<Buffer> {
  return draw(ICON_PROMPT, subject, ICON_VIEWBOX, renderIcon, 60_000);
}
