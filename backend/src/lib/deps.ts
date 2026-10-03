import type { DbOrTx } from '../db/client';
import type { Clock } from './clock';

/**
 * What a service needs: a database handle and the clock. `db` is the database, or the open
 * transaction when the service is called from inside `inTransaction`. (`AppDeps` in app.ts is the
 * same shape with the real database.)
 */
export interface Deps {
  db: DbOrTx;
  clock: Clock;
}

/**
 * Runs `fn` in one SQLite transaction: every write inside commits together, and an exception
 * (an `HttpError` for a broken rule, or anything unexpected) rolls all of them back and is
 * rethrown. `fn` receives deps whose `db` is the transaction and MUST be synchronous: a
 * better-sqlite3 transaction cannot await. Calls nest (an inner call becomes a savepoint).
 */
export function inTransaction<T>(deps: Deps, fn: (deps: Deps) => T): T {
  return deps.db.transaction((tx) => fn({ ...deps, db: tx }));
}
