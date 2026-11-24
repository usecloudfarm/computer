/**
 * Keeps credentials out of anything a model can read.
 *
 * The realistic leak is not a handler returning a token — it is an upstream
 * error body echoing the request that carried one. So this runs over every
 * model-facing value: code results, run results, logs and error messages.
 */

/** Shapes that are secrets wherever they appear, whether or not we minted them. */
const PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "slack-token" },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, label: "github-token" },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, label: "api-key" },
  { pattern: /e2b_[A-Za-z0-9]{20,}/g, label: "e2b-key" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "jwt" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, label: "bearer" },
];

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers a literal secret. Short values are ignored: too many false hits. */
  add(secret: string | undefined): void {
    if (secret && secret.length >= 8) this.#secrets.add(secret);
  }

  text(input: string): string {
    let output = input;
    for (const secret of this.#secrets) {
      if (secret.length >= 8) output = output.split(secret).join("[redacted]");
    }
    for (const { pattern, label } of PATTERNS) {
      output = output.replace(pattern, `[redacted:${label}]`);
    }
    return output;
  }

  /** Walks a JSON value, redacting strings and dropping sensitive header keys. */
  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T;
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
          output[key] = "[redacted]";
          continue;
        }
        output[key] = this.value(value);
      }
      return output as T;
    }
    return input;
  }
}
