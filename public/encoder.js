/* L'atelier d'encodage : on pose des cartes sur le téléphone, il reconnaît chacune et agit.

   - le passeur (reconnu à son uid, enregistré une fois) : son adresse est relevée et mémorisée
     pour l'histoire qu'il porte ;
   - une vierge : elle reçoit l'adresse de l'histoire choisie ;
   - une copie déjà faite : rien à faire, on le dit ;
   - une carte qui porte autre chose : on ne l'écrase qu'après confirmation.

   Web NFC n'existe que sur Chrome pour Android, en HTTPS. Les outils communs (lecture, erreurs
   expliquées, rendu de l'histoire) viennent de nfc.js. */
(function () {
  var nfc = window.YotoNfc;
  if (!nfc) return;
  var esc = nfc.esc;
  var unsupported = document.getElementById('indispo');

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || 'Le serveur a refusé (HTTP ' + response.status + ').');
        return data;
      });
    });
  }

  /* ── Enregistrer le passeur, une seule fois ─────────────────────────────── */

  var registerBtn = document.getElementById('enregistrer');
  if (registerBtn) {
    var statusEl = document.getElementById('etat');
    var resultEl = document.getElementById('resultat');
    if (!nfc.supported) {
      unsupported.hidden = false;
      registerBtn.disabled = true;
      return;
    }
    var fail = function (html) {
      registerBtn.disabled = false;
      statusEl.textContent = '';
      statusEl.className = 'status';
      resultEl.innerHTML = html;
    };
    registerBtn.addEventListener('click', function () {
      resultEl.innerHTML = '';
      registerBtn.disabled = true;
      statusEl.textContent = 'Pose ta carte MYO officielle contre le dos du téléphone…';
      statusEl.className = 'status pulse';
      nfc.scanOnce({
        onReading: function (event) {
          if (!nfc.parseYoto(nfc.urlFrom(event.message))) {
            fail(nfc.problem('Ce n’est pas une carte Yoto : elle ne porte pas d’adresse yoto.io.',
              'Le passeur est une carte MYO officielle, achetée chez Yoto. Relie-lui une histoire '
                + 'dans l’app Yoto, puis recommence.'));
            return;
          }
          if (!event.serialNumber) {
            fail(nfc.problem('Le téléphone ne donne pas le numéro de cette carte.',
              'Sans lui, le passeur ne peut pas être reconnu. Mets Chrome à jour et réessaie.'));
            return;
          }
          post('/cartes/passeur', { uid: event.serialNumber })
            .then(function () { window.location.reload(); })
            .catch(function (error) { fail(nfc.problem(error.message, 'Recharge la page et réessaie.')); });
        },
        onUnreadable: function () {
          fail(nfc.problem(nfc.UNREADABLE.text, 'Pose bien la carte MYO officielle, pas une vierge.'));
        },
        onFailure: function (error) { fail(nfc.explained(error, 'scan')); },
      });
    });
    return;
  }

  /* ── L'atelier : relever le passeur (lecture), puis écrire sur des vierges (écriture) ──────
     Jamais de scan pendant l'écriture : Web NFC n'autorise qu'une opération à la fois, et un scan
     actif garde la connexion à la puce, ce qui fait échouer write() avec « IO error ». */

  var root = document.getElementById('atelier');
  if (!root) return;

  var passeur = root.dataset.passeur;
  var targetCard = root.dataset.targetCard || '';
  var select = document.getElementById('histoire');
  var relBtn = document.getElementById('relever');
  var relStatus = document.getElementById('etat-relever');
  var writePanel = document.getElementById('panneau-ecrire');
  var writeBtn = document.getElementById('ecrire');
  var writeStatus = document.getElementById('etat-ecrire');
  var consigne = document.getElementById('consigne');
  var journal = document.getElementById('journal');

  if (!nfc.supported) {
    unsupported.hidden = false;
    relBtn.disabled = true;
    writeBtn.disabled = true;
    return;
  }

  /* L'histoire à copier : { cardId, url, title }, ou null tant qu'aucune n'est choisie. */
  var story = null;

  function say(el, text, pulsing) {
    el.textContent = text;
    el.className = pulsing ? 'status pulse' : 'status';
  }

  function log(html) {
    journal.innerHTML = html + journal.innerHTML;
  }

  function titleOf(s) {
    return s && s.title ? '« ' + esc(s.title) + ' »' : '<code>' + esc(s ? s.cardId : '?') + '</code>';
  }

  function armWrite() {
    if (!story) {
      writePanel.hidden = true;
      return;
    }
    writePanel.hidden = false;
    consigne.innerHTML = 'Prête à copier ' + titleOf(story) + '. Pose une carte vierge, appuie sur '
      + '« Écrire », et garde-la immobile jusqu’au message.';
    writeBtn.disabled = false;
  }

  /* ── Choisir l'histoire dans la liste (adresse déjà mémorisée) ──────────── */

  function choose(cardId) {
    story = null;
    armWrite();
    if (!cardId) { say(relStatus, ''); return Promise.resolve(); }
    var title = select.options[select.selectedIndex].textContent.replace(/·.*$/, '').trim();
    return fetch('/cartes/' + encodeURIComponent(cardId) + '/adresse', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Aucune adresse enregistrée pour cette histoire.');
        return response.json();
      })
      .then(function (body) {
        if (select.value !== cardId) return;
        story = { cardId: cardId, url: body.url, title: title };
        armWrite();
      })
      .catch(function (error) {
        log(nfc.problem(error.message, 'Relève-la sur le passeur (bouton ci-dessus).'));
      });
  }

  function selectStory(identity, url) {
    story = { cardId: identity.cardId, url: url, title: identity.title };
    var option = null;
    for (var i = 0; i < select.options.length; i += 1) {
      if (select.options[i].value === identity.cardId) option = select.options[i];
    }
    if (!option) {
      option = document.createElement('option');
      option.value = identity.cardId;
      select.appendChild(option);
    }
    option.textContent = identity.title || identity.cardId;
    select.value = identity.cardId;
    armWrite();
  }

  select.addEventListener('change', function () { choose(select.value); });

  /* ── 1. Relever le passeur (lecture seule) ──────────────────────────────── */

  relBtn.addEventListener('click', function () {
    relBtn.disabled = true;
    say(relStatus, 'Pose le passeur contre le dos du téléphone…', true);
    nfc.scanOnce({
      onReading: function (event) {
        relBtn.disabled = false;
        say(relStatus, '');
        var uid = event.serialNumber || '';
        var url = nfc.urlFrom(event.message);
        if (!nfc.parseYoto(url)) {
          log(nfc.problem('Cette carte ne porte pas d’adresse Yoto.',
            'Relève le passeur (carte MYO officielle) relié à une histoire dans l’app Yoto.'));
          return;
        }
        if (uid && uid !== passeur) {
          log(nfc.problem('Ce n’est pas le passeur enregistré.',
            'Pose ta carte MYO officielle. Pour en changer, utilise « changer de passeur » plus bas.'));
          return;
        }
        post('/cartes/releve', { url: url, uid: uid || passeur }).then(function (identity) {
          selectStory(identity, url);
          var bad = identity.notes.some(function (note) { return note.kind === 'error'; });
          var head = '';
          if (!bad && targetCard && identity.cardId !== targetCard) {
            head = nfc.verdict('warn', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
              + '. Ce n’est pas l’histoire du projet ouvert.</p>');
          } else if (!bad) {
            head = nfc.verdict('ok', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
              + '. Retire-le, puis passe à l’étape 2.</p>');
          }
          log(head + nfc.notes(identity.notes));
        }, function (error) {
          log(nfc.problem('Le passeur n’a pas pu être relevé.', 'Repose-le dans un instant.', error.message));
        });
      },
      onUnreadable: function () {
        relBtn.disabled = false;
        say(relStatus, '');
        log(nfc.problem(nfc.UNREADABLE.text, 'Pose bien le passeur (carte MYO officielle).'));
      },
      onFailure: function (error) {
        relBtn.disabled = false;
        say(relStatus, '');
        log(nfc.explained(error, 'scan'));
      },
    });
  });

  /* ── 2. Écrire sur une vierge (écriture seule, aucun scan concurrent) ────── */

  writeBtn.addEventListener('click', function () {
    if (!story) {
      log(nfc.problem('Choisis d’abord une histoire.', 'Prends-la dans la liste, ou relève le passeur.'));
      return;
    }
    var copy = story;
    writeBtn.disabled = true;
    writeBtn.classList.add('is-busy');
    say(writeStatus, 'Pose la vierge et ne bouge plus…', true);
    new NDEFReader().write({ records: [{ recordType: 'url', data: copy.url }] })
      .then(function () {
        return post('/cartes/encoder', { url: copy.url, uid: '' });
      })
      .then(function (body) {
        say(writeStatus, '');
        writeBtn.disabled = false;
        writeBtn.classList.remove('is-busy');
        log(nfc.verdict('ok', '<p><strong>Copie prête :</strong> ' + titleOf(copy)
          + (body.tags > 1 ? ' — ' + body.tags + ' copies en tout' : '') + '. Retire-la. Pour une '
          + 'autre, pose une nouvelle vierge et rappuie sur « Écrire ».</p>'
          + '<p>Vérifie-la avec « Lire une carte », et pour qu’elle joue, voir « Pour qu’une copie '
          + 'joue » plus bas.</p>'));
      }, function (error) {
        say(writeStatus, '');
        writeBtn.disabled = false;
        writeBtn.classList.remove('is-busy');
        if (error && error.name && error.name !== 'Error') {
          // Presque toujours une puce neuve pas encore formatée : on le dit en grand, d'abord.
          log(nfc.formatReminder() + nfc.explained(error, 'write'));
        } else {
          log(nfc.problem('Carte écrite, mais le serveur n’a pas noté la copie.',
            'Elle fonctionne quand même. Recharge la page si ça se répète.', error && error.message));
        }
      });
  });

  choose(select.value);
})();
