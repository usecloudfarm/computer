import type { Rows, SqlDriver, SqlStatement, SqlValue } from "./sql.js";

/**
 * D1 over its REST API, for running outside Cloudflare.
 *
 * The binding in `./d1` only exists inside a Worker. This reaches the same
 * database from anywhere with an account id, a database id and an API token —
 * a local script, a CI job, another host.
 *
 * It is the slowest of the four drivers by some distance: every statement is
 * an HTTPS request to Cloudflare's API, where the binding is an internal hop
 * and the other two are a function call. The shell reads the workspace before
 * every command, so expect that to show.
 */
export interface D1HttpOptions {
  readonly accountId: string;
  readonly databaseId: string;
  /** An API token with D1 Read and D1 Write. */
  readonly apiToken: string;
  /** Overridden in tests and to route through a proxy. */
  readonly fetch?: typeof globalThis.fetch;
  /** Overridden in tests. Defaults to Cloudflare's API. */
  readonly endpoint?: string;
}

/** A driver over the D1 REST API. */
export function d1HttpDriver(options: D1HttpOptions): SqlDriver {
  const endpoint = options.endpoint ?? "https://api.cloudflare.com/client/v4";
  const url = `${endpoint}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
  const doFetch = options.fetch ?? globalThis.fetch;

  const post = async (body: unknown): Promise<D1HttpResponse> => {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as D1HttpResponse;
    if (!response.ok || payload.success === false) {
      // The API reports a failed statement with HTTP 200 and `success: false`,
      // so the status alone is not the answer.
      const message =
        payload.errors?.map((error) => error.message).join("; ") ?? `HTTP ${response.status}`;
      throw new Error(`D1 request failed: ${message}`);
    }
    return payload;
  };

  return {
    // JSON cannot carry bytes either way, so chunks are read as hex. See the
    // note on `SqlDriver.blobAsHex`.
    blobAsHex: true,
    all: async (sql, ...params) => {
      const payload = await post(encode({ sql, params }));
      return (payload.result?.[0]?.results ?? []) as Rows;
    },
    // `batch` is the API's transaction, the same as over the binding.
    write: async (statements) => {
      if (statements.length === 0) return;
      await post({ batch: statements.map(encode) });
    },
  };
}

interface D1HttpResponse {
  success?: boolean;
  errors?: { message: string }[];
  result?: { results?: unknown[] }[];
}

/**
 * One statement as the REST API takes it.
 *
 * `params` is documented as an array of strings, which is why bytes do not go
 * there: a blob is written into the SQL as an `X'…'` literal instead, so the
 * column stays a real `BLOB` and a database written through this driver reads
 * back correctly through the binding. Encoding chunks as base64 text would
 * have been easier and would have made the two drivers' databases
 * incompatible.
 *
 * Everything else is stringified, again because the documented type is
 * string. SQLite's column affinity turns `"96"` back into the integer 96 on
 * the way into an `INTEGER` column, and coerces a string argument where a
 * number is wanted, so `substr(path, 1, "9")` behaves.
 */
export function encode({ sql, params }: SqlStatement): { sql: string; params: string[] } {
  const out: string[] = [];
  let rewritten = "";
  let index = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const character = sql[i]!;
    // Placeholders inside a string literal are text, not parameters. None of
    // this package's SQL has one, but a driver should not depend on that.
    if (character === "'") inString = !inString;
    if (character !== "?" || inString) {
      rewritten += character;
      continue;
    }
    const value = params[index++];
    if (value instanceof Uint8Array) {
      rewritten += blobLiteral(value);
    } else {
      rewritten += "?";
      out.push(String(value));
    }
  }

  return { sql: rewritten, params: out };
}

/** `X'00ff…'`, SQLite's blob literal. */
function blobLiteral(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `X'${hex}'`;
}

export type { Rows, SqlDriver, SqlStatement, SqlValue };
