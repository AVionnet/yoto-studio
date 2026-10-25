/* Outils NFC communs à l'encodeur et au lecteur de cartes : lire une puce, mettre un nom sur ce
   qu'elle porte, et transformer une erreur Web NFC en une phrase qui dit quoi faire.

   Web NFC n'existe que sur Chrome pour Android, en HTTPS. Ce script se charge avant les pages
   qui s'en servent et n'expose qu'un objet, window.YotoNfc. */
(function () {
  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* Miroir de parseYotoUrl() dans src/nfc/ndef.ts. Le token est la query brute, pas un
     couple clé=valeur. */
  function parseYoto(raw) {
    var url;
    try { url = new URL(String(raw).trim()); } catch (e) { return null; }
    if (!/^(.+\.)?yoto\.io$/i.test(url.hostname)) return null;
    var cardId = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9]{3,20}$/.test(cardId)) return null;
    return { url: raw, cardId: cardId, token: url.search.replace(/^\?/, '') };
  }

  /* Miroir de tagBytes() : huit octets d'ossature NDEF, plus l'URL dont « https:// » est
     remplacé par un octet de préfixe. */
  function tagBytes(url) {
    var rest = /^https:\/\//i.test(url) ? url.slice(8) : url;
    return 8 + new TextEncoder().encode(rest).length;
  }

  function urlFrom(message) {
    for (var i = 0; i < message.records.length; i += 1) {
      var record = message.records[i];
      if (record.recordType === 'url' || record.recordType === 'absolute-url') {
        return new TextDecoder().decode(record.data);
      }
    }
    return '';
  }

  /* Le jeton est un secret : il ne s'affiche jamais en entier sans qu'on le demande. */
  function maskUrl(url) {
    var found = parseYoto(url);
    return found ? 'https://yoto.io/' + found.cardId + (found.token ? '?••••••' : '') : url;
  }

  /* Chaque enregistrement NDEF de la puce, lisible par un humain. */
  function describeRecords(message) {
    var out = [];
    for (var i = 0; i < message.records.length; i += 1) {
      var record = message.records[i];
      var text = '';
      if (record.recordType === 'url' || record.recordType === 'absolute-url') {
        text = maskUrl(new TextDecoder().decode(record.data));
      } else if (record.recordType === 'text') {
        text = new TextDecoder(record.encoding || 'utf-8').decode(record.data);
      } else if (record.recordType === 'empty') {
        text = '(vide)';
      } else {
        text = (record.mediaType || '') + (record.data ? ' · ' + record.data.byteLength + ' octets' : '');
      }
      out.push({ type: record.recordType, text: text });
    }
    return out;
  }

  /* Les erreurs que Web NFC peut lever, avec la cause probable et le geste qui corrige.
     `phase` : 'scan' (lecture), 'write' (écriture) ou 'lock' (verrouillage). */
  var NFC_SETTINGS = 'Réglages Android → Appareils connectés → Préférences de connexion → NFC';
  var CHROME_PERMISSION = 'touche le cadenas à gauche de l’adresse → Autorisations → Appareils NFC '
    + '→ Autoriser, puis recharge la page';

  function explain(error, phase) {
    var name = (error && error.name) || 'Error';
    var detail = name + ' — ' + ((error && error.message) || 'sans message');
    var writing = phase === 'write' || phase === 'lock';
    var known = {
      NotAllowedError: writing
        ? {
            text: 'Chrome a refusé l’écriture.',
            fix: 'Soit le NFC n’est pas autorisé pour ce site (' + CHROME_PERMISSION + '), soit la '
              + 'puce est verrouillée en lecture seule — dans ce cas il faut une autre vierge. '
              + 'L’outil « Lire une carte » dit ce qu’elle porte.',
          }
        : {
            text: 'Chrome n’a pas le droit d’utiliser le NFC.',
            fix: 'Autorise-le : ' + CHROME_PERMISSION + '. Vérifie aussi que le NFC est activé ('
              + NFC_SETTINGS + ').',
          },
      NotSupportedError: writing
        ? {
            text: 'Cette puce n’accepte pas d’adresse : elle n’est pas formatée NDEF, ou ce n’est '
              + 'pas le bon modèle.',
            fix: 'Une puce neuve sort parfois d’usine sans en-tête NDEF : formate-la une fois avec '
              + 'les deux commandes de la section « Si ça bloque ». Vérifie aussi que c’est bien '
              + 'une NTAG / Ultralight EV1 de 48 octets.',
          }
        : {
            text: 'Ce téléphone ne permet pas à Chrome d’utiliser le NFC.',
            fix: 'Il faut un téléphone Android avec NFC. Vérifie qu’il est activé (' + NFC_SETTINGS
              + ') et que Chrome est à jour.',
          },
      NotReadableError: {
        text: 'Le NFC du téléphone est indisponible.',
        fix: 'Active-le (' + NFC_SETTINGS + '), ferme les applis qui l’utilisent (NFC Tools, '
          + 'paiement sans contact ouvert…), puis recharge la page.',
      },
      NetworkError: writing
        ? {
            text: 'L’écriture a échoué : la puce n’est sans doute pas encore formatée NDEF.',
            fix: 'Cause la plus fréquente sur une puce neuve : Chrome ne sait pas la formater seul. '
              + 'Formate-la UNE fois avec l’app NFC Tools (fonction « Autres » → « Effacer le tag », '
              + 'ou les deux commandes de « Si ça bloque »), puis reviens écrire ici — ça marchera. '
              + 'Si l’erreur persiste même immobile et formatée, vérifie que la puce a bien bougé, '
              + 'ou qu’elle n’est pas verrouillée (NFC Tools indique « Inscriptible : non »).',
          }
        : {
            text: 'La liaison avec la carte a été coupée pendant la lecture.',
            fix: 'Pose la carte à plat contre le dos du téléphone — la zone NFC est souvent au '
              + 'centre ou près de l’appareil photo —, retire une coque épaisse ou métallique, et '
              + 'ne bouge plus jusqu’au message. Puis recommence.',
          },
      AbortError: {
        text: 'L’opération a été interrompue.',
        fix: 'Garde l’écran allumé et cette page au premier plan pendant toute l’opération, puis '
          + 'relance.',
      },
      InvalidStateError: {
        text: 'Une autre opération NFC est déjà en cours.',
        fix: 'Recharge la page, puis recommence une seule opération à la fois.',
      },
      SecurityError: {
        text: 'Le NFC n’est accessible que sur une page sécurisée et au premier plan.',
        fix: 'Ouvre l’adresse en https://, dans Chrome lui-même (pas dans un navigateur intégré à '
          + 'une autre appli).',
      },
    };
    var hit = known[name] || {
      text: 'Le téléphone a renvoyé une erreur inattendue.',
      fix: 'Recharge la page et réessaie. Si ça persiste, l’outil « Lire une carte » montre ce que '
        + 'porte la puce.',
    };
    return { text: hit.text, fix: hit.fix, detail: detail };
  }

  /* ── Rendu ─────────────────────────────────────────────────────────────── */

  function verdict(kind, inner) {
    return '<div class="alert ' + kind + '" style="display:block">' + inner + '</div>';
  }

  /* Une erreur, toujours accompagnée de la façon de la corriger. */
  function problem(text, fix, detail) {
    return verdict('error',
      '<p><strong>' + esc(text) + '</strong></p>'
      + (fix ? '<p><strong>Comment corriger :</strong> ' + esc(fix) + '</p>' : '')
      + (detail ? '<p class="detail">Détail technique : <code>' + esc(detail) + '</code></p>' : ''));
  }

  function explained(error, phase) {
    var e = explain(error, phase);
    return problem(e.text, e.fix, e.detail);
  }

  function notes(list) {
    return (list || []).map(function (note) {
      if (note.kind === 'ok') return verdict('ok', '<p>' + esc(note.text) + '</p>');
      return verdict(note.kind === 'error' ? 'error' : 'warn',
        '<p><strong>' + esc(note.text) + '</strong></p>'
        + (note.fix ? '<p><strong>Comment corriger :</strong> ' + esc(note.fix) + '</p>' : ''));
    }).join('');
  }

  /* Une Ultralight EV1 de NXP — la puce des cartes Yoto — a un uid de 7 octets qui commence par
     04. Un autre uid trahit un autre modèle, que le lecteur risque de refuser. */
  function chipWarning(uid) {
    if (!uid || /^04(:[0-9a-f]{2}){6}$/i.test(uid)) return '';
    return verdict('warn', '<p><strong>Ce n’est sans doute pas une Ultralight EV1 de NXP</strong> '
      + '(numéro <code>' + esc(uid) + '</code>) : le lecteur Yoto risque de la refuser.</p>'
      + '<p><strong>Comment corriger :</strong> utilise des puces « MIFARE Ultralight EV1, 48 '
      + 'octets » ; garde celle-ci pour un essai.</p>');
  }

  /* L'histoire que joue une carte : son titre d'abord, l'identifiant ensuite. */
  var MAX_CHAPTERS = 8;
  function story(identity) {
    var title = identity.title
      ? '« ' + esc(identity.title) + ' »'
      : '<em>Histoire inconnue</em>';
    var chapters = identity.chapters || [];
    var meta = ['<code>' + esc(identity.cardId) + '</code>'];
    if (chapters.length) meta.push(chapters.length + ' piste' + (chapters.length > 1 ? 's' : ''));
    if (identity.tags) meta.push(identity.tags + ' carte(s) encodée(s)');
    if (identity.project) {
      meta.push('<a href="/projets/' + identity.project.id + '">voir le projet</a>');
    }
    var list = chapters.slice(0, MAX_CHAPTERS).map(function (chapter) {
      return '<li>' + esc(chapter) + '</li>';
    }).join('');
    var more = chapters.length > MAX_CHAPTERS
      ? '<li class="muted">… et ' + (chapters.length - MAX_CHAPTERS) + ' autres</li>'
      : '';
    return '<div class="story">'
      + '<p class="story-title">' + title + '</p>'
      + '<p class="story-meta">' + meta.join(' · ') + '</p>'
      + (list ? '<ol class="story-chapters">' + list + more + '</ol>' : '')
      + '</div>';
  }

  /* ── Serveur ───────────────────────────────────────────────────────────── */

  /* Ce que le serveur sait de cette adresse : titre, pistes, et ce qui cloche. */
  function identify(url, uid) {
    return fetch('/cartes/identifier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: url, uid: uid || '' }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Le serveur n’a pas pu identifier la carte.');
        return body;
      });
    });
  }

  /* ── Lecture ───────────────────────────────────────────────────────────── */

  /* Une lecture, une seule : on coupe le scan dès la première carte pour ne pas ramasser la
     suivante par surprise. Les écouteurs sont posés avant scan(), jamais après.
     `onUnreadable` : une carte est dans le champ, mais Chrome ne sait pas lire son contenu. */
  function scanOnce(handlers) {
    var reader = new NDEFReader();
    var controller = new AbortController();
    reader.addEventListener('reading', function (event) {
      controller.abort();
      handlers.onReading(event);
    });
    reader.addEventListener('readingerror', function () {
      if (handlers.onUnreadable) handlers.onUnreadable();
    });
    reader.scan({ signal: controller.signal }).catch(function (error) {
      controller.abort();
      handlers.onFailure(error);
    });
    return controller;
  }

  var UNREADABLE = {
    text: 'Une carte est détectée, mais Chrome ne lit pas son contenu.',
    fix: 'Si c’est une puce neuve, c’est souvent qu’elle n’est pas encore formatée NDEF : ce '
      + 'n’est pas grave pour une vierge, l’écriture s’en charge (sinon, voir « Si ça bloque »). '
      + 'Sinon, elle est mal placée : fais-la glisser lentement sur le dos du téléphone.',
  };

  /* L'état de l'autorisation NFC, quand le navigateur sait le dire. */
  function permission(callback) {
    if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) {
      callback('inconnu');
      return;
    }
    navigator.permissions.query({ name: 'nfc' })
      .then(function (status) { callback(status.state); })
      .catch(function () { callback('inconnu'); });
  }

  window.YotoNfc = {
    esc: esc,
    parseYoto: parseYoto,
    tagBytes: tagBytes,
    urlFrom: urlFrom,
    maskUrl: maskUrl,
    describeRecords: describeRecords,
    explain: explain,
    verdict: verdict,
    problem: problem,
    explained: explained,
    notes: notes,
    chipWarning: chipWarning,
    story: story,
    identify: identify,
    scanOnce: scanOnce,
    UNREADABLE: UNREADABLE,
    permission: permission,
    supported: 'NDEFReader' in window,
  };
})();
