import { FileNotFoundError, dirname, normalizePath } from "@cloudfarm/core";
import type { FileStat, FileSystem, StorageProvider } from "@cloudfarm/core";
import {
  CHUNK_BYTES,
  schemaStatements,
  statement,
  type Rows,
  type SqlDriver,
  type SqlStatement,
} from "./sql.js";

export type { Rows, SqlDriver, SqlStatement, SqlValue } from "./sql.js";
export { CHUNK_BYTES, schemaStatements, statement } from "./sql.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SqliteStorageOptions {
  /** Where the tables live. */
  readonly driver: SqlDriver;
  /** Overridden in tests; defaults to the wall clock. */
  readonly now?: () => number;
}

/**
 * Workspace files in SQLite.
 *
 * Whichever SQLite a deployment already has: a local file through
 * `node:sqlite`, a Durable Object's own storage, or D1. No bucket, no endpoint
 * and — for the first two — no credentials, which also means nothing to scope,
 * rotate or leak, where `@cloudfarm/s3-storage` has keys that have to be kept
 * away from model-written code.
 *
 * It suits the traffic a workspace actually has. The shell reads the workspace
 * before every command; over S3 that is one HTTPS request per file, and here
 * it is one statement.
 *
 * What S3 keeps: files beyond the database's own ceiling, and sharing a
 * workspace between processes that do not share a database.
 */
export class SqliteStorage implements StorageProvider {
  readonly id = "sqlite";
  readonly description =
    "Workspace files in SQLite — durable, with no bucket or credentials to configure.";

  readonly #driver: SqlDriver;
  readonly #now: () => number;
  /** Applied once per provider, on the first operation rather than at
   * construction: a driver may be asynchronous and a constructor cannot wait. */
  #ready: Promise<void> | undefined;

  constructor(options: SqliteStorageOptions) {
    this.#driver = options.driver;
    this.#now = options.now ?? (() => Date.now());
  }

  async open(scope: { userId: string; workspaceId: string }): Promise<FileSystem> {
    this.#ready ??= Promise.resolve(this.#driver.write(schemaStatements())).then(() => undefined);
    await this.#ready;
    // One database can hold many workspaces, so the scope is a column rather
    // than a path prefix: a key cannot collide with a file called
    // `workspaces` and nothing has to be escaped out of a path.
    return new SqliteFileSystem(this.#driver, scopeKey(scope), this.#now);
  }
}

/** Convenience for the common case: `storage: sqlite({ driver })`. */
export function sqlite(options: SqliteStorageOptions): SqliteStorage {
  return new SqliteStorage(options);
}

/** `<userId>/workspaces/<workspaceId>`, the same layout `s3-storage` uses. */
function scopeKey(scope: { userId: string; workspaceId: string }): string {
  return `${scope.userId}/workspaces/${scope.workspaceId}`;
}

class SqliteFileSystem implements FileSystem {
  readonly #driver: SqlDriver;
  readonly #scope: string;
  readonly #now: () => number;

  constructor(driver: SqlDriver, scope: string, now: () => number) {
    this.#driver = driver;
    this.#scope = scope;
    this.#now = now;
  }

  async read(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const file = await this.#file(normalized);
    if (!file) throw new FileNotFoundError(normalized);

    // `hex(bytes)` for a driver that cannot carry bytes through its wire
    // format; the blob itself for one that can.
    const hex = this.#driver.blobAsHex === true;
    const chunks = await this.#driver.all(
      `SELECT ${hex ? "hex(bytes) AS bytes" : "bytes"} FROM cloudfarm_chunks
         WHERE scope = ? AND path = ? ORDER BY seq`,
      this.#scope,
      normalized,
    );

    const out = new Uint8Array(file.size);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = hex ? fromHex(String(chunk["bytes"])) : toBytes(chunk["bytes"]);
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }

  async readText(path: string): Promise<string> {
    return decoder.decode(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string): Promise<FileStat> {
    const normalized = normalizePath(path);
    if (normalized === "/") throw new Error("Cannot write to /");
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const mtime = this.#now();

    const statements: SqlStatement[] = [
      // Replacing, not appending: a shorter file must not keep the tail of
      // the longer one it overwrote.
      statement(
        `DELETE FROM cloudfarm_chunks WHERE scope = ? AND path = ?`,
        this.#scope,
        normalized,
      ),
      statement(
        `INSERT INTO cloudfarm_files (scope, path, size, mtime) VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime`,
        this.#scope,
        normalized,
        bytes.byteLength,
        mtime,
      ),
    ];
    for (let seq = 0, offset = 0; offset < bytes.byteLength; seq++, offset += CHUNK_BYTES) {
      statements.push(
        statement(
          `INSERT INTO cloudfarm_chunks (scope, path, seq, bytes) VALUES (?, ?, ?, ?)`,
          this.#scope,
          normalized,
          seq,
          // `slice`, not `subarray`: a view would hand the driver the whole
          // buffer and let it bind every byte of the file into each chunk.
          bytes.slice(offset, offset + CHUNK_BYTES),
        ),
      );
    }

    await this.#driver.write(statements);
    return { path: normalized, size: bytes.byteLength, mtime, type: "file" };
  }

  async *list(prefix = "/"): AsyncIterable<FileStat> {
    const scope = childScope(normalizePath(prefix));

    const rows = await this.#driver.all(
      `SELECT path, size, mtime FROM cloudfarm_files
         WHERE scope = ? AND substr(path, 1, ?) = ?
         ORDER BY path`,
      this.#scope,
      scope.length,
      scope,
    );

    // Directories are implied by separators in a path, exactly as in the
    // in-memory filesystem and in S3, and are synthesised the same way: the
    // contract has them, the storage does not.
    const directories = new Map<string, number>();
    const files: FileStat[] = [];
    for (const row of rows) {
      const path = String(row["path"]);
      const mtime = Number(row["mtime"]);
      files.push({ path, size: Number(row["size"]), mtime, type: "file" });
      let parent = dirname(path);
      while (parent !== "/" && parent.startsWith(scope)) {
        directories.set(parent, Math.max(directories.get(parent) ?? 0, mtime));
        parent = dirname(parent);
      }
    }

    for (const [path, mtime] of [...directories].toSorted(([a], [b]) => a.localeCompare(b))) {
      yield { path, size: 0, mtime, type: "directory" };
    }
    for (const file of files) yield file;
  }

  async stat(path: string): Promise<FileStat | null> {
    const normalized = normalizePath(path);
    const file = await this.#file(normalized);
    if (file) {
      return { path: normalized, size: file.size, mtime: file.mtime, type: "file" };
    }
    return (await this.#hasChildren(normalized))
      ? { path: normalized, size: 0, mtime: this.#now(), type: "directory" }
      : null;
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.#file(normalized)) {
      await this.#driver.write([
        statement(
          `DELETE FROM cloudfarm_chunks WHERE scope = ? AND path = ?`,
          this.#scope,
          normalized,
        ),
        statement(
          `DELETE FROM cloudfarm_files WHERE scope = ? AND path = ?`,
          this.#scope,
          normalized,
        ),
      ]);
      return;
    }

    if (!(await this.#hasChildren(normalized))) throw new FileNotFoundError(normalized);
    if (!options.recursive) {
      throw new Error(`${normalized} is a directory; pass { recursive: true } to remove it`);
    }
    const scope = childScope(normalized);
    await this.#driver.write(
      ["cloudfarm_chunks", "cloudfarm_files"].map((table) =>
        statement(
          `DELETE FROM ${table} WHERE scope = ? AND substr(path, 1, ?) = ?`,
          this.#scope,
          scope.length,
          scope,
        ),
      ),
    );
  }

  async move(from: string, to: string): Promise<void> {
    const source = normalizePath(from);
    const target = normalizePath(to);

    if (await this.#file(source)) {
      await this.#driver.write([
        // The destination may exist; dropping it first keeps the rename from
        // failing on the primary key and leaving the source in place.
        statement(`DELETE FROM cloudfarm_chunks WHERE scope = ? AND path = ?`, this.#scope, target),
        statement(`DELETE FROM cloudfarm_files WHERE scope = ? AND path = ?`, this.#scope, target),
        ...["cloudfarm_chunks", "cloudfarm_files"].map((table) =>
          statement(
            `UPDATE ${table} SET path = ? WHERE scope = ? AND path = ?`,
            target,
            this.#scope,
            source,
          ),
        ),
      ]);
      return;
    }

    if (!(await this.#hasChildren(source))) throw new FileNotFoundError(source);
    const scope = childScope(source);
    await this.#driver.write(
      // One statement per table for the whole subtree: SQL can do the prefix
      // swap, where reading every path back to rewrite it could not.
      ["cloudfarm_chunks", "cloudfarm_files"].map((table) =>
        statement(
          `UPDATE ${table} SET path = ? || substr(path, ?) WHERE scope = ? AND substr(path, 1, ?) = ?`,
          target,
          scope.length,
          this.#scope,
          scope.length,
          scope,
        ),
      ),
    );
  }

  async #file(path: string): Promise<{ size: number; mtime: number } | undefined> {
    const rows = await this.#driver.all(
      `SELECT size, mtime FROM cloudfarm_files WHERE scope = ? AND path = ?`,
      this.#scope,
      path,
    );
    const row = rows[0];
    return row ? { size: Number(row["size"]), mtime: Number(row["mtime"]) } : undefined;
  }

  async #hasChildren(path: string): Promise<boolean> {
    const scope = childScope(path);
    const rows: Rows = await this.#driver.all(
      `SELECT 1 FROM cloudfarm_files WHERE scope = ? AND substr(path, 1, ?) = ? LIMIT 1`,
      this.#scope,
      scope.length,
      scope,
    );
    return rows.length > 0;
  }
}

/** The prefix every path under a directory shares, root included. */
function childScope(path: string): string {
  return path === "/" ? "/" : `${path}/`;
}

/**
 * A `BLOB` as the local drivers hand it back: `node:sqlite` returns a
 * `Uint8Array`, a Durable Object an `ArrayBuffer`, and the D1 binding either
 * that or an array of byte values.
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error(`unexpected chunk type ${typeof value}`);
}

/** `hex()` output back into bytes, for a driver that reads chunks as text. */
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type { FileStat } from "@cloudfarm/core";
