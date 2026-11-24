import { SqliteStorage } from "./index.js";
import type { SqlDriver, SqlStatement, SqlValue } from "./sql.js";

export * from "./index.js";

/**
 * The part of a Durable Object's storage this needs.
 *
 * Structural rather than imported from `@cloudflare/workers-types`, so the
 * package does not drag platform types into a build that does not have them —
 * and so the same driver can be exercised against any SQLite with this shape.
 */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike;
  transactionSync?: <T>(body: () => T) => T;
}

export interface WorkersSqliteOptions {
  /** `ctx.storage` of a SQLite-backed Durable Object. */
  readonly storage: DurableObjectStorageLike;
  /** Overridden in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * Workspace files in the Durable Object's own SQLite.
 *
 * Nothing to provision: the object already has up to 10 GB, and the files
 * outlive its eviction and restart. No bucket, no endpoint, no keys — and so
 * no credential that could reach model-written code, which is the part
 * `@cloudfarm/s3-storage` has to be careful about.
 *
 * One object per workspace is the shape this is for. A single object can hold
 * several, since the scope is a column, but they then share one 10 GB budget
 * and one lock.
 */
export function sqliteStorage(options: WorkersSqliteOptions): SqliteStorage {
  return new SqliteStorage({
    driver: workersDriver(options.storage),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** A driver over a Durable Object's SQL storage. */
export function workersDriver(storage: DurableObjectStorageLike): SqlDriver {
  // `exec` is lazy enough that a statement has to be drained for its writes
  // to be applied.
  const apply = (statements: readonly SqlStatement[]): void => {
    for (const { sql, params } of statements) storage.sql.exec(sql, ...params).toArray();
  };

  return {
    all: (sql, ...params) => storage.sql.exec(sql, ...params).toArray(),
    write: (statements) => {
      // `BEGIN` is not available here; the platform owns transactions, and
      // `transactionSync` takes a synchronous body — which is exactly what a
      // statement list can give it, where a callback from above could not.
      if (storage.transactionSync) {
        storage.transactionSync(() => apply(statements));
        return;
      }
      // A bare `SqlStorage` has no `transactionSync`. Writes within one turn
      // are coalesced anyway; this is the fallback, not the intended path.
      apply(statements);
    },
  };
}

export type { SqlDriver, SqlValue };
