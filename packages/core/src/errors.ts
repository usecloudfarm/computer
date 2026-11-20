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

export class CapabilityFailedError extends CloudfarmError {
  override name = "CapabilityFailedError";
  constructor(
    readonly ref: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${ref} failed: ${message}`);
  }
}
