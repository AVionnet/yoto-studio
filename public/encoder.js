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

  /* ── L'atelier : relever le passeur, puis écrire des cartes ────────────────
     Jamais deux opérations NFC à la fois : un scan actif garde la connexion à la puce, et write()
     échouerait avec « IO error ». Pour écrire, on lit la carte, on coupe la lecture, puis on écrit
     avec un lecteur neuf tant qu'elle est encore posée. */

  var root = document.getElementById('atelier');
  if (!root) return;

  var passeur = root.dataset.passeur;
  var targetCard = root.dataset.targetCard || '';
  var projet = root.dataset.projet || '';
  var select = document.getElementById('histoire');
  var relBtn = document.getElementById('relever');
  var relStatus = document.getElementById('etat-relever');
  var writePanel = document.getElementById('panneau-ecrire');
  var changeBtn = document.getElementById('changer');
  var writeBtn = document.getElementById('ecrire');
  var writeStatus = document.getElementById('etat-ecrire');
  var consigne = document.getElementById('consigne');
  var journal = document.getElementById('journal');

  if (!nfc.supported) {
    unsupported.hidden = false;
    relBtn.disabled = true;
    changeBtn.disabled = true;
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
    consigne.innerHTML = 'Prête à copier ' + titleOf(story) + '. Appuie sur « Écrire sur une '
      + 'carte », pose la carte, et garde-la immobile jusqu’au message.';
    changeBtn.disabled = false;
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

  /* ── 1. Relever le passeur ─────────────────────────────────────────────────
     Depuis le bouton « Relever », ou en posant le passeur pendant une écriture : son histoire
     devient celle à copier. */

  function releve(url, uid) {
    return post('/cartes/releve', { url: url, uid: uid || passeur, projet: projet || undefined }).then(function (identity) {
      selectStory(identity, url);
      // Le serveur a rattaché le projet ouvert à cette histoire : c'est désormais sa cible.
      if (projet && identity.project && String(identity.project.id) === projet) targetCard = identity.cardId;
      var bad = identity.notes.some(function (note) { return note.kind === 'error'; });
      var head = '';
      if (!bad && (targetCard || projet) && identity.cardId !== targetCard) {
        head = nfc.verdict('warn', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
          + '. Ce n’est pas l’histoire du projet ouvert.</p>');
      } else if (!bad) {
        head = nfc.verdict('ok', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
          + '. Retire-le, puis pose la carte à écrire.</p>');
      }
      log(head + nfc.notes(identity.notes));
      return identity;
    }, function (error) {
      log(nfc.problem('Le passeur n’a pas pu être relevé.', 'Repose-le dans un instant.', error.message));
      return null;
    });
  }

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
        releve(url, uid);
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

  /* ── 2. Écrire une carte ───────────────────────────────────────────────── */

  function busy(on) {
    changeBtn.disabled = on;
    writeBtn.disabled = on;
    if (on) changeBtn.classList.add('is-busy');
    else changeBtn.classList.remove('is-busy');
  }

  /* Écrit l'histoire choisie sur la carte posée, avec un lecteur neuf. `uid` et `previous` (ce
     qu'elle portait) ne sont connus que si la carte a pu être lue avant. */
  function writeCard(uid, previous) {
    var copy = story;
    say(writeStatus, 'Écriture… ne bouge pas la carte.', true);
    new NDEFReader().write({ records: [{ recordType: 'url', data: copy.url }] })
      .then(function () {
        return post('/cartes/encoder', { url: copy.url, uid: uid, previous: previous || undefined });
      })
      .then(function (body) {
        say(writeStatus, '');
        busy(false);
        var card = body.tag && body.tag.name ? '« ' + esc(body.tag.name) + ' »' : 'la carte';
        var head = body.replaced
          ? '<p><strong>Carte réécrite :</strong> ' + card + ' passe de « ' + esc(body.replaced)
            + ' » à ' + titleOf(copy)
          : '<p><strong>Copie prête :</strong> ' + card + ' porte ' + titleOf(copy);
        log(nfc.verdict('ok', head
          + (body.tags > 1 ? ' — ' + body.tags + ' cartes en tout' : '') + '. Retire-la. Pour une '
          + 'autre, rappuie sur « Écrire » et pose la carte suivante.</p>'
          + nameForm(body.tag)
          + '<p>Pour qu’elle joue, voir « Pour qu’une copie joue » plus bas.</p>'));
      }, function (error) {
        say(writeStatus, '');
        busy(false);
        if (error && error.name && error.name !== 'Error') {
          // Une carte qui s'est lue est déjà formatée : l'échec vient d'un mouvement, pas du format.
          log((uid ? '' : nfc.formatReminder()) + nfc.explained(error, 'write'));
        } else {
          log(nfc.problem('Carte écrite, mais le serveur n’a pas noté la copie.',
            'Elle fonctionne quand même. Recharge la page si ça se répète.', error && error.message));
        }
      });
  }

  /* Nommer la carte qu'on vient d'écrire, tant qu'on l'a en main : « la rouge ». Seule une puce
     reconnue à son numéro se nomme, les autres ne se distinguent pas. */
  function nameForm(tag) {
    if (!tag) return '';
    return '<form class="inline" data-tag="' + tag.id + '">'
      + '<input name="name" maxlength="60" value="' + esc(tag.name || '') + '" '
      + 'placeholder="Nom de cette carte" aria-label="Nom de cette carte">'
      + '<button class="link" type="submit">Nommer</button></form>';
  }

  journal.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.dataset || !form.dataset.tag) return;
    event.preventDefault();
    var name = form.elements.name.value.trim();
    post('/cartes/copies/' + form.dataset.tag + '/nom', { name: name }).then(function () {
      form.outerHTML = '<p>Carte nommée <strong>« ' + esc(name) + ' »</strong>.</p>';
    }, function (error) {
      log(nfc.problem('Le nom n’a pas été enregistré.', 'Réessaie, ou nomme-la depuis Cartes.', error.message));
    });
  });

  /* Ce qu'une carte porte d'autre qu'un enregistrement vide (puce formatée sans contenu). */
  function hasContent(message) {
    return message.records.some(function (record) { return record.recordType !== 'empty'; });
  }

  /* L'uid d'une carte qui porte autre chose qu'une histoire Yoto : la reposer confirme l'écrasement. */
  var overwrite = '';

  changeBtn.addEventListener('click', function () {
    if (!story) {
      log(nfc.problem('Choisis d’abord une histoire.', 'Prends-la dans la liste, ou relève le passeur.'));
      return;
    }
    busy(true);
    say(writeStatus, 'Pose la carte à écrire contre le dos du téléphone…', true);
    var reader = new NDEFReader();
    var controller = new AbortController();
    var pending = false;
    var passeurUrl = '';

    reader.addEventListener('reading', function (event) {
      if (pending) return;
      var uid = event.serialNumber || '';
      var url = nfc.urlFrom(event.message);
      var found = nfc.parseYoto(url);

      // Le passeur : on relève son histoire au lieu de l'écraser, et on attend la carte à écrire.
      if (uid && uid === passeur) {
        if (!found || url === passeurUrl) return;
        passeurUrl = url;
        pending = true;
        say(writeStatus, 'Passeur reconnu, relevé en cours…', true);
        releve(url, uid).then(function () {
          pending = false;
          say(writeStatus, 'Retire le passeur, puis pose la carte à écrire…', true);
        });
        return;
      }

      controller.abort();
      if (found && url === story.url) {
        say(writeStatus, '');
        busy(false);
        if (uid) post('/cartes/encoder', { url: url, uid: uid }).catch(function () {});
        log(nfc.verdict('ok', '<p><strong>Rien à écrire :</strong> cette carte porte déjà '
          + titleOf(story) + '.</p>'));
        return;
      }
      if (!found && hasContent(event.message) && (!uid || uid !== overwrite)) {
        overwrite = uid;
        say(writeStatus, '');
        busy(false);
        log(nfc.verdict('warn', '<p><strong>Cette carte porte autre chose qu’une histoire Yoto</strong> ('
          + esc(nfc.describeRecords(event.message).map(function (r) { return r.text; }).join(', '))
          + ').</p><p>Pour l’écraser quand même, rappuie sur « Écrire » et repose-la.</p>'));
        return;
      }
      overwrite = '';
      writeCard(uid, found ? url : '');
    });

    // Une puce qui ne se lit pas est souvent neuve : on tente l'écriture, qui dira s'il faut formater.
    reader.addEventListener('readingerror', function () {
      if (pending) return;
      controller.abort();
      writeCard('', '');
    });

    reader.scan({ signal: controller.signal }).catch(function (error) {
      controller.abort();
      say(writeStatus, '');
      busy(false);
      log(nfc.explained(error, 'scan'));
    });
  });

  /* Le recours : écrire sans lire, pour une puce que le téléphone ne lit pas du tout. */
  writeBtn.addEventListener('click', function () {
    if (!story) {
      log(nfc.problem('Choisis d’abord une histoire.', 'Prends-la dans la liste, ou relève le passeur.'));
      return;
    }
    busy(true);
    writeCard('', '');
  });

  choose(select.value);
})();
