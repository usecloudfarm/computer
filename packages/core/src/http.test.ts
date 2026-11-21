import { describe, expect, it } from "vitest";
import { createHttpClient } from "./http.js";
import { classifyError, HttpError, UpstreamRejectedError } from "./errors.js";

/** Captures what the client sent, and answers with whatever the test wants. */
function recorder(respond: (request: Request) => Response = () => json({})) {
  const seen: Request[] = [];
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    return respond(request);
  };
  return { seen, fetcher };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createHttpClient", () => {
  it("joins a relative path onto the base url without eating a segment", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test/v1/" });

    await client.get("/things");

    expect(seen[0]?.url).toBe("https://api.test/v1/things");
  });

  it("lets an absolute url bypass the base", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await client.get("https://other.test/thing");

    expect(seen[0]?.url).toBe("https://other.test/thing");
  });

  it("drops undefined and null query values instead of sending them as text", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await client.get("search", { query: { q: "hi", limit: 20, cursor: undefined, page: null } });

    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("q")).toBe("hi");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("sends a JSON body with the right content type", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await client.post("things", { name: "x" });

    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("content-type")).toContain("application/json");
    expect(await seen[0]?.clone().json()).toEqual({ name: "x" });
  });

  it("form-encodes when asked, for APIs that refuse JSON", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await client.request("POST", "legacy", { form: { a: "1", b: 2, skip: undefined } });

    expect(seen[0]?.headers.get("content-type")).toContain("x-www-form-urlencoded");
    expect(await seen[0]?.clone().text()).toBe("a=1&b=2");
  });

  it("sends no body at all for a bodyless post", async () => {
    const { seen, fetcher } = recorder();
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await client.post("ping");

    expect(seen[0]?.headers.get("content-type")).toBeNull();
    expect(await seen[0]?.clone().text()).toBe("");
  });

  it("throws HttpError carrying the status and a snippet of the body", async () => {
    const { fetcher } = recorder(() => json({ error: "no_such_thing" }, 404));
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    const error = await client.get("things").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).body).toEqual({ error: "no_such_thing" });
    expect((error as HttpError).message).toContain("no_such_thing");
  });

  it("parses a JSON body even when the service forgets the content type", async () => {
    const { fetcher } = recorder(() => new Response(JSON.stringify({ ok: true })));
    const client = createHttpClient(fetcher, { baseUrl: "https://api.test" });

    await expect(client.get("thing")).resolves.toEqual({ ok: true });
  });

  it("returns text as text, and an empty body as null", async () => {
    const text = createHttpClient(recorder(() => new Response("plain words")).fetcher, {
      baseUrl: "https://api.test",
    });
    await expect(text.get("a")).resolves.toBe("plain words");

    const empty = createHttpClient(recorder(() => new Response("")).fetcher, {
      baseUrl: "https://api.test",
    });
    await expect(empty.get("a")).resolves.toBeNull();
  });

  it("runs the validate hook, for a 200 that actually means failure", async () => {
    const { fetcher } = recorder(() => json({ ok: false, error: "nope" }));
    const client = createHttpClient(fetcher, {
      baseUrl: "https://api.test",
      validate: (body) => {
        if ((body as { ok?: boolean }).ok !== true) throw new UpstreamRejectedError("nope");
      },
    });

    await expect(client.get("thing")).rejects.toThrow(/nope/);
  });

  it("says so plainly when a relative path has no base url to resolve against", async () => {
    const client = createHttpClient(recorder().fetcher);

    await expect(client.get("things")).rejects.toThrow(/relative but the app set no http.baseUrl/);
  });
});

const codeFor = (status: number) =>
  classifyError(new HttpError(status, "https://api.test/x", null));

describe("classifyError maps status onto what a model should do", () => {
  it("tells the model to wait on a 429 rather than to stop", () => {
    expect(codeFor(429)).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("reports a rejected credential as not_authenticated", () => {
    expect(codeFor(401)).toMatchObject({ code: "not_authenticated", retryable: false });
    expect(codeFor(403)).toMatchObject({ code: "not_authenticated", retryable: false });
  });

  it("treats 5xx and timeouts as worth retrying, other 4xx as not", () => {
    expect(codeFor(503)).toMatchObject({ code: "upstream_error", retryable: true });
    expect(codeFor(408)).toMatchObject({ code: "upstream_error", retryable: true });
    expect(codeFor(404)).toMatchObject({ code: "upstream_error", retryable: false });
    expect(codeFor(400)).toMatchObject({ code: "upstream_error", retryable: false });
  });

  it("honours the retryable flag an app sets on an application-level rejection", () => {
    expect(classifyError(new UpstreamRejectedError("ratelimited", true))).toMatchObject({
      code: "upstream_error",
      retryable: true,
    });
    expect(classifyError(new UpstreamRejectedError("gone", false))).toMatchObject({
      code: "upstream_error",
      retryable: false,
    });
  });
});
