/* Onglets en amélioration progressive : sans JavaScript les deux panneaux restent visibles et
   le formulaire fonctionne. Le panneau caché voit ses champs désactivés — un champ désactivé
   n'est pas envoyé, ce qui évite qu'une URL oubliée entre en concurrence avec des fichiers. */
(function () {
  document.querySelectorAll('[data-tabs]').forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(group.querySelectorAll('[data-panel]'));
    if (tabs.length === 0) return;

    function select(name) {
      tabs.forEach(function (tab) {
        tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
      });
      panels.forEach(function (panel) {
        var active = panel.dataset.panel === name;
        panel.hidden = !active;
        panel.querySelectorAll('input, select, textarea').forEach(function (field) {
          field.disabled = !active;
        });
      });
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { select(tab.dataset.tab); });
      tab.addEventListener('keydown', function (event) {
        var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        var next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        next.focus();
        select(next.dataset.tab);
      });
    });

    group.classList.add('is-enhanced');
    // Si un champ porte déjà une valeur (retour après erreur), on rouvre son onglet.
    var filled = panels.find(function (panel) {
      return Array.prototype.some.call(panel.querySelectorAll('input'), function (f) {
        return f.value;
      });
    });
    select(filled ? filled.dataset.panel : tabs[0].dataset.tab);
  });
})();
