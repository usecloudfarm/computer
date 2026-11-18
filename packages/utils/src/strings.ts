/** Narrows an unknown value to a string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Throws a `TypeError` unless `value` is a non-empty string. */
export function assertNonEmptyString(value: unknown, label = "value"): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
