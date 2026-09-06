/* Émulateur de lecteur : une seule balise audio, pilotée par la liste des pistes.
   L'enchaînement automatique reproduit `autoadvance: next`, le réglage que l'application
   pose sur toutes les cartes qu'elle publie. */
(function () {
  var audio = document.getElementById('pl-audio');
  var list = document.querySelector('.pl-list');
  if (!audio || !list) return;

  var progress = document.getElementById('pl-progress');
  var now = document.getElementById('pl-now');
  var screen = document.getElementById('pl-screen');
  var tracks = Array.prototype.slice.call(list.querySelectorAll('.pl-track'));
  var current = -1;

  function paint() {
    tracks.forEach(function (row, i) {
      var playing = i === current && !audio.paused;
      row.classList.toggle('is-current', i === current);
      var glyph = row.querySelector('.pl-glyph');
      if (glyph) glyph.textContent = playing ? '❙❙' : '▶';
    });
    if (screen) screen.classList.toggle('is-playing', current >= 0 && !audio.paused);
    if (now) {
      var row = tracks[current];
      now.textContent = row ? row.querySelector('.pl-name').textContent : 'Choisis une piste';
    }
  }

  function play(index) {
    var row = tracks[index];
    if (!row || !row.dataset.src) return;

    if (index === current) {
      // Même piste : on bascule lecture/pause plutôt que de repartir du début.
      if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
      paint();
      return;
    }

    current = index;
    audio.src = row.dataset.src;
    audio.play().catch(function () { paint(); });
    paint();
  }

  tracks.forEach(function (row, i) {
    var button = row.querySelector('.pl-play');
    if (button && !button.disabled) button.addEventListener('click', function () { play(i); });
  });

  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);

  audio.addEventListener('timeupdate', function () {
    if (!progress || !audio.duration) return;
    progress.style.width = (audio.currentTime / audio.duration) * 100 + '%';
  });

  audio.addEventListener('ended', function () {
    if (progress) progress.style.width = '0%';
    // Piste suivante jouable, en sautant celles dont le fichier a disparu.
    for (var i = current + 1; i < tracks.length; i += 1) {
      if (tracks[i].dataset.src) { play(i); return; }
    }
    current = -1;
    paint();
  });

  audio.addEventListener('error', function () {
    if (now) now.textContent = 'Lecture impossible pour cette piste.';
  });

  // Barre cliquable : on se déplace dans la piste en cours.
  var bar = document.querySelector('.player-track');
  if (bar) {
    bar.addEventListener('click', function (event) {
      if (!audio.duration) return;
      var box = bar.getBoundingClientRect();
      audio.currentTime = ((event.clientX - box.left) / box.width) * audio.duration;
    });
  }
})();
