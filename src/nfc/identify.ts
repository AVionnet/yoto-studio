/**
 * Mettre un nom sur une carte relevee : quelle histoire joue-t-elle, et qu'est-ce qui cloche.
 *
 * Un cardId seul (`AbC12`) ne dit rien a la personne qui tient la carte. Ce qui l'aide, c'est le
 * titre de l'histoire, et quand quelque chose ne va pas, une phrase qui dit quoi faire — pas un
 * code. Ce module rassemble ce que l'on sait de la carte (bibliotheque Yoto, projets, pool,
 * registre des puces) et en tire ces phrases. Il ne fait aucun appel lui-meme : la route lui
 * passe les faits, ce qui le rend testable.
 */

/** Ce que la bibliotheque Yoto a repondu pour ce cardId. */
export type LibraryState = 'ok' | 'introuvable' | 'non-connecte' | 'injoignable';

export interface CardFacts {
  cardId: string;
  /** L'URL relevee sur la puce, jeton compris. */
  url: string;
  library: LibraryState;
  /** Message brut quand la bibliotheque n'a pas repondu. */
  libraryError?: string | undefined;
  remote?: { title: string; chapters: string[] } | undefined;
  project?: { id: number; title: string } | undefined;
  pool?: { nickname: string; ndefUrl: string | null } | undefined;
  /** Ce que le registre dit de cette puce precise, si son uid est connu. */
  chip?: { cardId: string; writtenAt: string; title?: string | undefined } | undefined;
}

export interface Note {
  kind: 'ok' | 'warn' | 'error';
  text: string;
  /** Comment corriger, quand il y a quelque chose a faire. */
  fix?: string;
}

export interface Identity {
  cardId: string;
  /** Le meilleur nom disponible : bibliotheque Yoto, puis projet, puis surnom du pool. */
  title: string | null;
  chapters: string[];
  library: LibraryState;
  project: { id: number; title: string } | null;
  nickname: string | null;
  chip: CardFacts['chip'] | null;
  notes: Note[];
}

const LINK_STEPS =
  "Dans l'app Yoto : Bibliothèque → ouvre l'histoire → « Link to a card » (Lier à une carte), " +
  'approche le passeur du téléphone quand l’app le demande, attends la confirmation, puis ' +
  'relève-le de nouveau ici.';

export function identify(facts: CardFacts): Identity {
  const notes: Note[] = [];
  const title = facts.remote?.title ?? facts.project?.title ?? facts.pool?.nickname ?? null;

  switch (facts.library) {
    case 'introuvable':
      notes.push({
        kind: 'error',
        text:
          `Le contenu ${facts.cardId} n'existe pas dans ta bibliothèque Yoto` +
          (title ? ` (on le connaissait sous le nom « ${title} » : il a peut-être été supprimé).` : '.'),
        fix:
          'Si c’est ton passeur, il n’est pas relié à une de tes histoires — ou le lien ne lui a ' +
          `pas été écrit. ${LINK_STEPS} Si c’est une carte officielle Yoto du commerce, elle ` +
          'joue un contenu du catalogue : elle se recopie, mais ne se republie pas ici.',
      });
      break;
    case 'non-connecte':
      notes.push({
        kind: 'warn',
        text: 'Impossible de vérifier le contenu chez Yoto : Yoto Studio n’est plus connecté à ton compte.',
        fix: 'Reconnecte-toi depuis Réglages → Compte Yoto, puis relis la carte.',
      });
      break;
    case 'injoignable':
      notes.push({
        kind: 'warn',
        text:
          'Yoto n’a pas répondu, le titre n’a pas pu être vérifié' +
          (facts.libraryError ? ` (${facts.libraryError}).` : '.'),
        fix: 'Réessaie dans un instant ; la carte elle-même n’est pas en cause.',
      });
      break;
    case 'ok':
      if (facts.remote && facts.remote.chapters.length === 0) {
        notes.push({
          kind: 'warn',
          text: `« ${facts.remote.title} » existe chez Yoto, mais ne contient aucune piste.`,
          fix: 'Publie le projet avant d’encoder : la carte jouerait du silence.',
        });
      }
      break;
  }

  // Le passeur relie de nouveau a la meme histoire porte un jeton neuf. Les deux adresses ne sont
  // pas fausses, mais une carte qui ne joue plus se repare en la reencodant avec la derniere.
  if (facts.pool?.ndefUrl && facts.pool.ndefUrl !== facts.url) {
    notes.push({
      kind: 'warn',
      text: 'Ce n’est pas la même adresse que celle déjà enregistrée pour cette histoire (jeton différent).',
      fix:
        'Normal si le passeur a été relié de nouveau. Si une carte encodée avant ne joue plus, ' +
        'réencode-la avec cette adresse-ci.',
    });
  }

  if (facts.chip && facts.chip.cardId !== facts.cardId) {
    const was = facts.chip.title ? `« ${facts.chip.title} » (${facts.chip.cardId})` : facts.chip.cardId;
    notes.push({
      kind: 'warn',
      text: `Nos registres disent que cette puce portait ${was}, encodée le ${facts.chip.writtenAt}.`,
      fix:
        'Elle a été réécrite ailleurs (app Yoto, NFC Tools…) ou c’est la carte passeur. Si elle ' +
        'doit jouer l’autre histoire, réencode-la depuis « Encoder une carte vierge ».',
    });
  }

  return {
    cardId: facts.cardId,
    title,
    chapters: facts.remote?.chapters ?? [],
    library: facts.library,
    project: facts.project ?? null,
    nickname: facts.pool?.nickname ?? null,
    chip: facts.chip ?? null,
    notes,
  };
}
