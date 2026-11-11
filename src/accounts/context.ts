/**
 * Le compte au nom duquel on agit, porte par le fil d'execution.
 *
 * Chaque requete authentifiee et chaque travail du worker s'executent « en tant que » un compte :
 * les acces a la base et a Yoto lisent ce compte ici plutot que de le recevoir en parametre. Un
 * acces hors de tout compte leve une erreur au lieu de lire les donnees d'un autre : un oubli se
 * voit tout de suite, il ne fuit pas.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ accountId: number | undefined }>();

/** Execute `work` au nom de ce compte (ou d'aucun, pour une requete anonyme). */
export function runAs<T>(accountId: number | undefined, work: () => T): T {
  return storage.run({ accountId }, work);
}

/** Bascule tout le reste du fil sur ce compte. Reserve aux tests et aux scripts. */
export function enterAs(accountId: number): void {
  storage.enterWith({ accountId });
}

export function currentAccountId(): number {
  const accountId = storage.getStore()?.accountId;
  if (accountId === undefined) throw new Error('Aucun compte actif pour cette opération.');
  return accountId;
}
