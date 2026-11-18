import { assertNonEmptyString, err, ok } from "@unsandbox/utils";
import type { Result } from "@unsandbox/utils";

export interface ClientOptions {
  /** Base URL the client talks to. */
  readonly baseUrl: string;
  /** Request timeout in milliseconds. Defaults to 10_000. */
  readonly timeoutMs?: number;
}

export interface Client {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Resolves a path against the configured base URL. */
  resolve(path: string): Result<string, TypeError>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Creates a client bound to a base URL. Throws `TypeError` on invalid options. */
export function createClient(options: ClientOptions): Client {
  assertNonEmptyString(options.baseUrl, "baseUrl");

  const base = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive, finite number");
  }

  return {
    baseUrl: base.toString(),
    timeoutMs,
    resolve(path: string): Result<string, TypeError> {
      try {
        assertNonEmptyString(path, "path");
        return ok(new URL(path, base).toString());
      } catch (cause) {
        return err(cause instanceof TypeError ? cause : new TypeError(String(cause)));
      }
    },
  };
}
