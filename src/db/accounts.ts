/** Les comptes de l'application, et les reglages propres a chacun. */
import { currentAccountId } from '../accounts/context.ts';
import { db, getSetting } from './index.ts';

export interface Account {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

/** 3 a 40 caracteres : lettres, chiffres, point, tiret, souligne. */
export const USERNAME_PATTERN = /^[\p{L}\p{N}._-]{3,40}$/u;

export function countAccounts(): number {
  return (db().prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
}

export function getAccount(id: number): Account | undefined {
  return db().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function findAccount(username: string): Account | undefined {
  return db().prepare('SELECT * FROM accounts WHERE username = ?').get(username.trim()) as
    | Account
    | undefined;
}

/** Les tables de donnees, toutes cloisonnees par account_id. */
const OWNED_TABLES = ['projects', 'cards', 'card_tags', 'jobs'] as const;

/** Les reglages d'avant les comptes, repris par le premier. */
const LEGACY_SETTINGS = ['yoto.tokens', 'passeur_uid'] as const;

/**
 * Cree un compte. Le tout premier reprend ce qui existait avant les comptes : histoires, contenus,
 * copies, travaux en file, et la connexion Yoto deja etablie — une mise a jour ne doit rien perdre.
 * Rend undefined si l'identifiant est deja pris.
 */
export function createAccount(username: string, passwordHash: string): number | undefined {
  return db().transaction((): number | undefined => {
    if (findAccount(username)) return undefined;
    const first = countAccounts() === 0;
    const id = Number(
      db()
        .prepare('INSERT INTO accounts (username, password_hash) VALUES (?, ?)')
        .run(username.trim(), passwordHash).lastInsertRowid,
    );
    if (first) {
      for (const table of OWNED_TABLES) {
        db().prepare(`UPDATE ${table} SET account_id = ? WHERE account_id IS NULL`).run(id);
      }
      for (const key of LEGACY_SETTINGS) {
        const value = getSetting(key);
        if (value !== undefined) writeSetting(id, key, value);
        db().prepare('DELETE FROM settings WHERE key = ?').run(key);
      }
    }
    return id;
  })();
}

export function setPasswordHash(id: number, passwordHash: string): void {
  db().prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/**
 * Efface un compte et, en cascade, tout ce qu'il possede ici. Les sessions ouvertes ailleurs
 * tombent d'elles-memes : requireAuth ne reconnait plus le compte. Rend les projets supprimes,
 * pour que l'appelant efface leurs fichiers de travail.
 */
export function deleteAccount(id: number): number[] {
  return db().transaction(() => {
    const projects = (
      db().prepare('SELECT id FROM projects WHERE account_id = ?').all(id) as { id: number }[]
    ).map((row) => row.id);
    db().prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return projects;
  })();
}

// --- Reglages du compte courant : jetons Yoto, passeur ---

function writeSetting(accountId: number, key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO account_settings (account_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (account_id, key) DO UPDATE
         SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(accountId, key, value);
}

export function getAccountSetting(key: string): string | undefined {
  const row = db()
    .prepare('SELECT value FROM account_settings WHERE account_id = ? AND key = ?')
    .get(currentAccountId(), key) as { value: string } | undefined;
  return row?.value;
}

export function setAccountSetting(key: string, value: string): void {
  writeSetting(currentAccountId(), key, value);
}

export function deleteAccountSetting(key: string): void {
  db()
    .prepare('DELETE FROM account_settings WHERE account_id = ? AND key = ?')
    .run(currentAccountId(), key);
}
