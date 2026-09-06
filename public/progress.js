/* Suit la progression d'un travail via SSE, et recharge la page a la fin pour afficher
   le resultat complet (pistes transcodees, lien vers la carte). */
(function () {
  var root = document.getElementById('etat');
  if (!root || root.dataset.running !== '1') return;

  var source = new EventSource('/projets/' + root.dataset.project + '/flux');
  var message = document.getElementById('message');
  var bar = document.getElementById('barre');

  source.onmessage = function (event) {
    var frame = JSON.parse(event.data);
    if (message) message.textContent = frame.message;
    if (bar) {
      bar.value = frame.progress;
      bar.max = frame.total || 1;
    }
  };

  source.addEventListener('fin', function () {
    source.close();
    window.location.reload();
  });

  // Une coupure reseau ne doit pas laisser la page figee sur un etat perime.
  source.onerror = function () {
    source.close();
    setTimeout(function () { window.location.reload(); }, 3000);
  };
})();
