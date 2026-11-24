import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/computer";
import { web } from "./index.js";

const TOKEN = "cf-token-value-123";
const ACCOUNT = "acct-123";

/** Replaces global fetch, so no test here reaches Cloudflare. */
function mockFetch(handler: (url: string, body: unknown) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    return handler(request.url, text ? JSON.parse(text) : undefined);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const app = () => web({ apiKey: TOKEN, accountId: ACCOUNT });

async function workspace() {
  return new Computer({ apps: [app()] }).createWorkspace("u1");
}

afterEach(() => vi.unstubAllGlobals());

describe("web (Cloudflare Browser Run)", () => {
  it("builds the account-scoped endpoint and sends the token", async () => {
    const spy = mockFetch(() => json({ success: true, result: "# Title" }));
    const ws = await workspace();

    await ws.run("web.read", { url: "https://example.com" });

    const request = spy.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/markdown`,
    );
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("requires an account id, since it is half the URL", () => {
    expect(() => web({ apiKey: TOKEN } as never)).toThrow(/accountId/);
  });

  it("requires a token", () => {
    expect(() => web({ apiKey: "", accountId: ACCOUNT })).toThrow(/invalid credentials/);
  });

  it("reads a page as markdown", async () => {
    mockFetch(() => json({ success: true, result: "# Example\n\nBody." }));
    const ws = await workspace();

    expect(await ws.run("web.read", { url: "https://example.com" })).toEqual({
      status: "ok",
      value: { url: "https://example.com", markdown: "# Example\n\nBody." },
    });
  });

  it("parks a long page in the workspace instead of inlining it", async () => {
    const huge = "x".repeat(5000);
    mockFetch(() => json({ success: true, result: huge }));
    const ws = await workspace();

    const result = (await ws.run("web.read", {
      url: "https://example.com",
      maxChars: 500,
    })) as { value: { markdown: string; truncated?: { ref: string; totalChars: number } } };

    expect(result.value.markdown).toHaveLength(500);
    expect(result.value.truncated?.totalChars).toBe(5000);
    // The whole page is readable from the workspace, not lost.
    const spilled = await ws.fs.readText(result.value.truncated!.ref);
    expect(spilled).toHaveLength(5000);
  });

  it("passes waitUntil through as gotoOptions, which is where the API wants it", async () => {
    const spy = mockFetch(() => json({ success: true, result: "" }));
    const ws = await workspace();

    await ws.run("web.read", { url: "https://example.com", waitUntil: "networkidle0" });

    const request = spy.mock.calls[0]?.[0] as Request;
    const sent = JSON.parse(await request.clone().text()) as {
      gotoOptions?: { waitUntil?: string };
    };
    expect(sent.gotoOptions?.waitUntil).toBe("networkidle0");
  });

  it("flattens scraped elements and drops the geometry", async () => {
    mockFetch(() =>
      json({
        success: true,
        result: [
          {
            selector: "a",
            results: [
              {
                text: "More information...",
                html: "<a>More information...</a>",
                attributes: [{ name: "href", value: "https://iana.org" }],
                top: 249.875,
                left: 100,
                width: 142,
                height: 20,
              },
            ],
          },
        ],
      }),
    );
    const ws = await workspace();

    const result = await ws.run("web.scrape", {
      url: "https://example.com",
      selectors: ["a"],
    });

    expect(result).toEqual({
      status: "ok",
      value: {
        url: "https://example.com",
        elements: [
          {
            selector: "a",
            matches: [{ text: "More information...", attributes: { href: "https://iana.org" } }],
          },
        ],
      },
    });
  });

  it("accepts links as bare strings or as objects", async () => {
    mockFetch(() => json({ success: true, result: ["https://a.test", { url: "https://b.test" }] }));
    const ws = await workspace();

    expect(await ws.run("web.links", { url: "https://example.com" })).toMatchObject({
      status: "ok",
      value: { links: ["https://a.test", "https://b.test"] },
    });
  });

  it("writes a screenshot to the workspace rather than returning bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    mockFetch(() => new Response(png, { headers: { "content-type": "image/png" } }));
    const ws = await workspace();

    const result = (await ws.run("web.screenshot", { url: "https://example.com" })) as {
      value: { ref: string; bytes: number };
    };

    expect(result.value.bytes).toBe(8);
    expect(await ws.fs.stat(result.value.ref)).toMatchObject({ size: 8 });
  });

  it("reports a JSON error body on the screenshot endpoint, which returns bytes on success", async () => {
    mockFetch(() => json({ success: false, errors: [{ message: "quota exceeded" }] }));
    const ws = await workspace();

    expect(await ws.run("web.screenshot", { url: "https://example.com" })).toMatchObject({
      status: "error",
      error: { message: /quota exceeded/ },
    });
  });

  it("turns Cloudflare's 200-with-success-false into a failed run", async () => {
    mockFetch(() => json({ success: false, errors: [{ message: "invalid url" }] }));
    const ws = await workspace();

    expect(await ws.run("web.read", { url: "https://example.com" })).toMatchObject({
      status: "error",
      error: { message: /invalid url/ },
    });
  });

  it("maps a 401 to not_authenticated rather than a generic failure", async () => {
    mockFetch(() => json({ success: false, errors: [{ message: "bad token" }] }, 401));
    const ws = await workspace();

    expect(await ws.run("web.read", { url: "https://example.com" })).toMatchObject({
      status: "error",
      error: { code: "not_authenticated", retryable: false },
    });
  });

  it("only reaches Cloudflare, whatever url it is asked to read", () => {
    expect(app().allowedHosts).toEqual(["api.cloudflare.com"]);
  });

  it("is found by searching for what it does", async () => {
    const ws = await workspace();

    expect((await ws.search("read a web page")).actions[0]?.ref).toBe("web.read");
  });
});
