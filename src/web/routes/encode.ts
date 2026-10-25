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
  contentIdsFor,
  findByCardId,
  findTag,
  forgetPasseur,
  getPasseur,
  listPool,
  recordTag,
  rememberTitles,
  saveAddress,
  setPasseur,
  tagsFor,
} from '../../db/cards.ts';
import {
  findProjectByCard,
  findProjectByTitle,
  getProject,
  setProjectCard,
} from '../../db/projects.ts';
import { type CardFacts, type Identity, identify } from '../../nfc/identify.ts';
import { FORMAT_COMMANDS, TAG_CAPACITY, fits, parseYotoUrl, tagBytes } from '../../nfc/ndef.ts';
import { getCard, listMyCards } from '../../yoto/api.ts';
import { AuthRequiredError, YotoError } from '../../yoto/errors.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { type Html, html, layout } from '../html.ts';
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
  // `cardId` absent quand on vient d'un projet dont l'adresse n'est pas (encore) connue : on
  // nomme alors l'histoire visée et on oriente vers le relevé, sans présélectionner une autre.
  target: { cardId?: string | undefined; title: string; projectId: number } | undefined,
) {
  const back = target ? `/projets/${target.projectId}` : '/cartes';
  return layout(
    { title: 'Fabriquer une carte', nav: 'cards' },
    html`
      <p><a class="back" href="${back}">← Retour</a></p>
      <h1>Fabriquer une carte</h1>

      <p class="muted">
        Mettre une histoire sur une puce du commerce « NFC Ultralight EV1 48 octets » — neuve, ou
        une copie qui change d'histoire. L'adresse de l'histoire s'obtient avec ta carte MYO
        officielle, le <strong>passeur</strong>, que l'app Yoto relie à l'histoire.
        <a href="/cartes/verifier">Lire une carte</a> pour vérifier ce qu'une puce porte.
      </p>

      ${unsupportedAlert}

      ${passeur
        ? html`
            <div id="atelier" data-passeur="${passeur}" data-target-card="${target?.cardId ?? ''}"
                 data-projet="${target?.projectId ?? ''}" data-capacity="${TAG_CAPACITY}">
              <section class="panel">
                <h2>1. Choisir l'histoire</h2>
                ${(() => {
                  // On vient d'un projet, mais son adresse n'est pas connue (titre ambigu ou jamais
                  // relevé). On nomme l'histoire et on oriente vers le relevé, sans présélectionner
                  // une autre histoire qu'on écrirait par erreur.
                  const unresolved = Boolean(target && !target.cardId);
                  const targetKnown = target?.cardId
                    ? stories.some((s) => s.cardId === target.cardId)
                    : false;
                  const options: Html[] = [];
                  if (unresolved) {
                    options.push(
                      html`<option value="" selected>— choisis une histoire, ou relève le passeur —</option>`,
                    );
                  }
                  if (target?.cardId && !targetKnown) {
                    options.push(
                      html`<option value="${target.cardId}" selected>
                        ${target.title} — à relever sur le passeur
                      </option>`,
                    );
                  }
                  stories.forEach((story, i) => {
                    const chosen = target?.cardId
                      ? story.cardId === target.cardId
                      : i === 0 && !target;
                    options.push(
                      html`<option value="${story.cardId}" ${chosen ? 'selected' : ''}>
                        ${story.title}${story.copies ? ` · ${story.copies} copie(s)` : ''}
                      </option>`,
                    );
                  });
                  return html`
                    ${unresolved
                      ? html`<p class="alert warn" style="display:block">
                          Pour encoder <strong>« ${target!.title} »</strong>, relie-la d'abord au
                          passeur dans l'app Yoto (« Link to a card »), puis relève-le ci-dessous.
                          Son adresse rejoindra alors la liste.
                        </p>`
                      : ''}
                    ${options.length > 0
                      ? html`
                          <label for="histoire">Histoire à copier</label>
                          <select id="histoire">${options}</select>
                          <p class="muted" style="margin-top:var(--space-4)">
                            Une autre histoire ? Relie-la au passeur dans l'app Yoto (« Link to a
                            card »), puis relève-le — son adresse rejoindra la liste.
                          </p>
                        `
                      : html`
                          <select id="histoire" hidden></select>
                          <p>
                            Aucune histoire connue encore. Relie une histoire au passeur dans l'app
                            Yoto (« Link to a card »), puis relève-le ici :
                          </p>
                        `}
                  `;
                })()}
                <button id="relever" type="button">Relever le passeur</button>
                <p class="status" id="etat-relever"></p>
              </section>

              <section class="panel" id="panneau-ecrire" hidden>
                <h2>2. Écrire sur une carte</h2>
                <p class="consigne" id="consigne"></p>
                <button id="changer" type="button">Écrire sur une carte</button>
                <p class="status" id="etat-ecrire"></p>
                <p class="muted">
                  La carte est lue avant d'être écrite : une copie ou une ancienne histoire change
                  d'histoire en un geste, et le passeur posé ici est relevé, jamais écrasé — pose-le,
                  retire-le, puis pose la carte à écrire.
                </p>
                <details>
                  <summary>Puce neuve, ou carte qui ne se lit pas</summary>
                  <p class="alert warn" style="display:block">
                    <strong>Une puce neuve doit être formatée une fois avant la première écriture.</strong>
                    Chrome ne sait pas le faire : avec l'app <em>NFC Tools</em>, « Autres » → « Effacer
                    le tag » (ou les commandes de « Si ça bloque » en bas). Sans ça, l'écriture échoue
                    avec « IO error ». Une fois formatée, la puce s'écrit ici sans souci.
                  </p>
                  <button id="ecrire" type="button">Écrire sans lire la carte</button>
                </details>
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
    { title: 'Lire une carte', nav: 'cards' },
    html`
      <p><a class="back" href="/cartes">← Cartes</a></p>
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
  const pool = findByCardId(cardId);
  // Une histoire publiee deux fois, ou qui a perdu son identifiant, se retrouve par son titre.
  const project =
    findProjectByCard(cardId) ?? (pool?.title ? findProjectByTitle(pool.title) : undefined);
  return identify({
    cardId,
    url,
    ...(await lookUp(cardId)),
    passeur: Boolean(uid) && uid === getPasseur(),
    cardName: tag?.name ?? null,
    project: project
      ? { id: project.id, title: project.title, cover: project.cover_url }
      : undefined,
    // Le titre retenu passe avant le surnom technique (« carte xxx »).
    pool: pool ? { nickname: pool.title ?? pool.nickname, ndefUrl: pool.ndef_url } : undefined,
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
      const remote = await listMyCards();
      rememberTitles(remote);
      for (const card of remote) titles.set(card.cardId, card.title);
    } catch {
      // Sans la bibliotheque, les surnoms du pool suffisent a choisir.
    }
  }
  const stories = listPool()
    .filter((card) => card.ndef_url)
    .map((card) => ({
      cardId: card.card_id,
      // Le titre retenu en base sert quand Yoto ne repond pas ; le surnom (« carte xxx ») en
      // dernier recours seulement.
      title:
        titles.get(card.card_id) ??
        card.title ??
        findProjectByCard(card.card_id)?.title ??
        card.nickname,
      copies: tagsFor(card.card_id).length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  // Une histoire publiee deux fois a deux adresses du meme titre : seul l'identifiant les departage.
  return stories.map((story) =>
    stories.filter((other) => other.title === story.title).length > 1
      ? { ...story, title: `${story.title} (version ${story.cardId})` }
      : story,
  );
}

const yotoUrlOf = (body: { url?: string | undefined } | undefined) => {
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
    const stories = await storiesWithAddress();

    // L'histoire peut avoir plusieurs contenus (publiee deux fois) ou avoir perdu le sien : on
    // vise celui dont l'adresse est relevee, en preferant celui qui a deja le plus de copies.
    const candidates = project
      ? stories
          .filter((story) => contentIdsFor(project).includes(story.cardId))
          .sort((a, b) => b.copies - a.copies)
      : [];
    const targetCardId = candidates[0]?.cardId ?? project?.card_id ?? undefined;
    // Venir d'un projet pose toujours une cible (pour nommer l'histoire) ; le cardId peut rester
    // indéterminé, auquel cas la page oriente vers le relevé plutôt que d'en présélectionner une.
    const target = project
      ? { cardId: targetCardId, title: project.title, projectId: project.id }
      : undefined;

    return reply.type('text/html').send(page(getPasseur(), stories, target));
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
    return reply.redirect(request.body?.retour === '/cartes' ? '/cartes' : '/cartes/encoder');
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
  app.post<{ Body: { url?: string; uid?: string; projet?: string | number } }>('/cartes/releve', async (request, reply) => {
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
    if (identity.library === 'ok' && identity.title) {
      rememberTitles([{ cardId: found.cardId, title: identity.title }]);
    }

    // Releve depuis un projet qui ne connait pas encore son cardId : on le lui rattache, pour ne
    // plus avoir a repasser par le passeur. Seulement si le titre Yoto est celui du projet — le
    // passeur peut porter une autre histoire, et un mauvais lien ferait encoder la mauvaise.
    const projectId = Number(request.body?.projet);
    const project = Number.isInteger(projectId) ? getProject(projectId) : undefined;
    if (project &&!project.card_id && identity.title === project.title) {
      setProjectCard(project.id, found.cardId);
      identity.project = { id: project.id, title: project.title };
    }
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
   * serveur n'en garde que la trace. `previous` : l'adresse que la carte portait, quand elle a pu
   * etre lue avant — on rend alors le nom de l'histoire remplacee.
   */
  app.post<{ Body: { url?: string; uid?: string; previous?: string } }>('/cartes/encoder', async (request, reply) => {
    const found = yotoUrlOf(request.body);
    if (!found) return reply.code(400).send(NOT_YOTO);
    if (request.body?.uid && request.body.uid === getPasseur()) {
      return reply.code(400).send({ error: 'C’est le passeur : il ne compte pas comme une copie.' });
    }
    saveAddress(found.cardId, nicknameFor(undefined, found.cardId), found.url);
    const tag = recordTag(found.cardId, request.body?.uid?.trim() || undefined);

    const previous = yotoUrlOf({ url: request.body?.previous });
    const replaced = previous && previous.cardId !== found.cardId
      ? (findProjectByCard(previous.cardId)?.title ??
        findByCardId(previous.cardId)?.nickname ??
        previous.cardId)
      : null;
    return reply.send({
      cardId: found.cardId,
      tags: tagsFor(found.cardId).length,
      replaced,
      // Seule une puce reconnue a son numero se nomme : les autres ne se distinguent pas.
      tag: tag.uid ? { id: tag.id, name: tag.name } : null,
    });
  });
}
