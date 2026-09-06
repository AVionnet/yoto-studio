/* Retour immédiat à la soumission : le serveur met quelques secondes à répondre (lecture de la
   source), et sans signal visible on re-clique. Le garde-fou serveur existe aussi, mais un
   formulaire qui semble inerte est un défaut d'interface avant d'être un problème de doublon. */
(function () {
  document.querySelectorAll('form[data-guard]').forEach(function (form) {
    var submitted = false;

    form.addEventListener('submit', function (event) {
      if (submitted) {
        event.preventDefault();
        return;
      }
      submitted = true;

      var button = form.querySelector('button[type="submit"]');
      if (button) {
        var busy = button.getAttribute('data-busy-label');
        if (busy) button.textContent = busy;
        button.classList.add('is-busy');
        // Un bouton désactivé n'est pas envoyé avec le formulaire ; on le neutralise après
        // que le navigateur a sérialisé les champs.
        setTimeout(function () { button.disabled = true; }, 0);
      }

      var note = form.querySelector('[data-busy-note]');
      if (note) note.hidden = false;

      form.setAttribute('aria-busy', 'true');
    });
  });
})();
