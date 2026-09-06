/**
 * Configuration, lue une fois au demarrage et validee tout de suite.
 *
 * PUBLIC_BASE_URL est explicite et jamais devine depuis la requete : derriere un reverse
 * proxy l'application voit `localhost` et fabriquerait un redirect_uri que Yoto rejette.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const isProduction = process.env.NODE_ENV === 'production';

/** En dev on tolere un secret ephemere ; en production il doit etre fixe, sinon toutes les
 *  sessions sautent a chaque redemarrage. */
function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SESSION_SECRET doit faire au moins 32 caracteres');
    return fromEnv;
  }
  if (isProduction) throw new Error("SESSION_SECRET est obligatoire en production");
  return randomBytes(32).toString('hex');
}

const publicBaseUrl = optional('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');

export const config = {
  isProduction,
  port: Number(optional('PORT', '3000')),
  publicBaseUrl,
  sessionSecret: sessionSecret(),
  appPassword: isProduction ? required('APP_PASSWORD') : process.env.APP_PASSWORD?.trim() || '',

  dataDir: resolve(optional('DATA_DIR', './data')),
  mediaDir: resolve(optional('MEDIA_DIR', './media')),

  yoto: {
    apiUrl: 'https://api.yotoplay.com',
    authUrl: 'https://login.yotoplay.com',
    clientId: process.env.YOTO_CLIENT_ID?.trim() || '',
    /** Renseigne pour un « Confidential Client », vide pour un « Public Client » (PKCE seul). */
    clientSecret: process.env.YOTO_CLIENT_SECRET?.trim() || '',
    redirectUri: `${publicBaseUrl}/auth/yoto/callback`,
    /**
     * Les scopes `:view` sont demandes explicitement. yoto.dev documente `:manage` comme les
     * incluant, mais l'API impose la chaine litterale sur certains endpoints — observe en direct
     * sur GET /content/{cardId}, qui renvoie 403 sans `user:content:view`.
     */
    /**
     * Yoto n'accepte que les scopes coches dans le portail developpeur : en demander un qui
     * n'y figure pas fait echouer /authorize avec « scopes that have not been pre-approved ».
     * D'ou l'override par YOTO_SCOPES, pour s'aligner sans toucher au code.
     *
     * `offline_access` donne le refresh token. Sans lui la session expire et il faut se
     * reconnecter a la main — voir hasOfflineAccess ci-dessous.
     */
    scopes:
      process.env.YOTO_SCOPES?.trim() ||
      [
        'openid',
        'profile',
        'offline_access',
        'user:content:view',
        'user:content:manage',
        'user:icons:manage',
        'family:library:view',
      ].join(' '),
  },

  deepseek: {
    apiUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || '',
  },

  ytdlp: {
    cookiesFile: process.env.YTDLP_COOKIES_FILE?.trim() || '',
  },
} as const;

/** Vrai si la configuration demande un refresh token. */
export const hasOfflineAccess = config.yoto.scopes.split(/\s+/).includes('offline_access');

export type Config = typeof config;
