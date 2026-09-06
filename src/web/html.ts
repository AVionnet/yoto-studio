/** Rendu HTML minimal : echappement par defaut, gabarit unique. */

export type Html = { readonly __html: string };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escape = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);

/** Marque une chaine comme deja sure. A n'utiliser que sur du HTML qu'on a produit. */
export const raw = (value: string): Html => ({ __html: value });

const render = (value: unknown): string => {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'object' && '__html' in (value as Html)) return (value as Html).__html;
  return escape(value);
};

/** Gabarit balise : `html`<p>${valeur}</p>`` echappe tout ce qui n'est pas passe par raw(). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + (strings[i + 1] ?? '');
  return raw(out);
}

/** Note de musique du badge. Inline plutôt qu'en fichier : une requête de moins. */
const NOTE_ICON =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

const EXIT_ICON =
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 12H4m0 0l4-4m-4 4l4 4"/>' +
  '<path d="M11 5V4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-1"/></svg>';

export interface LayoutOptions {
  title: string;
  /** Onglet actif dans la navigation. */
  nav?: string;
  /** Masque la navigation (page de connexion). */
  bare?: boolean;
}

export function layout(options: LayoutOptions, body: Html): string {
  // Un projet EST une carte : les separer creait deux entrees pour la meme chose.
  const tabs: [string, string, string][] = [
    ['cards', '/', 'Cartes'],
    ['settings', '/reglages', 'Réglages'],
  ];

  // Sur l'ecran de connexion il n'y a rien a naviguer et rien a deconnecter : l'en-tete
  // n'aurait qu'une fonction decorative, et le panneau porte deja le nom de l'application.
  const nav = options.bare
    ? ''
    : `<nav>${tabs
        .map(
          ([key, href, label]) =>
            `<a href="${href}"${options.nav === key ? ' aria-current="page"' : ''}>${label}</a>`,
        )
        .join('')}</nav>
      <form method="post" action="/deconnexion" class="logout">
        <button type="submit" title="Se déconnecter de l'application"
                aria-label="Se déconnecter">${EXIT_ICON}</button>
      </form>`;

  const header = `<header>
  <a class="brand" href="/">
    <span class="brand-badge" aria-hidden="true">${NOTE_ICON}</span>
    <span>
      <span class="brand-name">Yoto Studio</span>
      <span class="brand-tag">Des cartes à écouter, faites maison</span>
    </span>
  </a>
  ${nav}
</header>`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)} — Yoto Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;600;700&display=swap">
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
${options.bare ? '' : header}
<main${options.bare ? ' class="centered"' : ''}>${body.__html}</main>
</body>
</html>`;
}
