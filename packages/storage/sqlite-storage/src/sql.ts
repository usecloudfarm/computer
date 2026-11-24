/**
 * The seam between this package and whichever SQLite it is talking to.
 *
 * Three implementations ship: `./node` over `node:sqlite`, `./workers` over a
 * Durable Object's own storage, and `./d1` over a D1 binding. Two of them are
 * synchronous and one is not, which is why every method may return a promise
 * and none is required to.
 */
export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface SqlDriver {
  /**
   * Reads chunk content as a hex string rather than a blob.
   *
   * For a driver that cannot carry bytes faithfully. The REST API is JSON, and
   * neither direction survives it: a `Uint8Array` is not an array to
   * `JSON.stringify` but an object with numeric keys, and what comes back for
   * a `BLOB` column is whatever the server chose to encode it as. `hex()` is
   * a string on both sides, so it is unambiguous — at the cost of twice the
   * bytes on the wire and a decode.
   *
   * The local drivers leave this off and read the blob directly.
   */
  readonly blobAsHex?: boolean;
  /** A statement whose rows are wanted. */
  all(sql: string, ...params: SqlValue[]): Rows | Promise<Rows>;
  /**
   * Applies statements, atomically where the database can.
   *
   * A list rather than a callback, which is what this used to be. A callback
   * cannot be served by either platform that has an opinion: a Durable
   * Object's `transactionSync` requires a synchronous body, which is
   * impossible once a driver call may be awaited, and D1 has no `BEGIN` at
   * all — `batch()` takes statements. A list is the one shape all three
   * accept.
   *
   * Callers depend on this: a file is a row plus one row per chunk, so a
   * half-applied write leaves a file whose recorded size and stored bytes
   * disagree.
   */
  write(statements: readonly SqlStatement[]): void | Promise<void>;
}

export type Rows = Record<string, unknown>[];

/** Shorthand for building a statement list. */
export function statement(sql: string, ...params: SqlValue[]): SqlStatement {
  return { sql, params };
}

/** The schema. Idempotent, so every open can apply it. */
export function schemaStatements(): SqlStatement[] {
  return [
    statement(
      `CREATE TABLE IF NOT EXISTS cloudfarm_files (
         scope TEXT NOT NULL,
         path  TEXT NOT NULL,
         size  INTEGER NOT NULL,
         mtime INTEGER NOT NULL,
         PRIMARY KEY (scope, path)
       )`,
    ),
    // Content in fixed-size chunks rather than one blob per file. A Durable
    // Object caps a key and value together at a few megabytes — the figure
    // has been raised twice and the docs trail the runtime — and D1 has a row
    // limit of its own, so a whole-file blob is a cliff a workspace reaches
    // by saving a CSV. Chunking moves the ceiling to the database's.
    statement(
      `CREATE TABLE IF NOT EXISTS cloudfarm_chunks (
         scope TEXT NOT NULL,
         path  TEXT NOT NULL,
         seq   INTEGER NOT NULL,
         bytes BLOB NOT NULL,
         PRIMARY KEY (scope, path, seq)
       )`,
    ),
  ];
}

/**
 * 256 KiB.
 *
 * Under the smallest limit any of the three databases documents, so the same
 * chunk size is safe on all of them, and large enough that a megabyte file is
 * four rows rather than a hundred.
 */
export const CHUNK_BYTES = 256 * 1024;
