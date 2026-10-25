/**
 * Encoder une carte vierge : recopier sur une puce du commerce l'URL d'un contenu Yoto.
 *
 * Une carte Yoto n'est rien d'autre qu'un MIFARE Ultralight EV1 de 48 octets portant
 * `https://yoto.io/<cardId>?<token>`. Les puces vierges vendues par lots sont exactement la meme
 * chose — il ne manque que l'URL.
 *
 * Cette URL ne se fabrique pas : le token est frappe par le serveur Yoto. Elle se releve, sur une
 * carte MYO officielle qui sert de passeur. Lier un contenu a cette carte dans l'app Yoto y ecrit
 * une URL neuve ; on la releve, on la recopie sur une vierge, et la vierge devient definitivement
 * la carte de ce contenu. Le passeur est alors libre pour le contenu suivant.
 */
import type { FastifyInstance } from 'fastify';

import {
  enroll,
  findByCardId,
  findTag,
  listPool,
  recordTag,
  setNdefUrl,
  tagsFor,
} from '../../db/cards.ts';
import { findProjectByCard, getProject } from '../../db/projects.ts';
import { type CardFacts, identify } from '../../nfc/identify.ts';
import { FORMAT_COMMANDS, TAG_CAPACITY, fits, parseYotoUrl, tagBytes } from '../../nfc/ndef.ts';
import { getCard } from '../../yoto/api.ts';
import { AuthRequiredError, YotoError } from '../../yoto/errors.ts';
import { isConnected } from '../../yoto/oauth.ts';
import { html, layout } from '../html.ts';
import { requireAuth } from './auth.ts';

/** Un surnom par defaut plutot qu'un champ vide : la carte vient toujours de quelque part. */
const nicknameFor = (title: string | undefined, cardId: string): string =>
  (title ?? `carte ${cardId}`).slice(0, 60);

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
      "Le scan n'était pas lancé : appuie d'abord sur le bouton de cette page, puis pose la carte. " +
        'Garde la page au premier plan, écran allumé.',
    ],
    [
      'Le titre affiché n’est pas la bonne histoire',
      "Le passeur porte encore l'histoire précédente : dans l'app Yoto, relie la bonne histoire " +
        'au passeur, puis relève-le de nouveau.',
    ],
    [
      '« C’est le passeur qui a été réécrit »',
      "Le passeur était encore près du téléphone au moment d'écrire. Éloigne-le, appuie sur " +
        '« Écrire », puis pose la vierge seule.',
    ],
    [
      'La carte encodée ne joue rien dans le lecteur',
      'Vérifie-la avec « Lire une carte » : elle doit afficher le titre de l’histoire. Le lecteur ' +
        "doit être connecté au wifi la première fois, pour télécharger l'histoire.",
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

function page(
  target: { cardId: string; title: string; projectId: number } | undefined,
  known: KnownCard[],
) {
  return layout(
    { title: 'Encoder une carte', nav: 'settings' },
    html`
      <p><a class="back" href="${target ? `/projets/${target.projectId}` : '/reglages'}">← Retour</a></p>
      <h1>Encoder une carte vierge</h1>

      <p class="muted">
        Une carte Yoto est un simple tag NFC qui porte une adresse. On relève cette adresse sur ta
        carte MYO officielle (le <strong>passeur</strong>), puis on la recopie sur une puce vierge
        « NFC Ultralight EV1 48 octets ». La vierge joue alors la même histoire.
        <a href="/cartes/verifier">Lire une carte</a> pour vérifier ce qu'une puce porte.
      </p>

      <div id="encodeur"
           data-target-card="${target?.cardId ?? ''}"
           data-target-title="${target?.title ?? ''}"
           data-projet="${target?.projectId ?? ''}"
           data-capacity="${TAG_CAPACITY}">

        ${unsupportedAlert}

        <section class="panel">
          <h2>Avant de commencer</h2>
          <ul class="checklist">
            <li id="chk-nfc">Vérification de Web NFC…</li>
            <li id="chk-perm">Vérification de l'autorisation NFC…</li>
            <li>Le <strong>NFC est activé</strong> sur le téléphone (Réglages → Appareils connectés).</li>
            <li>Sous la main : le <strong>passeur</strong> (carte MYO officielle) et une <strong>vierge</strong>.</li>
          </ul>
        </section>

        <section class="panel">
          <h2>1. Relier l'histoire au passeur, dans l'app Yoto</h2>
          ${target
            ? html`<p class="alert ok" style="display:block">
                Histoire à encoder : <strong>« ${target.title} »</strong> — <code>${target.cardId}</code>
              </p>`
            : ''}
          <ol class="steps">
            <li>Ouvre l'app Yoto → Bibliothèque → l'histoire${target ? html` « ${target.title} »` : ''}.</li>
            <li>Choisis « Link to a card » (Lier à une carte).</li>
            <li>Approche le passeur du téléphone quand l'app le demande, et attends sa confirmation.</li>
            <li>Reviens ici. Si c'est déjà fait, passe directement à l'étape 2.</li>
          </ol>
          <p class="muted">
            L'adresse porte un jeton signé par Yoto : elle ne s'invente pas, c'est l'app qui
            l'écrit sur le passeur. Le passeur peut ensuite resservir pour l'histoire suivante.
          </p>
        </section>

        <section class="panel">
          <h2>2. Relever le passeur</h2>
          <p>
            Appuie sur le bouton, <strong>puis</strong> pose le passeur à plat contre le dos du
            téléphone. Le titre de l'histoire qu'il porte s'affiche : vérifie que c'est la bonne.
          </p>
          <button id="lire" type="button">Relever le passeur</button>
          <p class="status" id="lire-etat"></p>
          <div id="lire-resultat"></div>

          <div id="source" hidden>
            <div id="source-histoire"></div>
            <div id="source-verdict"></div>
            <details>
              <summary>Détails de l'adresse</summary>
              <dl class="kv">
                <dt>contenu</dt><dd id="source-card">—</dd>
                <dt>jeton</dt><dd><span id="source-token" class="masked">masqué</span></dd>
                <dt>occupation</dt><dd id="source-size">—</dd>
              </dl>
            </details>
          </div>

          ${known.length > 0
            ? html`
                <p class="muted" style="margin-top:var(--space-4)">
                  Ou reprendre une adresse déjà relevée, pour fabriquer une jumelle ou remplacer
                  une carte perdue — sans passeur :
                </p>
                <form class="inline" id="reprise">
                  <select id="connue" aria-label="Adresse déjà relevée">
                    ${known.map(
                      (card) => html`<option value="${card.cardId}">
                        ${card.nickname} — ${card.cardId}${card.tags > 0
                          ? ` · ${card.tags} carte(s) encodée(s)`
                          : ''}
                      </option>`,
                    )}
                  </select>
                  <button type="submit">Reprendre</button>
                </form>
              `
            : ''}
        </section>

        <section class="panel" id="ecriture" hidden>
          <h2>3. Écrire sur la carte vierge</h2>
          <ol class="steps">
            <li><strong>Éloigne le passeur</strong> du téléphone — sinon c'est lui qui sera réécrit.</li>
            <li>Appuie sur « Écrire sur la carte vierge ».</li>
            <li>Pose la <strong>vierge</strong> contre le dos du téléphone et ne bouge plus jusqu'au
              message : la carte est écrite, puis relue pour vérifier.</li>
          </ol>
          <label class="check">
            <input type="checkbox" id="verrou">
            Verrouiller la puce après l'écriture — définitif, plus aucune réécriture possible.
          </label>
          <button id="ecrire" type="button">Écrire sur la carte vierge</button>
          <p class="status" id="etat"></p>
          <div id="resultat"></div>
        </section>
      </div>

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
        Pose n'importe quelle carte — officielle, encodée ici, vierge : on affiche l'histoire
        qu'elle joue et, si quelque chose cloche, comment le corriger. Rien n'est écrit sur la
        carte.
      </p>

      <div id="lecteur" data-capacity="${TAG_CAPACITY}">
        ${unsupportedAlert}
        <section class="panel">
          <button id="scanner" type="button">Lire une carte</button>
          <p class="status" id="etat"></p>
          <div id="rapport"></div>
        </section>
      </div>

      ${troubleshooting()}

      <script src="/static/nfc.js"></script>
      <script src="/static/lecteur.js"></script>
    `,
  );
}

interface KnownCard {
  cardId: string;
  nickname: string;
  tags: number;
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

export async function encodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get<{ Querystring: { projet?: string } }>('/cartes/encoder', async (request, reply) => {
    const projectId = Number(request.query.projet);
    const project = Number.isInteger(projectId) ? getProject(projectId) : undefined;
    const target = project?.card_id
      ? { cardId: project.card_id, title: project.title, projectId: project.id }
      : undefined;

    // Seules les cartes dont on detient l'adresse peuvent servir de source sans passer par le tag.
    const known = listPool()
      .filter((card) => card.ndef_url)
      .map((card) => ({
        cardId: card.card_id,
        nickname: card.nickname,
        tags: tagsFor(card.card_id).length,
      }));

    return reply.type('text/html').send(page(target, known));
  });

  app.get('/cartes/verifier', async (_request, reply) =>
    reply.type('text/html').send(verifyPage()),
  );

  /**
   * Met un nom sur une adresse relevee : l'histoire qu'elle joue, et ce qui cloche. Rien n'est
   * enregistre — c'est une lecture, appelee a chaque carte posee sur le telephone.
   */
  app.post<{ Body: { url?: string; uid?: string } }>('/cartes/identifier', async (request, reply) => {
    const url = request.body?.url?.trim() ?? '';
    const parsed = parseYotoUrl(url);
    if (!parsed) return reply.code(400).send({ error: "Ce n'est pas une adresse de carte Yoto." });
    const { cardId } = parsed;

    const uid = request.body?.uid?.trim();
    const tag = uid ? findTag(uid) : undefined;
    const project = findProjectByCard(cardId);
    const pool = findByCardId(cardId);
    const remote = await lookUp(cardId);

    const identity = identify({
      cardId,
      url,
      ...remote,
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
    return reply.send({ ...identity, tags: tagsFor(cardId).length });
  });

  /**
   * L'adresse d'une carte deja relevee. Servie a la demande, et jamais posee dans le HTML de la
   * page : le token est un secret, il n'a pas a trainer dans la liste de toutes les cartes.
   */
  app.get<{ Params: { cardId: string } }>('/cartes/:cardId/adresse', async (request, reply) => {
    const card = findByCardId(request.params.cardId);
    if (!card?.ndef_url) return reply.code(404).send({ error: 'Aucune adresse relevée.' });
    return reply.send({ url: card.ndef_url });
  });

  /**
   * Note ce qui vient d'etre ecrit. L'encodage lui-meme se passe entierement dans le telephone :
   * le serveur n'en garde que la trace, et enrole au passage le contenu dans le pool — une carte
   * dont on detient l'adresse se republie ensuite sans jamais retoucher au tag.
   */
  app.post<{ Body: { url?: string; uid?: string; projet?: string } }>(
    '/cartes/encoder',
    async (request, reply) => {
      const url = request.body?.url?.trim() ?? '';
      const identity = parseYotoUrl(url);
      if (!identity) return reply.code(400).send({ error: "Ce n'est pas une adresse de carte Yoto." });
      if (!fits(url)) {
        return reply
          .code(400)
          .send({ error: `Adresse trop longue : ${tagBytes(url)} octets pour ${TAG_CAPACITY}.` });
      }

      const projectId = Number(request.body?.projet);
      const project = Number.isInteger(projectId) ? getProject(projectId) : undefined;

      // Un surnom choisi a la main — « la bleue » — ne doit pas se faire ecraser par le titre du
      // projet a chaque jumelle encodee : on n'enrole que ce qui manque au pool.
      if (!findByCardId(identity.cardId)) {
        enroll(identity.cardId, nicknameFor(project?.title, identity.cardId), url);
      }
      // enroll() preserve une adresse deja connue ; le releve, lui, fait foi.
      setNdefUrl(identity.cardId, url);
      recordTag(identity.cardId, request.body?.uid?.trim() || undefined);

      const card = findByCardId(identity.cardId);
      return reply.send({
        cardId: identity.cardId,
        nickname: card?.nickname ?? '',
        tags: tagsFor(identity.cardId).length,
      });
    },
  );
}
