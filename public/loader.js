/* Une barre en haut de l'écran pendant qu'une page se charge : sur le téléphone, rien ne montre
   sinon que le lien a été suivi, et on retouche. Elle n'apparaît qu'après un court délai, pour ne
   pas clignoter quand la page arrive tout de suite. */
(function () {
  var bar = document.createElement('div');
  bar.className = 'page-loader';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  var timer = null;

  function show() {
    clearTimeout(timer);
    timer = setTimeout(function () { bar.classList.add('is-on'); }, 150);
  }

  function hide() {
    clearTimeout(timer);
    bar.classList.remove('is-on');
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    var url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    // Une ancre dans la même page ne charge rien.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
    show();
  });

  // En phase de bouillonnement : un formulaire que son script retient (confirmation refusée,
  // envoi en fetch) a déjà appelé preventDefault quand l'événement arrive ici.
  document.addEventListener('submit', function (event) {
    if (!event.defaultPrevented && !event.target.target) show();
  });

  // Retour arrière : la page sort du cache telle qu'on l'a quittée, barre comprise.
  window.addEventListener('pageshow', hide);
})();
