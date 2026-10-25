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

  /* ── L'atelier ──────────────────────────────────────────────────────────── */

  var root = document.getElementById('atelier');
  if (!root) return;

  var passeur = root.dataset.passeur;
  var targetCard = root.dataset.targetCard || '';
  var select = document.getElementById('histoire');
  var startBtn = document.getElementById('demarrer');
  var consigne = document.getElementById('consigne');
  var journal = document.getElementById('journal');

  if (!nfc.supported) {
    unsupported.hidden = false;
    startBtn.disabled = true;
    return;
  }

  /* L'histoire à copier : { cardId, url, title }, ou null tant que le passeur n'a pas parlé. */
  var story = null;
  var controller = null;
  var reader = null;
  var running = false;
  var busy = false;
  /* Une carte laissée en place se relit en boucle : on ignore la même puce un instant. */
  var last = { uid: '', at: 0 };
  /* L'uid d'une carte non vierge qu'on a accepté d'écraser au prochain passage. */
  var overwrite = '';

  function log(html) {
    journal.innerHTML = html + journal.innerHTML;
  }

  function titleOf(s) {
    return s.title ? '« ' + esc(s.title) + ' »' : '<code>' + esc(s.cardId) + '</code>';
  }

  function guide() {
    if (!controller) {
      consigne.textContent = 'Appuie sur « Commencer ».';
    } else if (!story) {
      consigne.innerHTML = 'Dans l’app Yoto, relie l’histoire au passeur, puis <strong>pose le '
        + 'passeur</strong> ici.';
    } else {
      consigne.innerHTML = '<strong>Pose une carte vierge</strong> pour y copier ' + titleOf(story)
        + '. Une autre histoire ? Pose le passeur après l’avoir relié.';
    }
  }

  /* ── Choisir l'histoire ─────────────────────────────────────────────────── */

  function choose(cardId) {
    story = null;
    if (!cardId) { guide(); return Promise.resolve(); }
    var title = select.options[select.selectedIndex].textContent.replace(/·.*$/, '').trim();
    return fetch('/cartes/' + encodeURIComponent(cardId) + '/adresse', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Aucune adresse enregistrée pour cette histoire.');
        return response.json();
      })
      .then(function (body) {
        if (select.value !== cardId) return;
        story = { cardId: cardId, url: body.url, title: title };
        guide();
      })
      .catch(function (error) {
        log(nfc.problem(error.message, 'Relie-la au passeur dans l’app Yoto, puis pose le passeur.'));
        guide();
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
    guide();
  }

  select.addEventListener('change', function () { choose(select.value); });

  /* ── Ce qu'on fait de chaque carte posée ────────────────────────────────── */

  function fromPasseur(uid, url) {
    if (!nfc.parseYoto(url)) {
      log(nfc.problem('Le passeur ne porte pas d’adresse Yoto.',
        'Dans l’app Yoto, relie-lui une histoire (« Link to a card »), puis repose-le.'));
      return Promise.resolve();
    }
    return post('/cartes/releve', { url: url, uid: uid }).then(function (identity) {
      selectStory(identity, url);
      var bad = identity.notes.some(function (note) { return note.kind === 'error'; });
      var head = '';
      if (!bad && targetCard && identity.cardId !== targetCard) {
        head = nfc.verdict('warn', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
          + '. Ce n’est pas l’histoire du projet ouvert : relie la bonne au passeur dans l’app '
          + 'Yoto si besoin.</p>');
      } else if (!bad) {
        head = nfc.verdict('ok', '<p><strong>Passeur relevé :</strong> ' + titleOf(identity)
          + '. Retire-le, puis pose une vierge.</p>');
      }
      log(head + nfc.notes(identity.notes));
    }, function (error) {
      log(nfc.problem('Le passeur n’a pas pu être relevé.', 'Repose-le dans un instant.', error.message));
    });
  }

  function write(uid) {
    var copy = story;
    consigne.textContent = 'Écriture… ne bouge pas la carte.';
    // Web NFC n'autorise qu'une opération à la fois : le scan continu tient la puce, et write()
    // sur cette même puce échoue (« IO error »). On arrête le scan, on écrit avec un lecteur neuf,
    // puis on relance le scan pour la carte suivante.
    if (controller) controller.abort();
    controller = null;
    return new NDEFReader().write({ records: [{ recordType: 'url', data: copy.url }] })
      .then(function () { return post('/cartes/encoder', { url: copy.url, uid: uid }); })
      .then(function (body) {
        log(nfc.verdict('ok', '<p><strong>Copie prête :</strong> ' + titleOf(copy)
          + (body.tags > 1 ? ' — ' + body.tags + ' copies en tout' : '') + '. Retire-la, pose la '
          + 'suivante.</p>' + (uid ? '<p class="detail">Puce <code>' + esc(uid) + '</code></p>' : ''))
          + nfc.chipWarning(uid));
      }, function (error) {
        if (error.name && error.name !== 'Error') {
          log(nfc.explained(error, 'write'));
          return;
        }
        log(nfc.problem('Carte écrite, mais le serveur n’a pas noté la copie.',
          'Elle fonctionne quand même. Recharge la page si ça se répète.', error.message));
      })
      .then(function () { if (running) beginScan(); });
  }

  function onCard(uid, message) {
    var url = message ? nfc.urlFrom(message) : '';
    if (uid && uid === passeur) return fromPasseur(uid, url);

    if (!story) {
      log(nfc.problem('Aucune histoire choisie.',
        'Choisis-en une dans la liste, ou pose d’abord le passeur relié à la nouvelle histoire.'));
      return Promise.resolve();
    }
    if (url === story.url) {
      log(nfc.verdict('ok', '<p>Cette carte est <strong>déjà prête</strong> : elle porte '
        + titleOf(story) + '.</p>'));
      return Promise.resolve();
    }
    // Un enregistrement « empty » = puce formatée mais sans contenu : c'est une vierge, on écrit.
    var written = message
      ? nfc.describeRecords(message).filter(function (r) { return r.type !== 'empty'; })
      : [];
    if (written.length > 0 && overwrite !== uid) {
      var found = nfc.parseYoto(url);
      log(nfc.verdict('warn', '<p><strong>Cette carte n’est pas vierge</strong> : elle porte '
        + (found ? 'l’histoire <code>' + esc(found.cardId) + '</code>' : esc(written[0].text))
        + '.</p><p>Pour la remplacer par ' + titleOf(story) + ', '
        + '<button class="link" type="button" data-ecraser="' + esc(uid) + '">autorise la '
        + 'réécriture</button> puis repose-la. Une carte officielle verrouillée refusera.</p>'));
      return Promise.resolve();
    }
    overwrite = '';
    return write(uid);
  }

  journal.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.dataset || target.dataset.ecraser === undefined) return;
    overwrite = target.dataset.ecraser;
    last = { uid: '', at: 0 };
    target.parentNode.innerHTML = 'Réécriture autorisée : repose la carte.';
  });

  function handle(uid, message) {
    var now = Date.now();
    if (busy || (uid && uid === last.uid && now - last.at < 2500)) return;
    last = { uid: uid, at: now };
    busy = true;
    onCard(uid, message).then(function () {
      busy = false;
      last.at = Date.now();
      guide();
    });
  }

  function beginScan() {
    reader = new NDEFReader();
    controller = new AbortController();
    var current = controller;
    reader.addEventListener('reading', function (event) {
      handle(event.serialNumber || '', event.message);
    });
    // Une puce neuve, pas encore formatée NDEF, ne se lit pas — mais s'écrit : Chrome la formate.
    reader.addEventListener('readingerror', function () {
      if (story) handle('', null);
      else log(nfc.problem(nfc.UNREADABLE.text, nfc.UNREADABLE.fix));
    });
    reader.scan({ signal: current.signal }).then(function () {
      if (controller !== current) return;
      startBtn.textContent = 'Terminer';
      guide();
    }, function (error) {
      if (controller === current) controller = null;
      running = false;
      startBtn.textContent = 'Commencer';
      log(nfc.explained(error, 'scan'));
      guide();
    });
  }

  function stop() {
    running = false;
    if (controller) controller.abort();
    controller = null;
    startBtn.textContent = 'Commencer';
    guide();
  }

  startBtn.addEventListener('click', function () {
    if (running) { stop(); return; }
    running = true;
    beginScan();
  });

  choose(select.value);
})();
