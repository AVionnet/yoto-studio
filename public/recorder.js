/* Studio d'enregistrement : un MediaRecorder par chapitre, envoyé dès l'arrêt.

   getUserMedia exige un contexte sécurisé : localhost passe, une adresse IP en clair non.
   En production il faut donc du HTTPS — la même contrainte que Web NFC. */
(function () {
  var summary = document.getElementById('rec-summary');
  var unsupported = document.getElementById('rec-unsupported');
  var chapters = Array.prototype.slice.call(document.querySelectorAll('.chapter'));
  if (chapters.length === 0) return;

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    if (unsupported) {
      unsupported.hidden = false;
      unsupported.textContent = window.isSecureContext
        ? "Ce navigateur ne sait pas enregistrer de son. Essaie Chrome, Firefox ou Safari récent."
        : "L'enregistrement demande une connexion sécurisée (HTTPS). En local, utilise "
          + 'http://localhost plutôt que l’adresse IP.';
    }
    chapters.forEach(function (li) { li.querySelector('.rec-start').disabled = true; });
    return;
  }

  /* Le premier type accepté par le navigateur. Le serveur reconvertit de toute façon en AAC,
     donc le conteneur importe peu — seul compte qu'il y en ait un. */
  function pickType() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  var active = null; // { recorder, stream, li, tick }

  function setState(li, text) {
    var span = li.querySelector('.chapter-state');
    if (span) span.textContent = text;
  }

  function stopStream(stream) {
    stream.getTracks().forEach(function (t) { t.stop(); });
  }

  function upload(li, blob) {
    var index = li.dataset.index;
    var button = li.querySelector('.rec-start');
    var label = li.querySelector('.rec-label');

    label.textContent = 'Envoi…';
    button.disabled = true;
    setState(li, 'conversion…');

    var form = new FormData();
    // Le nom de fichier aide ffmpeg à deviner le conteneur.
    form.append('audio', blob, 'voix.webm');

    fetch(window.location.pathname.replace(/\/enregistrer$/, '') + '/pistes/' + index + '/enregistrement', {
      method: 'POST',
      body: form
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        button.disabled = false;
        if (!res.ok) {
          label.textContent = 'Réessayer';
          setState(li, res.body.error || 'échec');
          return;
        }
        li.dataset.recorded = '1';
        label.textContent = 'Refaire';
        setState(li, 'enregistré');

        var preview = li.querySelector('.rec-preview');
        preview.hidden = false;
        preview.src = res.body.src + '?t=' + Date.now(); // contourne le cache après un refaire

        if (summary) {
          var total = summary.dataset.total;
          summary.textContent = res.body.recorded + ' chapitre(s) enregistré(s) sur ' + total + '.';
          summary.classList.toggle('ok', String(res.body.recorded) === total);
        }
      })
      .catch(function (err) {
        button.disabled = false;
        label.textContent = 'Réessayer';
        setState(li, 'envoi impossible : ' + err.message);
      });
  }

  function stop() {
    if (!active) return;
    clearInterval(active.tick);
    active.recorder.stop(); // le blob arrive dans onstop
    active = null;
  }

  function start(li) {
    var button = li.querySelector('.rec-start');
    var label = li.querySelector('.rec-label');
    var timer = li.querySelector('.rec-timer');

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = pickType();
      var recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      var parts = [];

      recorder.ondataavailable = function (e) { if (e.data.size) parts.push(e.data); };
      recorder.onstop = function () {
        stopStream(stream);
        button.classList.remove('is-recording');
        timer.hidden = true;
        upload(li, new Blob(parts, { type: type || 'audio/webm' }));
      };

      recorder.start();
      button.classList.add('is-recording');
      label.textContent = 'Arrêter';
      setState(li, 'enregistrement…');

      var started = Date.now();
      timer.hidden = false;
      timer.textContent = '0:00';
      var tick = setInterval(function () {
        var s = Math.floor((Date.now() - started) / 1000);
        timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      }, 250);

      active = { recorder: recorder, stream: stream, li: li, tick: tick };
    }).catch(function (err) {
      setState(li, err.name === 'NotAllowedError'
        ? 'micro refusé — autorise-le dans le navigateur'
        : 'micro indisponible : ' + err.message);
    });
  }

  chapters.forEach(function (li) {
    li.querySelector('.rec-start').addEventListener('click', function () {
      if (active && active.li === li) { stop(); return; }
      if (active) stop(); // un seul micro à la fois
      start(li);
    });
  });

  // Quitter la page pendant un enregistrement perdrait la prise sans prévenir.
  window.addEventListener('beforeunload', function (e) {
    if (!active) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
