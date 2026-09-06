/**
 * Ecriture d'histoires avec DeepSeek.
 *
 * L'API est compatible avec le format OpenAI. On demande une reponse en JSON strict plutot que
 * du texte libre : decouper des chapitres a l'expression reguliere sur une prose generee est
 * une source d'erreurs sans fin.
 */
import { config } from '../config.ts';

export class StoryError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'StoryError';
    this.hint = hint;
  }
}

export interface Chapter {
  title: string;
  text: string;
}

export interface Story {
  title: string;
  chapters: Chapter[];
}

/** Bornes raisonnables pour une carte : assez pour une histoire du soir, pas plus. */
export const MIN_CHAPTERS = 1;
export const MAX_CHAPTERS = 12;

/**
 * L'histoire doit etre originale : ces cartes sont pour une enfant, et reprendre des
 * personnages ou des textes existants n'aurait ni interet ni legitimite.
 */
const SYSTEM_PROMPT = `Tu écris des histoires pour enfants, en français, destinées à être lues
à voix haute par un parent et enregistrées sur une carte audio.

Règles :
- L'histoire est entièrement originale. N'utilise aucun personnage, univers ou texte existant.
- Langue simple et imagée, phrases courtes, adaptée à l'âge demandé.
- Chaque chapitre se lit à voix haute en une à trois minutes environ.
- Le titre de chapitre est court : il sert d'étiquette de piste, pas de résumé.
- Rien de terrifiant ni de violent. Une fin apaisante.

Réponds uniquement par un objet JSON de cette forme :
{"title": "...", "chapters": [{"title": "...", "text": "..."}]}`;

export interface StoryRequest {
  /** Ce que le parent demande, en langage libre. */
  brief: string;
  chapters: number;
  age: number;
  /** Tours precedents, pour affiner une histoire deja ecrite. */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

function parseStory(raw: string): Story {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new StoryError("La réponse du modèle n'était pas du JSON exploitable.");
  }

  const record = payload as { title?: unknown; chapters?: unknown };
  const chapters = Array.isArray(record.chapters) ? record.chapters : [];

  const cleaned: Chapter[] = chapters
    .map((entry) => entry as { title?: unknown; text?: unknown })
    .filter((entry) => typeof entry.text === 'string' && entry.text.trim())
    .map((entry, index) => ({
      title: typeof entry.title === 'string' && entry.title.trim()
        ? entry.title.trim()
        : `Chapitre ${index + 1}`,
      text: String(entry.text).trim(),
    }));

  if (cleaned.length === 0) throw new StoryError("Le modèle n'a produit aucun chapitre.");

  return {
    title: typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : 'Histoire sans titre',
    chapters: cleaned.slice(0, MAX_CHAPTERS),
  };
}

export const isConfigured = (): boolean => Boolean(config.deepseek.apiKey);

export async function writeStory(input: StoryRequest): Promise<Story> {
  if (!config.deepseek.apiKey) {
    throw new StoryError(
      "Aucune clé DeepSeek n'est configurée.",
      'Renseigne DEEPSEEK_API_KEY dans le fichier .env.',
    );
  }

  const chapters = Math.min(Math.max(input.chapters, MIN_CHAPTERS), MAX_CHAPTERS);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(input.history ?? []),
    {
      role: 'user',
      content:
        `Écris une histoire en ${chapters} chapitre${chapters > 1 ? 's' : ''} ` +
        `pour un enfant de ${input.age} ans.\n\n${input.brief}`,
    },
  ];

  let response: Response;
  try {
    response = await fetch(config.deepseek.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 1.3, // registre créatif, recommandé par DeepSeek pour la fiction
      }),
      // Une histoire de dix chapitres prend un moment à écrire.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (cause) {
    throw new StoryError(`DeepSeek injoignable : ${(cause as Error).message}`);
  }

  const body = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (!response.ok) {
    const detail = body.error?.message ?? `HTTP ${response.status}`;
    throw new StoryError(
      `DeepSeek a refusé la demande : ${detail}`,
      response.status === 401 ? 'La clé API est absente ou invalide.' : undefined,
    );
  }

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new StoryError('DeepSeek a répondu sans contenu.');

  return parseStory(content);
}
