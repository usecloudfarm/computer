import { DatabaseSync } from "node:sqlite";
import type { Json, MemoryRecord, MemoryStore } from "@cloudfarm/core";

export interface SqliteMemoryOptions {
  /** Where the database lives. Defaults to `:memory:`, which forgets on exit. */
  readonly path?: string;
  /**
   * Which slice of the database this store owns.
   *
   * `MemoryStore` has no scope parameter — unlike `StorageProvider.open()` —
   * so a store cannot tell one user from another at call time. A multi-tenant
   * deployment therefore needs **one store per user**, with the user id as the
   * namespace. Sharing one store across users would let Ada's notes surface in
   * Bob's workspace.
   */
  readonly namespace?: string;
}

/**
 * Things an agent should recall later, in SQLite with FTS5.
 *
 * Node only: `node:sqlite` is a built-in with no Workers equivalent. On
 * Workers the same shape belongs on a Durable Object's SQLite, which is a
 * separate implementation of this interface rather than a port of this one.
 */
export class SqliteMemory implements MemoryStore {
  readonly id = "sqlite-memory";
  readonly description =
    "Remembers short facts across sessions and finds them by keyword. Write down what a user " +
    "prefers or what you learned, not what is already in a file.";

  readonly #db: DatabaseSync;
  readonly #namespace: string;

  constructor(options: SqliteMemoryOptions = {}) {
    this.#namespace = options.namespace ?? "default";
    this.#db = new DatabaseSync(options.path ?? ":memory:");

    // One FTS5 table with UNINDEXED columns rather than an external-content
    // table plus sync triggers: at this size the simpler schema wins, and
    // there is no second copy to drift.
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories USING fts5(
        id UNINDEXED,
        namespace UNINDEXED,
        text,
        metadata UNINDEXED,
        createdAt UNINDEXED,
        -- Porter stemming, or "summary" fails to match "summaries" and recall
        -- ranks on whichever record happened to share a common word.
        tokenize = 'porter unicode61'
      )
    `);
  }

  async remember(text: string, metadata?: Record<string, Json>): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      text,
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt: Date.now(),
    };

    this.#db
      .prepare("INSERT INTO memories (id, namespace, text, metadata, createdAt) VALUES (?,?,?,?,?)")
      .run(
        record.id,
        this.#namespace,
        record.text,
        metadata ? JSON.stringify(metadata) : null,
        record.createdAt,
      );

    return record;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<MemoryRecord[]> {
    const match = toMatchQuery(query);
    // Every term was punctuation or a stopword-length fragment: an FTS5 MATCH
    // with an empty query throws rather than returning nothing.
    if (!match) return [];

    const rows = this.#db
      .prepare(
        `SELECT id, text, metadata, createdAt, rank FROM memories
         WHERE memories MATCH ? AND namespace = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(match, this.#namespace, options.limit ?? 5) as unknown as RawRow[];

    return rows.map((row) => {
      const record = toRecord(row);
      // FTS5 rank is negative, better matches further from zero. A model
      // reads "higher is better", so it is flipped here.
      record.score = -Number(row.rank);
      return record;
    });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = this.#db
      .prepare("SELECT id, text, metadata, createdAt FROM memories WHERE id = ?")
      .get(id) as unknown as RawRow | undefined;
    return row ? toRecord(row) : null;
  }

  async forget(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  /** Everything remembered, newest first. For a UI, not for a model. */
  async list(limit = 100): Promise<MemoryRecord[]> {
    const rows = this.#db
      .prepare(
        `SELECT id, text, metadata, createdAt FROM memories
         WHERE namespace = ? ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(this.#namespace, limit) as unknown as RawRow[];
    return rows.map((row) => toRecord(row));
  }

  close(): void {
    this.#db.close();
  }
}

/** Convenience for the common case: `memory: sqliteMemory({ path })`. */
export function sqliteMemory(options: SqliteMemoryOptions = {}): SqliteMemory {
  return new SqliteMemory(options);
}

interface RawRow {
  id: string;
  text: string;
  metadata: string | null;
  createdAt: number;
  rank?: number;
}

function toRecord(row: RawRow): MemoryRecord & { score?: number } {
  return {
    id: row.id,
    text: row.text,
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Record<string, Json> } : {}),
    createdAt: Number(row.createdAt),
  };
}

/**
 * Plain words into an FTS5 query.
 *
 * FTS5 treats `"`, `*`, `:`, `-` and `^` as syntax, so a natural question —
 * `what's the deploy format?` — is a syntax error rather than a search. Each
 * word is stripped to letters and digits and quoted, and the terms are joined
 * with OR because recall should widen rather than narrow: a memory matching
 * two words out of five is usually the one wanted.
 */
const NOISE = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "what",
  "how",
  "should",
  "with",
  "that",
  "this",
  "was",
  "are",
  "from",
  "about",
  "did",
  "does",
  "can",
  "have",
  "has",
]);

function toMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 2 && !NOISE.has(term));
  return terms.map((term) => `"${term}"`).join(" OR ");
}
