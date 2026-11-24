import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "./index.js";
import type { SqlDriver, SqlValue } from "./sql.js";

export * from "./index.js";

export interface NodeSqliteOptions {
  /**
   * Where the database goes. Any of:
   *
   * - a path, absolute or relative to the process — `".cloudfarm/db.sqlite"`
   * - a `file:` URL, as a string or a `URL` — `"file:///var/lib/cf/db.sqlite"`
   * - `":memory:"`, for a database that dies with the process
   *
   * A missing parent directory is created. SQLite itself will not, and a
   * default like `.cloudfarm/db.sqlite` otherwise fails on a fresh checkout
   * with nothing more useful than "unable to open database file".
   *
   * URI query parameters (`file:db.sqlite?mode=ro`) are not supported:
   * SQLite needs an open flag for those that `node:sqlite` does not expose.
   * Use `readOnly` instead.
   */
  readonly path: string | URL;
  /** Opens the database read-only. Writes then fail rather than being ignored. */
  readonly readOnly?: boolean;
  /** Overridden in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * Workspace files in a local SQLite database, through `node:sqlite`.
 *
 * Node's own module, so there is no native dependency to build and nothing to
 * install — which is the reason it is this rather than `better-sqlite3`. It is
 * still flagged experimental by Node and prints a warning on first use.
 */
export function sqliteStorage(options: NodeSqliteOptions): SqliteStorage {
  const location = resolveLocation(options.path);
  if (location.directory !== undefined) {
    mkdirSync(location.directory, { recursive: true });
  }

  // Always an object: `node:sqlite` rejects an explicit `undefined` here
  // with "The options argument must be an object".
  const database = new DatabaseSync(location.open, { readOnly: options.readOnly ?? false });

  if (!options.readOnly) {
    // Chunked writes are several statements each, and the default journal
    // makes every one of them a file sync. WAL is the difference between a
    // workspace that writes at memory speed and one that waits on the disk
    // per chunk. Skipped when read-only, where there is nothing to journal
    // and setting it would fail.
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }

  return new SqliteStorage({
    driver: nodeDriver(database),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** A driver over an already-open `node:sqlite` database. */
export function nodeDriver(database: DatabaseSync): SqlDriver {
  return {
    all: (sql, ...params) =>
      database.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    write: (statements) => {
      // The one driver of the three that has a real `BEGIN`.
      database.exec("BEGIN");
      try {
        for (const { sql, params } of statements) {
          database.prepare(sql).run(...(params as never[]));
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * What to hand `DatabaseSync`, and which directory has to exist first.
 *
 * `directory` is undefined for `:memory:`, which is not a file and has no
 * parent to create.
 */
export function resolveLocation(path: string | URL): {
  open: string;
  directory: string | undefined;
} {
  if (path instanceof URL) {
    const file = fileURLToPath(path);
    return { open: file, directory: dirname(file) };
  }
  if (path === ":memory:" || path.startsWith(":")) return { open: path, directory: undefined };
  if (path.startsWith("file:")) {
    // Normalised to a plain path rather than passed through, so the parent
    // directory can be created and so both spellings behave alike.
    const file = fileURLToPath(new URL(path));
    return { open: file, directory: dirname(file) };
  }
  return { open: path, directory: dirname(path) };
}

export type { SqlDriver, SqlValue };
