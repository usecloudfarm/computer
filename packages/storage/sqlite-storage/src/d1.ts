import { SqliteStorage } from "./index.js";
import { d1HttpDriver, type D1HttpOptions } from "./d1-http.js";
import type { Rows, SqlDriver, SqlStatement, SqlValue } from "./sql.js";

export * from "./index.js";
export { d1HttpDriver, encode } from "./d1-http.js";
export type { D1HttpOptions } from "./d1-http.js";

/**
 * The part of a D1 binding this needs.
 *
 * Structural rather than imported from `@cloudflare/workers-types`, so the
 * package does not drag platform types into a build that has none — and so
 * the driver can be exercised against anything with this shape.
 */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown>;
}

/** Inside a Worker, where `env.DB` exists. */
export interface D1BindingStorageOptions {
  /** The D1 binding, `env.DB`. */
  readonly database: D1DatabaseLike;
  /** Overridden in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/** Anywhere else, with credentials. */
export interface D1CredentialStorageOptions extends D1HttpOptions {
  /** Overridden in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

export type D1StorageOptions = D1BindingStorageOptions | D1CredentialStorageOptions;

/**
 * Workspace files in a D1 database, through the binding or over the REST API.
 *
 * ```ts
 * d1Storage({ database: env.DB });                            // in a Worker
 * d1Storage({ accountId, databaseId, apiToken });             // anywhere else
 * ```
 *
 * The binding only exists inside a Worker, so the credential form is what
 * makes the same database reachable from a local script, a CI job or another
 * host. Both end up at the same tables, so one can write what the other
 * reads.
 *
 * Either way D1 is reached over the network, where `node:sqlite` and a
 * Durable Object's own storage are a function call — and the credential form
 * adds a public HTTPS round trip on top of that. The shell reads the
 * workspace before every command, so expect it to show.
 */
export function d1Storage(options: D1StorageOptions): SqliteStorage {
  const driver = "database" in options ? d1Driver(options.database) : d1HttpDriver(options);
  return new SqliteStorage({
    driver,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** A driver over a D1 binding. */
export function d1Driver(database: D1DatabaseLike): SqlDriver {
  const prepare = ({ sql, params }: SqlStatement): D1PreparedStatementLike => {
    const prepared = database.prepare(sql);
    // `bind()` with no arguments is an error on some versions, and a
    // parameterless statement has nothing to bind anyway.
    return params.length > 0 ? prepared.bind(...params.map(toBinding)) : prepared;
  };

  return {
    all: async (sql, ...params) => {
      const { results } = await prepare({ sql, params }).all();
      return results as Rows;
    },
    // `batch` rather than a loop: it is D1's only transaction primitive —
    // there is no `BEGIN` over the binding — and it is one round trip instead
    // of one per statement, which for a chunked write is the difference
    // between a request and forty.
    write: async (statements) => {
      if (statements.length === 0) return;
      await database.batch(statements.map(prepare));
    },
  };
}

/**
 * Bytes as an array of numbers.
 *
 * Measured against the local binding, `Uint8Array`, a view into a larger
 * buffer, an `ArrayBuffer` and an array all bind and read back correctly — so
 * this is not working around a rejection. It is the JSON wire format: a
 * remote D1 serialises bindings to send them, and a `Uint8Array` is not an
 * array to `JSON.stringify`, it is an object with numeric keys. An array
 * survives that; the typed array is the form that might not.
 *
 * Only the local binding has been exercised here, so this is the conservative
 * spelling rather than a verified requirement. It costs a copy per chunk.
 */
function toBinding(value: SqlValue): unknown {
  return value instanceof Uint8Array ? [...value] : value;
}

export type { Rows, SqlDriver, SqlStatement, SqlValue };
