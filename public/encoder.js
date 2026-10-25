/* Encodage d'une carte vierge : relever le passeur, voir quelle histoire il porte, la recopier
   sur la vierge, relire pour vérifier.

   Web NFC n'existe que sur Chrome pour Android, en HTTPS — même contrainte que le micro.
   Tout se passe dans le téléphone : le serveur ne reçoit que la trace de ce qui a été écrit.
   Les outils communs (lecture, erreurs expliquées, rendu de l'histoire) viennent de nfc.js. */
(function () {
  var root = document.getElementById('encodeur');
  var nfc = window.YotoNfc;
  if (!root || !nfc) return;

  var capacity = Number(root.dataset.capacity) || 48;
  var targetCard = root.dataset.targetCard || '';
  var targetTitle = root.dataset.targetTitle || '';
  var projet = root.dataset.projet || '';

  var unsupported = document.getElementById('indispo');
  var checkNfc = document.getElementById('chk-nfc');
  var checkPerm = document.getElementById('chk-perm');
  var readBtn = document.getElementById('lire');
  var reuseForm = document.getElementById('reprise');
  var readStatus = document.getElementById('lire-etat');
  var readResult = document.getElementById('lire-resultat');
  var sourcePanel = document.getElementById('source');
  var writePanel = document.getElementById('ecriture');
  var writeBtn = document.getElementById('ecrire');
  var lockBox = document.getElementById('verrou');
  var statusEl = document.getElementById('etat');
  var resultEl = document.getElementById('resultat');

  var esc = nfc.esc;

  /* L'adresse à écrire, une fois relevée : { url, cardId, token, uid, title }. `uid` est celui du
     passeur, pour reconnaître le cas où c'est lui qu'on réécrit au lieu de la vierge. */
  var source = null;

  /* ── Avant de commencer ─────────────────────────────────────────────────── */

  function check(el, ok, text) {
    if (!el) return;
    el.className = '';
    if (ok === true) el.className = 'is-ok';
    if (ok === false) el.className = 'is-ko';
    el.innerHTML = text;
  }

  if (!nfc.supported) {
    unsupported.hidden = false;
    check(checkNfc, false, '<strong>Web NFC absent</strong> — ouvre cette page dans Chrome sur un '
      + 'téléphone Android, en https://.');
    check(checkPerm, null, 'Autorisation NFC : sans objet ici.');
    readBtn.disabled = true;
    writeBtn.disabled = true;
    if (reuseForm) reuseForm.querySelector('button').disabled = true;
    return;
  }

  check(checkNfc, true, '<strong>Web NFC disponible</strong> dans ce navigateur.');
  nfc.permission(function (state) {
    if (state === 'granted') {
      check(checkPerm, true, '<strong>NFC autorisé</strong> pour ce site.');
    } else if (state === 'denied') {
      check(checkPerm, false, '<strong>NFC refusé pour ce site.</strong> Touche le cadenas à gauche '
        + 'de l’adresse → Autorisations → Appareils NFC → Autoriser, puis recharge la page.');
    } else {
      check(checkPerm, null, '<strong>Autorisation NFC :</strong> Chrome la demandera au premier '
        + 'appui sur « Relever le passeur » — réponds « Autoriser ».');
    }
  });

  function say(el, text, pulsing) {
    el.textContent = text;
    el.className = pulsing ? 'status pulse' : 'status';
  }

  /* ── Étape 2 : relever le passeur et dire quelle histoire il porte ─────── */

  function showSource(found) {
    source = found;
    var bytes = nfc.tagBytes(found.url);
    var free = capacity - bytes;

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

    var storyEl = document.getElementById('source-histoire');
    var verdictEl = document.getElementById('source-verdict');
    storyEl.innerHTML = '<p class="muted">Recherche de l’histoire <code>' + esc(found.cardId)
      + '</code>…</p>';
    verdictEl.innerHTML = '';
    sourcePanel.hidden = false;
    writePanel.hidden = true;
    resultEl.innerHTML = '';
    say(statusEl, '');

    if (free < 0) {
      verdictEl.innerHTML = nfc.problem(
        'Cette adresse fait ' + bytes + ' octets : elle ne tient pas sur une carte de '
          + capacity + ' octets.',
        'Il faut une puce plus grande (NTAG213 ou plus) — mais le lecteur Yoto n’accepte peut-être '
          + 'pas un autre modèle que l’Ultralight EV1.');
    }

    return nfc.identify(found.url, found.uid).then(function (identity) {
      if (source !== found) return; // une autre carte a été relevée entretemps
      found.title = identity.title;
      storyEl.innerHTML = nfc.story(identity);

      var head = '';
      if (free < 0) {
        head = verdictEl.innerHTML;
      } else if (targetCard && found.cardId !== targetCard) {
        head = nfc.problem(
          'Le passeur porte ' + (identity.title ? '« ' + identity.title + ' »' : found.cardId)
            + ', pas ' + (targetTitle ? '« ' + targetTitle + ' »' : targetCard) + '.',
          'Dans l’app Yoto, relie « ' + (targetTitle || targetCard) + ' » au passeur (étape 1), '
            + 'puis relève-le de nouveau. Ou encode quand même cette histoire-ci.');
      } else if (!identity.notes.some(function (note) { return note.kind === 'error'; })) {
        head = nfc.verdict('ok', '<p><strong>C’est bon.</strong> Le passeur porte '
          + (identity.title ? '« ' + esc(identity.title) + ' »' : 'cette adresse')
          + ' : passe à l’étape 3 pour la recopier sur la vierge.</p>');
      }
      verdictEl.innerHTML = head + nfc.notes(identity.notes);
    }).catch(function (error) {
      if (source !== found) return;
      storyEl.innerHTML = nfc.story({ cardId: found.cardId, title: null, chapters: [] });
      verdictEl.innerHTML += nfc.problem('Le titre de l’histoire n’a pas pu être retrouvé.',
        'Vérifie que tu es toujours connecté à Yoto Studio (recharge la page). L’adresse relevée '
          + 'reste valable : tu peux l’écrire quand même.', error.message);
    }).then(function () {
      if (source !== found) return;
      writePanel.hidden = false;
      writeBtn.disabled = free < 0;
      writePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  readBtn.addEventListener('click', function () {
    readResult.innerHTML = '';
    readBtn.disabled = true;
    say(readStatus, 'Pose le passeur à plat contre le dos du téléphone…', true);

    nfc.scanOnce({
      onReading: function (event) {
        readBtn.disabled = false;
        say(readStatus, '');
        var found = nfc.parseYoto(nfc.urlFrom(event.message));
        if (!found) {
          sourcePanel.hidden = true;
          writePanel.hidden = true;
          var records = nfc.describeRecords(event.message);
          readResult.innerHTML = records.length === 0
            ? nfc.problem('Cette carte est vide : c’est sans doute une vierge, pas le passeur.',
                'Il faut relever la carte MYO officielle que tu viens de relier dans l’app Yoto. '
                  + 'La vierge, elle, se pose à l’étape 3.')
            : nfc.problem('Cette carte ne porte pas d’adresse Yoto (elle contient : '
                + records.map(function (r) { return r.text; }).join(', ') + ').',
                'Relève la carte MYO officielle reliée à ton histoire dans l’app Yoto.');
          return;
        }
        found.uid = event.serialNumber || '';
        showSource(found);
      },
      onUnreadable: function () {
        say(readStatus, '');
        readResult.innerHTML = nfc.problem(nfc.UNREADABLE.text, 'Si c’est une puce vierge, c’est '
          + 'normal : il faut relever le passeur (la carte MYO officielle), pas la vierge. Sinon, '
          + 'fais glisser la carte lentement sur le dos du téléphone, elle est relue automatiquement.');
      },
      onFailure: function (error) {
        readBtn.disabled = false;
        say(readStatus, '');
        readResult.innerHTML = nfc.explained(error, 'scan');
      },
    });
  });

  if (reuseForm) {
    reuseForm.addEventListener('submit', function (event) {
      event.preventDefault();
      readResult.innerHTML = '';
      var cardId = document.getElementById('connue').value;
      fetch('/cartes/' + encodeURIComponent(cardId) + '/adresse', { headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('Aucune adresse relevée pour cette carte.');
          return response.json();
        })
        .then(function (body) {
          var found = nfc.parseYoto(body.url);
          if (!found) throw new Error("L'adresse enregistrée est illisible.");
          found.uid = '';
          return showSource(found);
        })
        .catch(function (error) {
          readResult.innerHTML = nfc.problem(error.message,
            'Relève plutôt le passeur avec le bouton ci-dessus.');
        });
    });
  }

  /* ── Étape 3 : écrire, vérifier, enregistrer ────────────────────────────── */

  function record(uid) {
    return fetch('/cartes/encoder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: source.url, uid: uid || '', projet: projet }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Le serveur a refusé d’enregistrer cet encodage.');
        return body;
      }, function () {
        throw new Error('Le serveur a refusé d’enregistrer cet encodage (HTTP ' + response.status + ').');
      });
    });
  }

  function idle() {
    say(statusEl, '');
    writeBtn.disabled = false;
    writeBtn.classList.remove('is-busy');
  }

  function done(card, uid, warning) {
    idle();
    var title = source.title || card.nickname;
    resultEl.innerHTML = nfc.verdict('ok',
      '<p><strong>Carte encodée et vérifiée.</strong> Elle joue désormais « ' + esc(title)
      + ' » (<code>' + esc(card.cardId) + '</code>).</p>'
      + '<p>Insère-la dans le lecteur Yoto : au premier passage il télécharge l’histoire, ensuite '
      + 'c’est immédiat. Pour une autre vierge avec la même histoire, rappuie sur « Écrire ».</p>'
      + (uid ? '<p class="detail">Puce <code>' + esc(uid) + '</code>'
        + (card.tags > 1 ? ' · ' + card.tags + ' cartes portent cette histoire' : '') + '</p>' : ''))
      + (warning ? nfc.problem(warning.text, warning.fix, warning.detail) : '');
  }

  function failed(text, fix, detail) {
    idle();
    resultEl.innerHTML = nfc.problem(text, fix, detail);
  }

  /* Après l'écriture on relit : c'est le seul moyen de savoir que la puce a vraiment pris, et
     c'est aussi là qu'on apprend son uid. */
  function verify(lockWarning) {
    say(statusEl, 'Écrit. Vérification : laisse la carte en place — si rien ne bouge, '
      + 'éloigne-la puis représente-la…', true);
    nfc.scanOnce({
      onReading: function (event) {
        var uid = event.serialNumber || '';
        // Web NFC écrit sur la première puce venue : si le passeur traînait encore contre le
        // téléphone, c'est lui qui vient d'être réécrit — avec sa propre adresse, sans dégât.
        if (source.uid && uid && uid === source.uid) {
          failed('C’est le passeur qui a été réécrit, pas la vierge.',
            'Le passeur était encore contre le téléphone quand tu as appuyé sur « Écrire ». '
              + 'Éloigne-le (au moins 10 cm), rappuie sur « Écrire », puis pose la vierge seule.');
          return;
        }
        var readBack = nfc.urlFrom(event.message);
        if (readBack !== source.url) {
          failed('La carte relue ne porte pas l’adresse qui vient d’être écrite.',
            'Elle a sans doute bougé pendant l’écriture, ou c’est une autre carte qui a été relue. '
              + 'Rappuie sur « Écrire » et garde la vierge immobile jusqu’au message.',
            'relu : ' + (readBack ? nfc.maskUrl(readBack) : '(rien)'));
          return;
        }
        record(uid)
          .then(function (card) { done(card, uid, lockWarning); })
          .catch(function (error) {
            failed('La carte est bien écrite, mais le serveur n’a pas enregistré l’encodage.',
              'Elle fonctionne quand même. Recharge la page (session expirée ?) et relis-la avec '
                + '« Lire une carte » pour qu’elle soit retrouvée.', error.message);
          });
      },
      onFailure: function (error) {
        // L'écriture a réussi : on garde la trace, même si la relecture n'a pas pu se faire.
        record('')
          .then(function (card) {
            var e = nfc.explain(error, 'scan');
            done(card, '', {
              text: 'Écrite, mais pas vérifiée : la relecture a échoué. ' + e.text,
              fix: 'Ouvre « Lire une carte » et pose la vierge pour t’assurer qu’elle joue la bonne '
                + 'histoire.',
              detail: e.detail,
            });
          })
          .catch(function (recordError) { failed(recordError.message); });
      },
    });
  }

  writeBtn.addEventListener('click', function () {
    if (!source) return;
    resultEl.innerHTML = '';
    writeBtn.disabled = true;
    writeBtn.classList.add('is-busy');
    say(statusEl, 'Pose maintenant la carte VIERGE contre le dos du téléphone, et ne bouge plus…', true);

    // write() attend une puce sans limite de temps : au bout d'un moment, on aide à la trouver.
    var slow = setTimeout(function () {
      if (writeBtn.disabled) {
        say(statusEl, 'Toujours rien ? Fais glisser la vierge lentement sur le dos du téléphone : la '
          + 'zone NFC est souvent au centre ou près de l’appareil photo.', true);
      }
    }, 15000);

    var reader = new NDEFReader();
    reader.write({ records: [{ recordType: 'url', data: source.url }] })
      .then(function () {
        clearTimeout(slow);
        if (!lockBox.checked) return null;
        // Le verrouillage demande la puce encore dans le champ ; s'il échoue, l'écriture reste
        // valable — on le dit sans annuler le reste.
        return reader.makeReadOnly().then(function () { return null; }, function (error) {
          var e = nfc.explain(error, 'lock');
          return {
            text: 'Écriture faite, mais le verrouillage a échoué. ' + e.text,
            fix: 'La carte fonctionne sans verrou. Pour verrouiller, rappuie sur « Écrire » avec la '
              + 'case cochée en gardant la carte immobile.',
            detail: e.detail,
          };
        });
      })
      .then(function (lockWarning) { verify(lockWarning); })
      .catch(function (error) {
        clearTimeout(slow);
        idle();
        resultEl.innerHTML = nfc.explained(error, 'write');
      });
  });
})();
