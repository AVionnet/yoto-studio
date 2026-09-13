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

import { enroll, findByCardId, listPool, recordTag, setNdefUrl, tagsFor } from '../../db/cards.ts';
import { getProject } from '../../db/projects.ts';
import { FORMAT_COMMANDS, TAG_CAPACITY, fits, parseYotoUrl, tagBytes } from '../../nfc/ndef.ts';
import { html, layout } from '../html.ts';
import { requireAuth } from './auth.ts';

/** Un surnom par defaut plutot qu'un champ vide : la carte vient toujours de quelque part. */
const nicknameFor = (title: string | undefined, cardId: string): string =>
  (title ?? `carte ${cardId}`).slice(0, 60);

function page(
  target: { cardId: string; title: string; projectId: number } | undefined,
  known: KnownCard[],
) {
  return layout(
    { title: 'Encoder une carte', nav: 'settings' },
    html`
      <p><a class="back" href="${target ? '/' : '/reglages'}">← Retour</a></p>
      <h1>Encoder une carte vierge</h1>

      <p class="muted">
        Une carte Yoto est un simple tag NFC de 48 octets qui porte une adresse. Les puces
        « NFC Ultralight EV1 48 octets » vendues par lots sont la même puce : il suffit d'y
        recopier l'adresse d'un contenu, et le lecteur les accepte comme les autres.
      </p>

      <div id="encodeur"
           data-target-card="${target?.cardId ?? ''}"
           data-projet="${target?.projectId ?? ''}"
           data-capacity="${TAG_CAPACITY}">

        <div id="indispo" class="alert error" hidden>
          Cette page a besoin de Web NFC : <strong>Chrome sur Android</strong>, en HTTPS. Ouvre-la
          depuis le téléphone, pas depuis l'ordinateur.
        </div>

        <section class="panel">
          <h2>1. D'où vient l'adresse</h2>
          ${target
            ? html`<p class="alert ok" style="display:block">
                <span>
                  Contenu visé : <strong>${target.title}</strong> — <code>${target.cardId}</code>.
                  Dans l'app Yoto, lie ce contenu à ta carte MYO « passeur », puis relève-la ici.
                </span>
              </p>`
            : ''}

          <p class="muted">
            L'adresse porte un jeton signé par Yoto : elle ne s'invente pas, elle se relève sur une
            carte existante. Une seule carte MYO officielle suffit — relie-lui un contenu dans
            l'app Yoto, relève-la, recopie, recommence.
          </p>

          <button id="lire" type="button">Relever une carte existante</button>

          ${known.length > 0
            ? html`
                <p class="muted" style="margin-top:var(--space-4)">
                  Ou reprendre une adresse déjà relevée, pour fabriquer une jumelle ou remplacer
                  une carte perdue :
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

        <section class="panel" id="source" hidden>
          <h2>2. Ce qui sera écrit</h2>
          <div id="source-verdict"></div>
          <dl class="kv">
            <dt>contenu</dt><dd id="source-card">—</dd>
            <dt>jeton</dt><dd><span id="source-token" class="masked">masqué</span></dd>
            <dt>occupation</dt><dd id="source-size">—</dd>
          </dl>
        </section>

        <section class="panel" id="ecriture" hidden>
          <h2>3. Écrire sur la carte vierge</h2>
          <p class="muted">
            Approche <strong>la carte vierge</strong> du dos du téléphone, et garde-la immobile
            jusqu'au message de confirmation.
          </p>
          <label class="check">
            <input type="checkbox" id="verrou">
            Verrouiller la puce après l'écriture — définitif, plus aucune réécriture possible.
          </label>
          <button id="ecrire" type="button">Écrire sur la carte vierge</button>
          <p class="status" id="etat"></p>
          <div id="resultat"></div>
        </section>
      </div>

      <section class="panel">
        <h2>Si le téléphone refuse d'écrire</h2>
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

      <script src="/static/encoder.js"></script>
    `,
  );
}

interface KnownCard {
  cardId: string;
  nickname: string;
  tags: number;
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
