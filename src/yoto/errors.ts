/**
 * L'enveloppe d'erreur de l'API est {"error": {"code", "message"}} ; les endpoints OAuth
 * utilisent la forme plate RFC 6749 {"error", "error_description"}.
 */

export class YotoError extends Error {
  // Champs declares explicitement : les proprietes de parametre de constructeur ne sont pas
  // supportees par le stripping de types de Node.
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'YotoError';
    this.status = status;
    this.code = code;
  }
}

/** Il faut se (re)connecter : plus aucun jeton exploitable. */
export class AuthRequiredError extends YotoError {
  constructor(message = 'Connexion a Yoto requise.') {
    super(message, 401);
    this.name = 'AuthRequiredError';
  }
}

export class TranscodeTimeoutError extends YotoError {
  constructor(message: string) {
    super(message, undefined, 'transcode_timeout');
    this.name = 'TranscodeTimeoutError';
  }
}

export function messageFromBody(body: unknown, fallback: string): { message: string; code?: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;

    // Enveloppe API : { error: { code, message } }
    const nested = record['error'];
    if (nested && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>;
      const message = typeof inner['message'] === 'string' ? inner['message'] : fallback;
      const code = typeof inner['code'] === 'string' ? inner['code'] : undefined;
      return code ? { message, code } : { message };
    }

    // Forme plate OAuth : { error, error_description }
    if (typeof nested === 'string') {
      const description = record['error_description'];
      return {
        message: typeof description === 'string' ? description : nested,
        code: nested,
      };
    }
  }
  return { message: fallback };
}
