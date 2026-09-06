/**
 * Client HTTP de l'API Yoto : authentification, rejeu, traduction des erreurs.
 *
 * Politique de rejeu (l'API ne documente aucune limite de debit, donc on est defensif) :
 *  - erreurs de transport : rejouees ; pour POST, uniquement les erreurs de connexion, car un
 *    POST /content qui a atteint le serveur a peut-etre deja cree la carte.
 *  - 502 / 503 / 504 : rejouees pour les methodes idempotentes seulement.
 *  - 429 : rejouee pour toutes les methodes (la requete n'a pas ete traitee), en honorant
 *    Retry-After plafonne a 10 s, deux fois au plus.
 */
import { config } from '../config.ts';
import { AuthRequiredError, YotoError, messageFromBody } from './errors.ts';
import { accessToken, forceRefresh } from './oauth.ts';

const MAX_ATTEMPTS = 5;
const MAX_429_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const backoffMs = (attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8_000);

/** Plafonne dans [0, 10] : une valeur negative ou farfelue ferait exploser le timer. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(Math.max(seconds, 0), 10) * 1000;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: Buffer | Uint8Array;
  contentType?: string;
  /** Statuts a ne pas traiter comme des erreurs — le transcodage repond 202/404 tant qu'il
   *  n'a pas fini. */
  allowedStatuses?: number[];
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, config.yoto.apiUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Requete authentifiee sur api.yotoplay.com. */
export async function request(path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  const url = buildUrl(path, options.query);
  const allowed = new Set(options.allowedStatuses ?? []);

  let token = await accessToken();
  let refreshed = false;
  let rate429 = 0;

  for (let attempt = 1; ; attempt += 1) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
    let payload: string | Uint8Array | undefined;

    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.json);
    } else if (options.body) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
      payload = options.body;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (cause) {
      // Sur POST on ne rejoue que si la connexion n'a jamais abouti : sinon la carte a
      // peut-etre deja ete creee cote serveur.
      const connectFailure = cause instanceof TypeError;
      const mayRetry = method !== 'POST' || connectFailure;
      if (attempt < MAX_ATTEMPTS && mayRetry) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new YotoError(`Echec reseau sur ${method} ${path} : ${(cause as Error).message}`);
    }

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      token = await forceRefresh();
      continue;
    }

    if (response.status === 429 && rate429 < MAX_429_RETRIES) {
      rate429 += 1;
      await response.body?.cancel();
      await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt));
      continue;
    }

    if (
      RETRYABLE_STATUSES.has(response.status) &&
      IDEMPOTENT_METHODS.has(method) &&
      attempt < MAX_ATTEMPTS
    ) {
      await response.body?.cancel();
      await sleep(backoffMs(attempt));
      continue;
    }

    const body = await readBody(response);

    if (response.ok || allowed.has(response.status)) {
      return { status: response.status, headers: response.headers, body };
    }

    const { message, code } = messageFromBody(
      body,
      typeof body === 'string' && body ? body.slice(0, 300) : response.statusText,
    );
    if (response.status === 401) throw new AuthRequiredError(message);
    throw new YotoError(message, response.status, code);
  }
}

/**
 * PUT sur une URL S3 pre-signee. Sans authentification : la signature EST l'authentification,
 * et un en-tete Authorization ferait rejeter la requete.
 */
export async function putSigned(
  url: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new YotoError(`Transfert refuse (HTTP ${response.status}).`, response.status);
    } catch (cause) {
      if (cause instanceof YotoError) throw cause;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new YotoError(`Echec du transfert : ${(cause as Error).message}`);
    }
  }
}
