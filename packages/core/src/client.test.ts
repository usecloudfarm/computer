import { describe, expect, it } from "vitest";
import { createClient } from "./client.js";

describe("createClient", () => {
  it("normalises the base URL and applies the default timeout", () => {
    const client = createClient({ baseUrl: "https://example.com" });
    expect(client.baseUrl).toBe("https://example.com/");
    expect(client.timeoutMs).toBe(10_000);
  });

  it("honours an explicit timeout", () => {
    expect(createClient({ baseUrl: "https://example.com", timeoutMs: 250 }).timeoutMs).toBe(250);
  });

  it("rejects an empty base URL", () => {
    expect(() => createClient({ baseUrl: "  " })).toThrow(/baseUrl must be a non-empty string/);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => createClient({ baseUrl: "https://example.com", timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive/,
    );
  });

  it("resolves relative paths", () => {
    const client = createClient({ baseUrl: "https://example.com/api/" });
    const result = client.resolve("users/1");
    expect(result.ok && result.value).toBe("https://example.com/api/users/1");
  });

  it("returns an error result for an invalid path", () => {
    const result = createClient({ baseUrl: "https://example.com" }).resolve("");
    expect(result.ok).toBe(false);
  });
});
