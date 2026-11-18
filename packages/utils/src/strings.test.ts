import { describe, expect, it } from "vitest";
import { assertNonEmptyString, isNonEmptyString } from "./strings.js";

describe("isNonEmptyString", () => {
  it("accepts strings with content", () => {
    expect(isNonEmptyString("hi")).toBe(true);
  });

  it.each([[""], [" \t "], [null], [undefined], [42]])("rejects %p", (value) => {
    expect(isNonEmptyString(value)).toBe(false);
  });
});

describe("assertNonEmptyString", () => {
  it("passes through valid values", () => {
    expect(() => assertNonEmptyString("hi")).not.toThrow();
  });

  it("throws a labelled TypeError", () => {
    expect(() => assertNonEmptyString("", "name")).toThrow(/name must be a non-empty string/);
  });
});
