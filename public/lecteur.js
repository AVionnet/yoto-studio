/* Lire et vérifier une carte : ce que porte la puce, l'histoire qu'elle joue, ce qui cloche.

   Le scan reste ouvert : on pose les cartes l'une après l'autre, chacune remplace le rapport de
   la précédente. Rien n'est écrit sur la puce ; on peut seulement lui donner un nom, ce qui
   l'ajoute aux copies si on ne la connaissait pas. */
(function () {
  var root = document.getElementById('lecteur');
  var nfc = window.YotoNfc;
  if (!root || !nfc) return;

  var capacity = Number(root.dataset.capacity) || 48;
  var unsupported = document.getElementById('indispo');
  var scanBtn = document.getElementById('scanner');
  var statusEl = document.getElementById('etat');
  var reportEl = document.getElementById('rapport');
  var esc = nfc.esc;

  if (!nfc.supported) {
    unsupported.hidden = false;
    scanBtn.disabled = true;
    return;
  }

  var controller = null;
  /* Une carte laissée en place se relit en boucle : on ignore la même puce pendant un instant. */
  var last = { uid: '', at: 0 };

  function say(text, pulsing) {
    statusEl.textContent = text;
    statusEl.className = pulsing ? 'status pulse' : 'status';
  }

  function waiting() {
    say('Pose une carte à plat contre le dos du téléphone…', true);
  }

  /* Nommer la puce qu'on tient : « la rouge ». Le passeur et une puce sans numéro ne se nomment
     pas ici — l'un se gère à part, l'autre ne se distingue pas. */
  function nameForm(identity, uid) {
    if (!uid || identity.passeur) return '';
    var known = Boolean(identity.chip);
    return '<form class="inline name-chip" data-uid="' + esc(uid) + '" data-card="' + esc(identity.cardId) + '">'
      + '<input name="name" maxlength="60" required placeholder="Nom de cette carte" '
      + 'aria-label="Nom de cette carte" value="' + esc(known ? identity.cardName || '' : '') + '">'
      + '<button type="submit">' + (known ? 'Renommer' : 'Nommer et garder') + '</button></form>'
      + (known ? '' : '<p class="muted">Cette puce n’est pas encore dans tes copies : la nommer '
        + 'l’y ajoute.</p>');
  }

  reportEl.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.dataset || !form.dataset.uid) return;
    event.preventDefault();
    var name = form.elements.name.value.trim();
    fetch('/cartes/copies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ uid: form.dataset.uid, cardId: form.dataset.card, name: name }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Le serveur a refusé.');
        form.outerHTML = nfc.verdict('ok', '<p>Carte nommée <strong>« ' + esc(name) + ' »</strong>.</p>');
      });
    }).catch(function (error) {
      form.insertAdjacentHTML('afterend', nfc.problem('Le nom n’a pas été enregistré.',
        'Réessaie dans un instant.', error.message));
    });
  });

  function chipTable(uid, records, url) {
    var found = url ? nfc.parseYoto(url) : null;
    var rows = '';
    // L'identifiant du contenu porté par la carte : c'est lui qui dit quelle histoire elle joue.
    if (found) {
      rows += '<dt>identifiant</dt><dd><strong><code>' + esc(found.cardId) + '</code></strong></dd>';
    }
    rows += '<dt>puce</dt><dd><code>' + esc(uid || '(uid non exposé par le téléphone)') + '</code></dd>';
    rows += '<dt>contenu brut</dt><dd>' + (records.length
      ? records.map(function (r) { return esc(r.type) + ' : ' + esc(r.text); }).join('<br>')
      : '(aucun enregistrement)') + '</dd>';
    if (url) {
      rows += '<dt>occupation</dt><dd>' + nfc.tagBytes(url) + ' / ' + capacity + ' octets</dd>';
    }
    return '<dl class="kv">' + rows + '</dl>';
  }

  function render(event) {
    var uid = event.serialNumber || '';
    var records = nfc.describeRecords(event.message);
    var url = nfc.urlFrom(event.message);
    var found = url ? nfc.parseYoto(url) : null;

    if (!found) {
      var verdict;
      if (records.length === 0) {
        verdict = nfc.verdict('warn', '<p><strong>Carte vide.</strong> Elle est formatée mais ne '
          + 'porte aucune adresse : elle ne jouera rien.</p><p><strong>Comment corriger :</strong> '
          + 'c’est une vierge prête à servir — <a href="/cartes/encoder">encode-la</a>.</p>');
      } else {
        verdict = nfc.problem(url
            ? 'Cette carte porte une adresse, mais pas une adresse Yoto : le lecteur l’ignorera.'
            : 'Cette carte ne porte pas d’adresse.',
          'Réencode-la depuis « Fabriquer une carte » : l’écriture remplace son contenu.');
      }
      reportEl.innerHTML = verdict
        + chipTable(uid, records, url);
      return;
    }

    var extra = records.length > 1
      ? nfc.verdict('warn', '<p><strong>La puce porte ' + records.length + ' enregistrements.'
          + '</strong> Une carte Yoto n’en porte qu’un : le lecteur peut ne pas la reconnaître.</p>'
          + '<p><strong>Comment corriger :</strong> réencode-la, l’écriture ne garde que l’adresse.</p>')
      : '';

    reportEl.innerHTML = '<div class="story-pending muted">Recherche de l’histoire <code>'
      + esc(found.cardId) + '</code>…</div>' + chipTable(uid, records, url);

    nfc.identify(url, uid).then(function (identity) {
      if (last.uid !== uid) return; // une autre carte a été posée entretemps
      var bad = identity.notes.some(function (note) { return note.kind === 'error'; });
      var name = identity.title ? '« ' + esc(identity.title) + ' »' : 'le contenu ' + esc(found.cardId);
      var head = '';
      var card = identity.cardName ? 'la carte « ' + esc(identity.cardName) + ' » porte ' : '';
      if (identity.passeur) {
        head = nfc.verdict('ok', '<p><strong>C’est ton passeur.</strong> Il porte ' + name + '.</p>');
      } else if (!bad) {
        // Une copie porte la bonne adresse, mais ne joue que sur un lecteur qui a l'histoire.
        head = nfc.verdict('ok', '<p><strong>Adresse correcte :</strong> ' + card + name + '.</p>'
          + '<p>Elle jouera sur un lecteur qui a déjà téléchargé l’histoire — pas dans l’app '
          + 'Yoto du téléphone.</p>') + nfc.chipWarning(uid);
      }
      reportEl.innerHTML = head + nfc.story(identity) + nameForm(identity, uid)
        + nfc.notes(identity.notes) + extra + chipTable(uid, records, url);
    }).catch(function (error) {
      if (last.uid !== uid) return;
      reportEl.innerHTML = nfc.verdict('ok', '<p>Adresse Yoto <code>' + esc(found.cardId)
          + '</code> bien lue.</p>')
        + nfc.problem('Impossible de retrouver l’histoire associée.',
          'Recharge la page (session expirée ?) puis relis la carte.', error.message)
        + extra + chipTable(uid, records, url);
    });
  }

  function stop() {
    if (controller) controller.abort();
    controller = null;
    scanBtn.textContent = 'Lire une carte';
    say('');
  }

  scanBtn.addEventListener('click', function () {
    if (controller) { stop(); return; }

    var reader = new NDEFReader();
    controller = new AbortController();
    var current = controller;
    reader.addEventListener('reading', function (event) {
      var uid = event.serialNumber || '';
      var now = Date.now();
      if (uid && uid === last.uid && now - last.at < 2000) return;
      last = { uid: uid, at: now };
      say('Carte lue. Pose la suivante, ou appuie sur « Arrêter ».');
      render(event);
    });
    reader.addEventListener('readingerror', function () {
      last = { uid: '', at: Date.now() };
      reportEl.innerHTML = nfc.problem(nfc.UNREADABLE.text, nfc.UNREADABLE.fix);
    });
    reader.scan({ signal: current.signal }).then(function () {
      if (controller !== current) return;
      scanBtn.textContent = 'Arrêter la lecture';
      waiting();
    }, function (error) {
      if (controller === current) controller = null;
      scanBtn.textContent = 'Lire une carte';
      say('');
      reportEl.innerHTML = nfc.explained(error, 'scan');
    });
  });
})();
