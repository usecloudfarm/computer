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

/** Maps an error from dispatch onto the vocabulary a model sees. */
export function classifyError(error: unknown): {
  code:
    | "unknown_ref"
    | "invalid_args"
    | "not_authenticated"
    | "egress_denied"
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
  if (error instanceof ActionFailedError) {
    // The upstream service answered, badly. Worth retrying, unlike a typo.
    return { code: "upstream_error", retryable: true };
  }
  return { code: "internal", retryable: false };
}
