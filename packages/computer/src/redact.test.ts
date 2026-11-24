import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

describe("Redactor", () => {
  it("removes a registered secret wherever it appears", () => {
    const redactor = new Redactor();
    redactor.add("super-secret-value");

    expect(redactor.text("token=super-secret-value&x=1")).toBe("token=[redacted]&x=1");
  });

  it("ignores short values that would cause false positives", () => {
    const redactor = new Redactor();
    redactor.add("abc");
    expect(redactor.text("abc def")).toBe("abc def");
  });

  it.each([
    ["xoxb-1234567890-abcdefghijkl", "slack-token"],
    ["ghp_abcdefghijklmnopqrstuvwxyz1234", "github-token"],
    ["sk-abcdefghijklmnopqrstuvwxyz", "api-key"],
    ["Bearer abcdefghijklmnopqrstuvwxyz", "bearer"],
  ])("redacts %s by shape even when unregistered", (secret, label) => {
    expect(new Redactor().text(`value: ${secret}`)).toBe(`value: [redacted:${label}]`);
  });

  it("walks nested values and strips sensitive headers", () => {
    const redactor = new Redactor();
    redactor.add("my-token-value-123");

    expect(
      redactor.value({
        ok: false,
        request: { headers: { Authorization: "Bearer my-token-value-123", accept: "json" } },
        detail: ["used my-token-value-123"],
      }),
    ).toEqual({
      ok: false,
      request: { headers: { Authorization: "[redacted]", accept: "json" } },
      detail: ["used [redacted]"],
    });
  });

  it("leaves non-string scalars alone", () => {
    expect(new Redactor().value({ n: 1, b: true, nothing: null })).toEqual({
      n: 1,
      b: true,
      nothing: null,
    });
  });
});
