import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/computer";
import { firecrawl } from "./index.js";

const KEY = "fc-test-key-123";

/** Replaces global fetch, so no test here reaches Firecrawl. */
function mockFetch(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return new Response(JSON.stringify(handler(request.url, body)), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function sent(spy: ReturnType<typeof mockFetch>, index = 0) {
  const request = spy.mock.calls[index]?.[0] as Request;
  return JSON.parse(await request.clone().text()) as Record<string, unknown>;
}

async function workspace() {
  const computer = new Computer({ apps: [firecrawl({ apiKey: KEY })] });
  return computer.createWorkspace("u1");
}

afterEach(() => vi.unstubAllGlobals());

describe("firecrawl", () => {
  it("talks to v2 with the key as a bearer token", async () => {
    const spy = mockFetch(() => ({ success: true, data: { web: [] } }));
    const ws = await workspace();

    await ws.run("firecrawl.search", { query: "hello" });

    const request = spy.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("requires a key", () => {
    expect(() => firecrawl({ apiKey: "" })).toThrow(/invalid credentials/);
  });

  it("returns ranked results without page content by default", async () => {
    const spy = mockFetch(() => ({
      success: true,
      data: {
        web: [
          {
            title: "Pricing",
            url: "https://example.test/pricing",
            description: "What it costs.",
            markdown: "# Pricing\n\nlots of text",
          },
        ],
      },
    }));
    const ws = await workspace();

    const result = await ws.run("firecrawl.search", { query: "pricing", limit: 3 });

    // No scrapeOptions asked for, so no markdown comes back to the model even
    // though the fixture carries some.
    expect(await sent(spy)).toMatchObject({ query: "pricing", limit: 3 });
    expect(await sent(spy)).not.toHaveProperty("scrapeOptions");
    expect(result).toEqual({
      status: "ok",
      value: {
        query: "pricing",
        results: [
          {
            title: "Pricing",
            url: "https://example.test/pricing",
            description: "What it costs.",
          },
        ],
      },
    });
  });

  it("asks for markdown only when content is wanted, and caps each result", async () => {
    const spy = mockFetch(() => ({
      success: true,
      data: {
        web: [
          { title: "A", url: "https://a.test", description: "", markdown: "y".repeat(5000) },
          { title: "B", url: "https://b.test", description: "", markdown: "z".repeat(5000) },
        ],
      },
    }));
    const ws = await workspace();

    const result = (await ws.run("firecrawl.search", {
      query: "x",
      includeContent: true,
      maxCharsPerResult: 300,
    })) as { value: { results: { markdown?: string }[] } };

    expect(await sent(spy)).toHaveProperty("scrapeOptions");
    // Ten results with content would be ten pages at once, so the cap is per
    // result, not per response.
    for (const hit of result.value.results) {
      expect(hit.markdown).toContain("[truncated]");
      expect(hit.markdown!.length).toBeLessThan(400);
    }
  });

  it("scrapes a page to markdown with its title", async () => {
    mockFetch(() => ({
      success: true,
      data: { markdown: "# Hello", metadata: { title: "Hello" } },
    }));
    const ws = await workspace();

    expect(await ws.run("firecrawl.scrape", { url: "https://example.test" })).toEqual({
      status: "ok",
      value: { url: "https://example.test", title: "Hello", markdown: "# Hello" },
    });
  });

  it("parks a long page in the workspace rather than inlining it", async () => {
    mockFetch(() => ({ success: true, data: { markdown: "x".repeat(5000), metadata: {} } }));
    const ws = await workspace();

    const result = (await ws.run("firecrawl.scrape", {
      url: "https://example.test",
      maxChars: 500,
    })) as { value: { markdown: string; truncated?: { ref: string; totalChars: number } } };

    expect(result.value.markdown).toHaveLength(500);
    expect(result.value.truncated?.totalChars).toBe(5000);
    expect(await ws.fs.readText(result.value.truncated!.ref)).toHaveLength(5000);
  });

  it("maps a site, accepting links as strings or objects", async () => {
    mockFetch(() => ({
      success: true,
      links: ["https://a.test/one", { url: "https://a.test/two" }],
    }));
    const ws = await workspace();

    expect(await ws.run("firecrawl.map", { url: "https://a.test" })).toMatchObject({
      status: "ok",
      value: { links: ["https://a.test/one", "https://a.test/two"] },
    });
  });

  it("passes a map search term through, since the whole map is usually too big", async () => {
    const spy = mockFetch(() => ({ success: true, links: [] }));
    const ws = await workspace();

    await ws.run("firecrawl.map", { url: "https://a.test", search: "pricing" });

    expect(await sent(spy)).toMatchObject({ search: "pricing" });
  });

  it("turns a 200-with-success-false into a failed run", async () => {
    mockFetch(() => ({ success: false, error: "insufficient credits" }));
    const ws = await workspace();

    expect(await ws.run("firecrawl.scrape", { url: "https://example.test" })).toMatchObject({
      status: "error",
      error: { message: /insufficient credits/ },
    });
  });

  it("only reaches Firecrawl, whatever url it is asked to read", () => {
    expect(firecrawl({ apiKey: KEY }).allowedHosts).toEqual(["api.firecrawl.dev"]);
  });

  it("is what search finds for a web-search intent", async () => {
    const ws = await workspace();

    expect((await ws.search("search the web for something")).actions[0]?.ref).toBe(
      "firecrawl.search",
    );
  });
});
