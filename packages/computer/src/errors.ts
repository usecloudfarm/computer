export class CloudfarmError extends Error {
  override name = "CloudfarmError";
}

/** An unknown ref, with the nearest known ones — models recover from this. */
export class UnknownRefError extends CloudfarmError {
  override name = "UnknownRefError";
  constructor(
    readonly ref: string,
    readonly suggestions: readonly string[],
  ) {
    super(
      `Unknown ref "${ref}"` +
        (suggestions.length > 0 ? `. Did you mean: ${suggestions.join(", ")}?` : ""),
    );
  }
}

export class InvalidArgumentsError extends CloudfarmError {
  override name = "InvalidArgumentsError";
  constructor(
    readonly ref: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid arguments for "${ref}": ${issues.join("; ")}`);
  }
}

/** An app tried to reach a host it never declared. */
export class EgressDeniedError extends CloudfarmError {
  override name = "EgressDeniedError";
  constructor(
    readonly host: string,
    readonly allowed: readonly string[],
  ) {
    super(`Blocked request to ${host}; allowed hosts: ${allowed.join(", ") || "none"}`);
  }
}

export class NamespaceConflictError extends CloudfarmError {
  override name = "NamespaceConflictError";
  constructor(readonly namespace: string) {
    super(`Namespace "${namespace}" is already taken; apps may not shadow built-ins`);
  }
}

export class ActionFailedError extends CloudfarmError {
  override name = "ActionFailedError";
  constructor(
    readonly ref: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${ref} failed: ${message}`);
  }
}

/** An action the workspace reached but which refused the call. */
export class UnauthorizedError extends CloudfarmError {
  override name = "UnauthorizedError";
  constructor(
    readonly ref: string,
    message: string,
  ) {
    super(`${ref} is not authorized: ${message}`);
  }
}

export class HttpError extends CloudfarmError {
  override name = "HttpError";

  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${url}`);
  }
}

/** Thrown by an app's `validate` when a 200 carries an application-level failure. */
export class UpstreamRejectedError extends CloudfarmError {
  override name = "UpstreamRejectedError";

  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Maps an error from dispatch onto the vocabulary a model sees. */
export function classifyError(error: unknown): {
  code:
    | "unknown_ref"
    | "invalid_args"
    | "not_authenticated"
    | "egress_denied"
    | "rate_limited"
    | "upstream_error"
    | "internal";
  retryable: boolean;
  hint?: string;
} {
  if (error instanceof UnknownRefError) {
    return {
      code: "unknown_ref",
      retryable: false,
      ...(error.suggestions.length > 0
        ? { hint: `Did you mean: ${error.suggestions.join(", ")}?` }
        : { hint: "Use `search` to find the right ref." }),
    };
  }
  if (error instanceof InvalidArgumentsError) {
    return { code: "invalid_args", retryable: false, hint: "Check the signature from `search`." };
  }
  if (error instanceof UnauthorizedError) {
    return { code: "not_authenticated", retryable: false };
  }
  if (error instanceof EgressDeniedError) {
    return {
      code: "egress_denied",
      retryable: false,
      hint: "The app only reaches hosts it declares; a url from the task cannot redirect it.",
    };
  }
  // An action's failure wraps the original, so classify what actually went
  // wrong rather than the wrapper. Without this a 429 from an app would be
  // reported as a flat upstream_error, losing the one hint worth having.
  if (error instanceof ActionFailedError && error.cause !== undefined && error.cause !== error) {
    const inner = classifyHttp(error.cause);
    if (inner) return inner;
  }
  const http = classifyHttp(error);
  if (http) return http;

  if (error instanceof ActionFailedError) {
    // The upstream service answered, badly. Worth retrying, unlike a typo.
    return { code: "upstream_error", retryable: true };
  }
  return { code: "internal", retryable: false };
}

/** Status-aware classification, so the model can tell "wait" from "stop". */
function classifyHttp(error: unknown):
  | {
      code: "not_authenticated" | "rate_limited" | "upstream_error";
      retryable: boolean;
      hint?: string;
    }
  | undefined {
  if (error instanceof UpstreamRejectedError) {
    return { code: "upstream_error", retryable: error.retryable };
  }
  if (!(error instanceof HttpError)) return undefined;

  if (error.status === 401 || error.status === 403) {
    return {
      code: "not_authenticated",
      retryable: false,
      hint: "The app's credential was rejected; the task cannot fix this by retrying.",
    };
  }
  if (error.status === 429) {
    return {
      code: "rate_limited",
      retryable: true,
      hint: "Upstream rate limit; retry after a pause.",
    };
  }
  if (error.status === 408 || error.status >= 500) {
    return { code: "upstream_error", retryable: true };
  }
  // Any other 4xx is the request's own fault; repeating it changes nothing.
  return { code: "upstream_error", retryable: false };
}
