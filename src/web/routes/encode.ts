/**
 * Encoder une carte vierge : recopier sur une puce du commerce l'URL d'un contenu Yoto.
 *
 * Une carte Yoto n'est rien d'autre qu'un MIFARE Ultralight EV1 de 48 octets portant
 * `https://yoto.io/<cardId>?<token>`. Les puces vierges vendues par lots sont la meme puce — il
 * ne manque que l'URL.
 *
 * Cette URL ne se fabrique pas : le token est frappe par le serveur Yoto, et seule l'app Yoto
 * l'ecrit, sur une carte MYO officielle — le passeur. Lier une histoire au passeur dans l'app y
 * ecrit son URL ; on la releve une fois, on la garde, et chaque vierge posee ensuite la recoit.
 *
 * Le passeur est enregistre une seule fois, par son uid : l'atelier reconnait ainsi seul ce qu'on
 * pose sur le telephone — le passeur (on releve), une vierge (on ecrit), une copie deja prete.
 *
 * La limite, constatee : Yoto ne connait pas l'uid d'une copie. Le serveur la refuse, et l'app du
 * telephone affiche « Echec de lecture ». Elle ne joue que sur un lecteur qui a deja telecharge
 * l'histoire, en la reconnaissant a son adresse.
 */
import type { FastifyInstance } from 'fastify';

import {
  findByCardId,
  findTag,
  forgetPasseur,
  getPasseur,
  listPool,
  recordTag,
  saveAddress,
  setPasseur,
  tagsFor,
} from '../../db/cards.ts';
import { findProjectByCard, getProject } from '../../db/projects.ts';
import { type CardFacts, type Identity, identify } from '../../nfc/identify.ts';
import { FORMAT_COMMANDS, TAG_CAPACITY, fits, parseYotoUrl, tagBytes } from '../../nfc/ndef.ts';
import { getCard, listMyCards } from '../../yoto/api.ts';
import { AuthRequiredError, YotoError } from '../../yoto/errors.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout } from '../html.ts';
import { requireAuth } from './auth.ts';

/** Un surnom par defaut plutot qu'un champ vide : la carte vient toujours de quelque part. */
const nicknameFor = (title: string | null | undefined, cardId: string): string =>
  (title ?? `carte ${cardId}`).slice(0, 60);

/** Ce qu'il faut pour qu'une copie joue — a dire avant le premier echec, pas apres. */
const playbackRule = html`
  <section class="panel">
    <h2>Pour qu'une copie joue</h2>
    <ol class="steps">
      <li>Mets le <strong>passeur</strong> dans le lecteur Yoto, en wifi, et laisse l'histoire se
        télécharger en entier : plus d'icône nuage, elle joue wifi coupé.</li>
      <li>La copie joue ensuite <strong>sur ce lecteur</strong>, autant de fois qu'on veut.</li>
    </ol>
    <p class="muted">
      Une copie ne marche pas dans l'app Yoto du téléphone : Yoto ne connaît pas sa puce et la
      refuse (« Échec de lecture »). À refaire sur chaque lecteur, et après chaque republication
      de l'histoire.
    </p>
  </section>
`;

/** Ce qu'on fait quand ca bloque : un symptome, une correction. */
function troubleshooting() {
  const rows: [string, string][] = [
    [
      'Rien ne se passe quand je pose la carte',
      "Le NFC est-il activé (Réglages Android → Appareils connectés → NFC) ? Fais glisser la carte " +
        "lentement sur tout le dos du téléphone : la zone NFC est souvent au centre ou près de " +
        "l'appareil photo. Une coque épaisse ou métallique bloque le signal.",
    ],
    [
      "L'app Yoto ou une page yoto.io s'ouvre au lieu de cette page",
      "La lecture n'était pas lancée : appuie d'abord sur « Commencer », puis pose la carte. " +
        'Garde la page au premier plan, écran allumé.',
    ],
    [
      'Le passeur relevé n’est pas la bonne histoire',
      "Dans l'app Yoto, relie la bonne histoire au passeur, attends la confirmation, puis repose-le " +
        'ici.',
    ],
    [
      '« Échec de lecture » dans l’app Yoto du téléphone',
      'Normal pour une copie : seul un lecteur qui a déjà téléchargé l’histoire la joue. Voir ' +
        '« Pour qu’une copie joue ».',
    ],
    [
      'Le lecteur affiche un panneau rouge avec la copie',
      'Il n’a pas encore l’histoire en entier. Joue-la avec le passeur jusqu’à ce qu’elle marche ' +
        'wifi coupé, puis remets la copie.',
    ],
  ];
  return html`
    <section class="panel">
      <h2>Si ça bloque</h2>
      <dl class="faq">
        ${rows.map(([symptom, fix]) => html`<dt>${symptom}</dt><dd>${fix}</dd>`)}
      </dl>
      <h3>Le téléphone refuse d'écrire sur la vierge</h3>
      <p class="muted">
        Certaines puces sortent d'usine sans en-tête NDEF, et Android ne sait pas toujours la
        formater seul. Avec l'application <em>NFC Tools</em> (Autre → Commandes NFC avancées),
        envoie ces deux commandes une fois sur la carte vierge, puis reviens ici :
      </p>
      <pre>${FORMAT_COMMANDS.join('\n')}</pre>
      <p class="muted">
        La première déclare un tag NDEF de ${TAG_CAPACITY} octets, la seconde y dépose un message
        vide. Achète bien la variante <strong>48 octets</strong> : celle de 128 octets se formate
        autrement.
      </p>
    </section>
  `;
}

/** Ce qui manque quand Web NFC n'est pas la : le seul cas ou aucun bouton ne peut marcher. */
const unsupportedAlert = html`
  <div id="indispo" class="alert error" style="display:block" hidden>
    Cette page a besoin de Web NFC : <strong>Chrome sur Android</strong>, en HTTPS. Ouvre-la
    depuis le téléphone, pas depuis l'ordinateur ni depuis un navigateur intégré à une autre appli.
  </div>
`;

interface Story {
  cardId: string;
  title: string;
  copies: number;
}

function page(
  passeur: string | undefined,
  stories: Story[],
  target: { cardId: string; title: string; projectId: number } | undefined,
) {
  const back = target ? `/projets/${target.projectId}` : '/reglages';
  return layout(
    { title: 'Encoder une carte', nav: 'settings' },
    html`
      <p><a class="back" href="${back}">← Retour</a></p>
      <h1>Encoder une carte vierge</h1>

      <p class="muted">
        Une copie d'une histoire sur une puce du commerce « NFC Ultralight EV1 48 octets ». L'adresse
        s'obtient avec ta carte MYO officielle, le <strong>passeur</strong>, que l'app Yoto relie à
        l'histoire. <a href="/cartes/verifier">Lire une carte</a> pour vérifier ce qu'une puce porte.
      </p>

      ${unsupportedAlert}

      ${passeur
        ? html`
            <div id="atelier" data-passeur="${passeur}" data-target-card="${target?.cardId ?? ''}"
                 data-projet="${target?.projectId ?? ''}" data-capacity="${TAG_CAPACITY}">
              <section class="panel">
                <label for="histoire">Histoire à copier</label>
                <select id="histoire">
                  <option value="">Celle que porte le passeur — à relever</option>
                  ${stories.map(
                    (story) => html`<option value="${story.cardId}"
                      ${story.cardId === target?.cardId ? 'selected' : ''}>
                      ${story.title}${story.copies ? ` · ${story.copies} copie(s)` : ''}
                    </option>`,
                  )}
                </select>

                <p class="consigne" id="consigne">Appuie sur « Commencer ».</p>
                <button id="demarrer" type="button">Commencer</button>
                <div id="journal" aria-live="polite"></div>
              </section>

              <div class="muted passeur-ligne">
                Passeur enregistré : <code>${passeur}</code> ·
                <form class="inline-link" method="post" action="/cartes/passeur/oublier">
                  <input type="hidden" name="retour" value="/cartes/encoder">
                  <button class="link" type="submit">changer de passeur</button>
                </form>
              </div>
            </div>
          `
        : html`
            <section class="panel" id="enregistrement">
              <h2>Enregistrer ton passeur — une seule fois</h2>
              <p>
                Le passeur est ta carte MYO officielle. L'app Yoto lui écrit l'adresse de
                l'histoire qu'on lui relie ; l'appli la recopie ensuite sur les vierges.
                Enregistré une fois, il est reconnu tout seul.
              </p>
              <button id="enregistrer" type="button">Enregistrer le passeur</button>
              <p class="status" id="etat"></p>
              <div id="resultat"></div>
            </section>
          `}

      ${playbackRule}
      ${troubleshooting()}

      <script src="/static/nfc.js"></script>
      <script src="/static/encoder.js"></script>
    `,
  );
}

function verifyPage() {
  return layout(
    { title: 'Lire une carte', nav: 'settings' },
    html`
      <p><a class="back" href="/cartes/encoder">← Encoder une carte</a></p>
      <h1>Lire et vérifier une carte</h1>
      <p class="muted">
        Pose n'importe quelle carte — officielle, copie, vierge : on affiche l'histoire dont elle
        porte l'adresse et, si quelque chose cloche, comment le corriger. Rien n'est écrit.
      </p>

      <div id="lecteur" data-capacity="${TAG_CAPACITY}">
        ${unsupportedAlert}
        <section class="panel">
          <button id="scanner" type="button">Lire une carte</button>
          <p class="status" id="etat"></p>
          <div id="rapport"></div>
        </section>
      </div>

      ${playbackRule}
      ${troubleshooting()}

      <script src="/static/nfc.js"></script>
      <script src="/static/lecteur.js"></script>
    `,
  );
}

/** Le titre et les pistes chez Yoto. Une carte officielle ou d'un autre compte n'y est pas. */
async function lookUp(
  cardId: string,
): Promise<Pick<CardFacts, 'library' | 'libraryError' | 'remote'>> {
  if (!isConnected()) return { library: 'non-connecte' };
  try {
    const card = await getCard(cardId);
    const chapters = (card.content?.chapters ?? []).map((chapter) => chapter.title);
    return { library: 'ok', remote: { title: card.title, chapters } };
  } catch (error) {
    if (error instanceof AuthRequiredError) return { library: 'non-connecte' };
    if (error instanceof YotoError && (error.status === 403 || error.status === 404)) {
      return { library: 'introuvable' };
    }
    return { library: 'injoignable', libraryError: (error as Error).message };
  }
}

/** Tout ce que l'on sait d'une adresse relevee, mis en phrases par identify(). */
async function identityFor(url: string, cardId: string, uid: string | undefined): Promise<Identity> {
  const tag = uid ? findTag(uid) : undefined;
  const project = findProjectByCard(cardId);
  const pool = findByCardId(cardId);
  return identify({
    cardId,
    url,
    ...(await lookUp(cardId)),
    passeur: Boolean(uid) && uid === getPasseur(),
    project: project ? { id: project.id, title: project.title } : undefined,
    pool: pool ? { nickname: pool.nickname, ndefUrl: pool.ndef_url } : undefined,
    chip: tag
      ? {
          cardId: tag.card_id,
          writtenAt: tag.written_at,
          title: tag.card_id === cardId
            ? undefined
            : (findProjectByCard(tag.card_id)?.title ?? findByCardId(tag.card_id)?.nickname),
        }
      : undefined,
  });
}

/** Les histoires dont on detient l'adresse, sous leur titre Yoto quand on le connait. */
async function storiesWithAddress(): Promise<Story[]> {
  const titles = new Map<string, string>();
  if (isConnected()) {
    try {
      for (const card of await listMyCards()) titles.set(card.cardId, card.title);
    } catch {
      // Sans la bibliotheque, les surnoms du pool suffisent a choisir.
    }
  }
  return listPool()
    .filter((card) => card.ndef_url)
    .map((card) => ({
      cardId: card.card_id,
      title: titles.get(card.card_id) ?? findProjectByCard(card.card_id)?.title ?? card.nickname,
      copies: tagsFor(card.card_id).length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
}

const yotoUrlOf = (body: { url?: string } | undefined) => {
  const url = body?.url?.trim() ?? '';
  const parsed = parseYotoUrl(url);
  return parsed ? { url, cardId: parsed.cardId } : undefined;
};

const NOT_YOTO = { error: "Ce n'est pas une adresse de carte Yoto." };

export async function encodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Querystring: { projet?: string } }>('/cartes/encoder', async (request, reply) => {
    const projectId = Number(request.query.projet);
    const project = Number.isInteger(projectId) ? getProject(projectId) : undefined;
    const target = project?.card_id
      ? { cardId: project.card_id, title: project.title, projectId: project.id }
      : undefined;

    return reply
      .type('text/html')
      .send(page(getPasseur(), await storiesWithAddress(), target));
  });

  app.get('/cartes/verifier', async (_request, reply) =>
    reply.type('text/html').send(verifyPage()),
  );

  app.post<{ Body: { uid?: string } }>('/cartes/passeur', async (request, reply) => {
    const uid = request.body?.uid?.trim();
    if (!uid) {
      return reply.code(400).send({ error: 'Le téléphone n’a pas donné le numéro de la carte.' });
    }
    setPasseur(uid);
    return reply.send({ uid });
  });

  /** Oublier le passeur : perdu, abime, ou remplace par une autre carte MYO. */
  app.post<{ Body: { retour?: string } }>('/cartes/passeur/oublier', async (request, reply) => {
    forgetPasseur();
    return reply.redirect(request.body?.retour === '/reglages' ? '/reglages' : '/cartes/encoder');
  });

  /**
   * Met un nom sur une adresse relevee : l'histoire qu'elle joue, et ce qui cloche. Rien n'est
   * enregistre — c'est une lecture, appelee a chaque carte posee sur le telephone.
   */
  app.post<{ Body: { url?: string; uid?: string } }>('/cartes/identifier', async (request, reply) => {
    const found = yotoUrlOf(request.body);
    if (!found) return reply.code(400).send(NOT_YOTO);
    const identity = await identityFor(found.url, found.cardId, request.body?.uid?.trim());
    return reply.send({ ...identity, tags: tagsFor(found.cardId).length });
  });

  /**
   * Le passeur vient d'etre pose : son adresse est memorisee pour l'histoire qu'il porte. C'est la
   * seule fois ou on en a besoin — les copies suivantes de cette histoire s'en passent.
   */
  app.post<{ Body: { url?: string; uid?: string } }>('/cartes/releve', async (request, reply) => {
    const found = yotoUrlOf(request.body);
    if (!found) return reply.code(400).send(NOT_YOTO);
    const uid = request.body?.uid?.trim();
    if (!uid || uid !== getPasseur()) {
      return reply.code(400).send({ error: 'Cette carte n’est pas le passeur enregistré.' });
    }
    if (!fits(found.url)) {
      return reply
        .code(400)
        .send({ error: `Adresse trop longue : ${tagBytes(found.url)} octets pour ${TAG_CAPACITY}.` });
    }

    const identity = await identityFor(found.url, found.cardId, uid);
    saveAddress(found.cardId, nicknameFor(identity.title, found.cardId), found.url);
    return reply.send({ ...identity, tags: tagsFor(found.cardId).length });
  });

  /**
   * L'adresse d'une histoire deja relevee. Servie a la demande, et jamais posee dans le HTML de la
   * page : le token est un secret, il n'a pas a trainer dans la liste de toutes les cartes.
   */
  app.get<{ Params: { cardId: string } }>('/cartes/:cardId/adresse', async (request, reply) => {
    const card = findByCardId(request.params.cardId);
    if (!card?.ndef_url) return reply.code(404).send({ error: 'Aucune adresse relevée.' });
    return reply.send({ url: card.ndef_url });
  });

  /**
   * Note une copie qui vient d'etre ecrite. L'ecriture elle-meme se passe dans le telephone : le
   * serveur n'en garde que la trace.
   */
  app.post<{ Body: { url?: string; uid?: string } }>('/cartes/encoder', async (request, reply) => {
    const found = yotoUrlOf(request.body);
    if (!found) return reply.code(400).send(NOT_YOTO);
    if (request.body?.uid && request.body.uid === getPasseur()) {
      return reply.code(400).send({ error: 'C’est le passeur : il ne compte pas comme une copie.' });
    }
    saveAddress(found.cardId, nicknameFor(undefined, found.cardId), found.url);
    recordTag(found.cardId, request.body?.uid?.trim() || undefined);
    return reply.send({ cardId: found.cardId, tags: tagsFor(found.cardId).length });
  });
}
