/* Lire et vérifier une carte : ce que porte la puce, l'histoire qu'elle joue, ce qui cloche.

   Le scan reste ouvert : on pose les cartes l'une après l'autre, chacune remplace le rapport de
   la précédente. Rien n'est écrit, ni sur la puce ni côté serveur. */
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

  function chipTable(uid, records, url) {
    var rows = '<dt>puce</dt><dd>' + esc(uid || '(uid non exposé par le téléphone)') + '</dd>'
      + '<dt>contenu</dt><dd>' + (records.length
        ? records.map(function (r) { return esc(r.type) + ' : ' + esc(r.text); }).join('<br>')
        : '(aucun enregistrement)') + '</dd>';
    if (url) {
      var bytes = nfc.tagBytes(url);
      rows += '<dt>occupation</dt><dd>' + bytes + ' / ' + capacity + ' octets</dd>';
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
          'Réencode-la depuis « Encoder une carte vierge » : l’écriture remplace son contenu.');
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
      var head = bad
        ? ''
        : nfc.verdict('ok', '<p><strong>Carte valide.</strong> Elle joue '
            + (identity.title ? '« ' + esc(identity.title) + ' »' : 'le contenu ' + esc(found.cardId))
            + '.</p>');
      reportEl.innerHTML = head + nfc.story(identity) + nfc.notes(identity.notes) + extra
        + chipTable(uid, records, url);
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
