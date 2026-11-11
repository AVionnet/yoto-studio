/**
 * Mots de passe : scrypt, sel aleatoire par compte, comparaison a temps constant.
 * Format stocke : `scrypt$<sel base64url>$<empreinte base64url>`.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const want = Buffer.from(expected, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), want.length);
  return key.length === want.length && timingSafeEqual(key, want);
}

/**
 * Une empreinte jetable, pour qu'un identifiant inconnu coute le meme temps qu'un mauvais mot de
 * passe : sans elle, la duree de la reponse dirait quels comptes existent.
 */
export const DECOY_HASH = await hashPassword(randomBytes(16).toString('hex'));
