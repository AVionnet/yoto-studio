/**
 * OAuth Yoto : Authorization Code + PKCE, client public sans secret.
 *
 * Les refresh tokens sont a usage unique — chaque rafraichissement en renvoie un nouveau et
 * invalide l'ancien. Tout le cycle charger-rafraichir-sauver est donc serialise derriere un
 * verrou, et le jeton pivote est persiste AVANT que le nouvel access token soit rendu a
 * l'appelant. Une seule course perdue deconnecte l'utilisateur.
 */
import { createHash, randomBytes } from 'node:crypto';

import { config } from '../config.ts';
import { deleteSetting, getSetting, setSetting } from '../db/index.ts';
import { AuthRequiredError, YotoError, messageFromBody } from './errors.ts';
import type { TokenSet } from './types.ts';

const TOKENS_KEY = 'yoto.tokens';
/** On rafraichit un peu avant l'expiration reelle, pour ne pas courir apres un 401. */
const REFRESH_BUFFER_SECONDS = 30;
/** Duree conservatrice si la reponse omet toute indication d'expiration. */
const FALLBACK_LIFETIME_SECONDS = 300;

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function createState(): string {
  return base64url(randomBytes(16));
}

export function authorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    audience: config.yoto.apiUrl,
    scope: config.yoto.scopes,
    response_type: 'code',
    client_id: config.yoto.clientId,
    redirect_uri: config.yoto.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${config.yoto.authUrl}/authorize?${params}`;
}

/** `exp` du JWT, sans verification de signature : sert seulement a dater l'expiration. */
function expiryFromJwt(accessToken: string): number | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

async function tokenRequest(
  body: Record<string, string>,
  previousRefreshToken?: string,
): Promise<TokenSet> {
  // Un « Confidential Client » doit presenter son secret ; un « Public Client » s'appuie sur
  // le seul PKCE. Les deux formes sont acceptees ici selon la configuration.
  const form = { ...body };
  if (config.yoto.clientSecret) form['client_secret'] = config.yoto.clientSecret;

  const response = await fetch(`${config.yoto.authUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const { message, code } = messageFromBody(payload, `HTTP ${response.status}`);
    if (code === 'invalid_grant') {
      deleteSetting(TOKENS_KEY);
      throw new AuthRequiredError(`Session expiree (jeton de rafraichissement rejete) : ${message}`);
    }
    throw new YotoError(message, response.status, code);
  }

  const accessToken = payload['access_token'];
  if (typeof accessToken !== 'string') {
    throw new YotoError("La reponse ne contient pas d'access_token.");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = payload['expires_in'];
  const expiresAt =
    typeof expiresIn === 'number'
      ? now + expiresIn
      : (expiryFromJwt(accessToken) ?? now + FALLBACK_LIFETIME_SECONDS);

  // Les refresh tokens pivotent : on prefere le nouveau, et on ne retombe sur l'ancien que
  // si la reponse l'omet.
  const rotated = payload['refresh_token'];
  const refreshToken = typeof rotated === 'string' ? rotated : previousRefreshToken;

  return { accessToken, refreshToken, expiresAt };
}

function load(): TokenSet | undefined {
  const raw = getSetting(TOKENS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TokenSet;
  } catch {
    return undefined;
  }
}

function save(tokens: TokenSet): void {
  setSetting(TOKENS_KEY, JSON.stringify(tokens));
}

export function isConnected(): boolean {
  const tokens = load();
  return Boolean(tokens?.refreshToken || (tokens && tokens.expiresAt > Math.floor(Date.now() / 1000)));
}

export function disconnect(): void {
  deleteSetting(TOKENS_KEY);
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: config.yoto.clientId,
    code,
    redirect_uri: config.yoto.redirectUri,
    code_verifier: verifier,
  });
  save(tokens);
  return tokens;
}

/** Serialise tout le cycle charger-rafraichir-sauver. */
let critical: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = critical.then(work, work);
  critical = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function refreshLocked(force: boolean): Promise<string> {
  const tokens = load();
  if (!tokens) throw new AuthRequiredError();

  const now = Math.floor(Date.now() / 1000);
  if (!force && tokens.expiresAt - REFRESH_BUFFER_SECONDS > now) return tokens.accessToken;

  if (!tokens.refreshToken) {
    if (force || tokens.expiresAt <= now) throw new AuthRequiredError();
    return tokens.accessToken;
  }

  const refreshed = await tokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: config.yoto.clientId,
      refresh_token: tokens.refreshToken,
    },
    tokens.refreshToken,
  );

  save(refreshed); // persiste avant de rendre le jeton : le pivot ne doit jamais etre perdu
  return refreshed.accessToken;
}

/** Un jeton valide au moins REFRESH_BUFFER_SECONDS, rafraichi si besoin. */
export function accessToken(): Promise<string> {
  return exclusive(() => refreshLocked(false));
}

/** Chemin reactif apres un 401 : force un rafraichissement unique. */
export function forceRefresh(): Promise<string> {
  return exclusive(() => refreshLocked(true));
}
