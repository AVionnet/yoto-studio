/* Encodage d'une carte vierge : relever une adresse Yoto, la recopier sur la puce, la vérifier.

   Web NFC n'existe que sur Chrome pour Android, en HTTPS — même contrainte que le micro.
   Tout se passe dans le téléphone : le serveur ne reçoit que la trace de ce qui a été écrit. */
(function () {
  var root = document.getElementById('encodeur');
  if (!root) return;

  var capacity = Number(root.dataset.capacity) || 48;
  var targetCard = root.dataset.targetCard || '';
  var projet = root.dataset.projet || '';

  var unsupported = document.getElementById('indispo');
  var readBtn = document.getElementById('lire');
  var reuseForm = document.getElementById('reprise');
  var sourcePanel = document.getElementById('source');
  var writePanel = document.getElementById('ecriture');
  var writeBtn = document.getElementById('ecrire');
  var lockBox = document.getElementById('verrou');
  var statusEl = document.getElementById('etat');
  var resultEl = document.getElementById('resultat');

  /* L'adresse à écrire, une fois relevée : { url, cardId, token }. */
  var source = null;

  if (!('NDEFReader' in window)) {
    unsupported.hidden = false;
    readBtn.disabled = true;
    writeBtn.disabled = true;
    if (reuseForm) reuseForm.querySelector('button').disabled = true;
    return;
  }

  function say(text, pulsing) {
    statusEl.textContent = text;
    statusEl.className = pulsing ? 'status pulse' : 'status';
  }

  function verdict(kind, text) {
    return '<p class="alert ' + kind + '" style="display:block">' + text + '</p>';
  }

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

  /* Une lecture, une seule : on coupe le scan dès la première carte pour ne pas ramasser
     la suivante par surprise. Les écouteurs sont posés avant scan(), jamais après. */
  function scanOnce(onReading, onFailure) {
    var reader = new NDEFReader();
    var controller = new AbortController();
    reader.addEventListener('reading', function (event) {
      controller.abort();
      onReading(event);
    });
    reader.addEventListener('readingerror', function () {
      say('Lecture impossible — représente la carte.');
    });
    reader.scan({ signal: controller.signal }).catch(function (error) {
      controller.abort();
      onFailure(error);
    });
    return controller;
  }

  function nfcError(error) {
    var hint = error.name === 'NotAllowedError'
      ? " Autorise le NFC pour ce site, et vérifie qu'il est activé dans les réglages du téléphone."
      : '';
    resultEl.innerHTML = verdict('error', esc(error.name + ' — ' + error.message) + esc(hint));
  }

  /* ── Étape 1 : d'où vient l'adresse ─────────────────────────────────────── */

  function showSource(found) {
    source = found;
    var bytes = tagBytes(found.url);
    var free = capacity - bytes;
    var mismatch = targetCard && found.cardId !== targetCard;

    document.getElementById('source-verdict').innerHTML = free < 0
      ? verdict('error', 'Cette adresse fait ' + bytes + ' octets : elle ne tient pas sur une '
          + 'carte de ' + capacity + ' octets.')
      : mismatch
        ? verdict('error', 'Attention : cette carte porte le contenu <code>'
            + esc(found.cardId) + '</code>, pas <code>' + esc(targetCard) + '</code>. '
            + 'Relie le bon contenu au passeur dans l’app Yoto, puis relève-la de nouveau.')
        : verdict('ok', 'Adresse relevée. Elle peut être recopiée telle quelle.');

    document.getElementById('source-card').textContent = found.cardId;
    document.getElementById('source-size').textContent =
      bytes + ' / ' + capacity + ' octets' + (free >= 0 ? ' (' + free + ' libres)' : '');

    var tokenEl = document.getElementById('source-token');
    tokenEl.textContent = found.token ? 'masqué — toucher pour afficher' : '(absent)';
    tokenEl.className = 'masked';
    tokenEl.onclick = function () {
      tokenEl.textContent = found.token || '(vide)';
      tokenEl.className = '';
    };

    sourcePanel.hidden = false;
    writePanel.hidden = false;
    writeBtn.disabled = free < 0;
    resultEl.innerHTML = '';
    say('');
    writePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  readBtn.addEventListener('click', function () {
    resultEl.innerHTML = '';
    readBtn.disabled = true;
    say('Approche la carte à relever du dos du téléphone…', true);

    scanOnce(function (event) {
      readBtn.disabled = false;
      say('');
      var found = parseYoto(urlFrom(event.message));
      if (!found) {
        sourcePanel.hidden = true;
        writePanel.hidden = true;
        resultEl.innerHTML = verdict('error',
          "Cette carte ne porte pas d'adresse Yoto. Une puce vierge n'en a pas : il faut relever "
          + 'une carte MYO déjà liée à un contenu dans l’app Yoto.');
        return;
      }
      showSource(found);
    }, function (error) {
      readBtn.disabled = false;
      say('');
      nfcError(error);
    });
  });

  if (reuseForm) {
    reuseForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var cardId = document.getElementById('connue').value;
      fetch('/cartes/' + encodeURIComponent(cardId) + '/adresse', { headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('Aucune adresse relevée pour cette carte.');
          return response.json();
        })
        .then(function (body) {
          var found = parseYoto(body.url);
          if (!found) throw new Error("L'adresse enregistrée est illisible.");
          showSource(found);
        })
        .catch(function (error) {
          resultEl.innerHTML = verdict('error', esc(error.message));
        });
    });
  }

  /* ── Étape 2 : écrire, vérifier, enregistrer ────────────────────────────── */

  function record(uid) {
    return fetch('/cartes/encoder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: source.url, uid: uid || '', projet: projet }),
    }).then(function (response) {
      if (!response.ok) throw new Error('Le serveur a refusé d’enregistrer cet encodage.');
      return response.json();
    });
  }

  function done(card, uid, warning) {
    say('');
    resultEl.innerHTML = verdict('ok',
      '<strong>Carte encodée.</strong> Elle joue désormais « ' + esc(card.nickname) + ' » ('
      + esc(card.cardId) + '). Insère-la dans le lecteur — au premier passage il télécharge le '
      + 'contenu, ensuite c’est immédiat.'
      + (uid ? '<br>Puce <code>' + esc(uid) + '</code>' : '')
      + (card.tags > 1 ? ' · ' + card.tags + ' cartes portent ce contenu' : ''))
      + (warning ? verdict('error', esc(warning)) : '');
    writeBtn.disabled = false;
    writeBtn.classList.remove('is-busy');
  }

  function failed(message) {
    say('');
    writeBtn.disabled = false;
    writeBtn.classList.remove('is-busy');
    resultEl.innerHTML = verdict('error', esc(message));
  }

  /* Après l'écriture on relit : c'est le seul moyen de savoir que la puce a vraiment pris, et
     c'est aussi là qu'on apprend son uid. La carte est en général restée dans le champ. */
  function verify(lockWarning) {
    say('Vérification — garde la carte en place, ou représente-la…', true);
    scanOnce(function (event) {
      var readBack = urlFrom(event.message);
      if (readBack !== source.url) {
        failed("La carte ne renvoie pas l'adresse écrite. Réessaie sans la bouger.");
        return;
      }
      record(event.serialNumber || '')
        .then(function (card) { done(card, event.serialNumber, lockWarning); })
        .catch(function (error) { failed(error.message); });
    }, function (error) {
      // L'écriture a réussi : on garde la trace, même si la relecture n'a pas pu se faire.
      record('')
        .then(function (card) {
          done(card, '', 'Vérification impossible (' + error.name + ') — relis la carte avec la '
            + 'sonde NFC pour t’en assurer.');
        })
        .catch(function (recordError) { failed(recordError.message); });
    });
  }

  writeBtn.addEventListener('click', function () {
    if (!source) return;
    resultEl.innerHTML = '';
    writeBtn.disabled = true;
    writeBtn.classList.add('is-busy');
    say('Approche la carte vierge et garde-la immobile…', true);

    var reader = new NDEFReader();
    reader.write({ records: [{ recordType: 'url', data: source.url }] })
      .then(function () {
        if (!lockBox.checked) return '';
        // Le verrouillage demande la puce encore dans le champ ; s'il échoue, l'écriture reste
        // valable — on le dit sans annuler le reste.
        return reader.makeReadOnly().then(function () { return ''; }, function (error) {
          return 'Écriture faite, mais le verrouillage a échoué (' + error.name + ').';
        });
      })
      .then(function (lockWarning) { verify(lockWarning); })
      .catch(function (error) {
        writeBtn.disabled = false;
        writeBtn.classList.remove('is-busy');
        say('');
        resultEl.innerHTML = verdict('error',
          esc(error.name + ' — ' + error.message)
          + (error.name === 'NotSupportedError' || error.name === 'NotAllowedError'
            ? '<br>Si la puce sort d’usine sans en-tête NDEF, formate-la d’abord avec les deux '
              + 'commandes données plus bas.'
            : ''));
      });
  });
})();
