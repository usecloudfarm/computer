import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiKey, basic, defineAuth, noAuth, oauth } from "./auth.js";
import { createAction, createApp } from "./define.js";
import { Computer } from "./computer.js";
import { MemoryStorage } from "./vfs.js";

const ping = () =>
  createAction({
    summary: "Fetch the current user.",
    useCases: ["who am i", "check the token"],
    sideEffects: "read",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    example: "{}",
    handler: async (_input, context) => context.http.get<{ ok: boolean }>("me"),
  });

const sign = (scheme: Parameters<typeof build>[0], input: unknown) =>
  build(scheme)(input as never).authorize(new Request("https://api.test/thing"));

function build(scheme: ReturnType<typeof apiKey>) {
  return createApp({
    id: "demo",
    description: "A demo app.",
    auth: scheme,
    http: () => ({ baseUrl: "https://api.test" }),
    actions: { ping: ping() },
  });
}

describe("apiKey", () => {
  it("signs with a bearer header by default", () => {
    expect(sign(apiKey(), { apiKey: "k-123" }).headers.get("authorization")).toBe("Bearer k-123");
  });

  it("sends the raw key when the API wants no prefix", () => {
    const app = createApp({
      id: "demo",
      description: "A demo app.",
      auth: apiKey({ prefix: "" }),
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({ apiKey: "k-123" });

    expect(app.authorize(new Request("https://api.test/x")).headers.get("authorization")).toBe(
      "k-123",
    );
  });

  it("can place the key in a header other than authorization", () => {
    const app = createApp({
      id: "demo",
      description: "A demo app.",
      auth: apiKey({ header: "x-api-key", prefix: "" }),
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({ apiKey: "k-123" });

    expect(app.authorize(new Request("https://api.test/x")).headers.get("x-api-key")).toBe("k-123");
  });

  it("can place the key in the query string, preserving existing parameters", () => {
    const app = createApp({
      id: "demo",
      description: "A demo app.",
      auth: apiKey({ query: "token" }),
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({ apiKey: "k-123" });

    const url = new URL(app.authorize(new Request("https://api.test/x?page=2")).url);
    expect(url.searchParams.get("token")).toBe("k-123");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("rejects a missing key at construction, not at first request", () => {
    expect(() => build(apiKey())({ apiKey: "" } as never)).toThrow(/invalid credentials/);
  });
});

describe("basic", () => {
  it("encodes the pair, including non-latin1 characters", () => {
    const app = createApp({
      id: "demo",
      description: "A demo app.",
      auth: basic(),
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({ username: "ada", password: "pâssword" });

    const header = app.authorize(new Request("https://api.test/x")).headers.get("authorization");
    expect(header).toMatch(/^Basic /);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header!.slice(6)), (c) => c.codePointAt(0)!),
    );
    expect(decoded).toBe("ada:pâssword");
  });
});

const oauthApp = (input: Record<string, unknown>) =>
  createApp({
    id: "demo",
    description: "A demo app.",
    auth: oauth(),
    allowedHosts: () => ["api.test"],
    actions: { ping: ping() },
  })(input as never);

describe("oauth", () => {
  it("signs with the access token", () => {
    expect(
      oauthApp({ accessToken: "at-1" })
        .authorize(new Request("https://api.test/x"))
        .headers.get("authorization"),
    ).toBe("Bearer at-1");
  });

  it("accepts a refresh token and expiry as part of the stored shape", () => {
    expect(() =>
      oauthApp({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 60_000 }),
    ).not.toThrow();
  });

  it("fails loudly on an expired token rather than letting it 401", () => {
    const expired = oauthApp({ accessToken: "at-1", expiresAt: Date.now() - 1 });
    expect(() => expired.authorize(new Request("https://api.test/x"))).toThrow(/expired/);
  });
});

describe("noAuth", () => {
  it("builds an app that signs nothing", () => {
    const app = createApp({
      id: "demo",
      description: "A public API.",
      auth: noAuth(),
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({});

    expect(
      app.authorize(new Request("https://api.test/x")).headers.get("authorization"),
    ).toBeNull();
  });
});

describe("a custom scheme", () => {
  it("can transform the developer's input into a different stored credential", () => {
    const scheme = defineAuth({
      kind: "team-token",
      input: z.object({ team: z.string(), secret: z.string() }),
      credentials: z.object({ token: z.string() }),
      toCredentials: ({ team, secret }) => ({ token: `${team}:${secret}` }),
      authorize: (request, { token }) => {
        const signed = new Request(request);
        signed.headers.set("authorization", `Token ${token}`);
        return signed;
      },
    });

    const app = createApp({
      id: "demo",
      description: "A demo app.",
      auth: scheme,
      allowedHosts: () => ["api.test"],
      actions: { ping: ping() },
    })({ team: "eng", secret: "s3cret" });

    expect(app.authorize(new Request("https://api.test/x")).headers.get("authorization")).toBe(
      "Token eng:s3cret",
    );
    expect(app.auth?.kind).toBe("team-token");
  });
});

describe("auth through a Computer", () => {
  it("signs a real action's request without the handler ever seeing the token", async () => {
    const seen: Request[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request);
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;

    try {
      const computer = new Computer({
        storage: new MemoryStorage(),
        apps: [build(apiKey())({ apiKey: "k-secret" })],
      });
      const workspace = await computer.createWorkspace("u");
      const result = await workspace.run("demo.ping", {});

      expect(result).toEqual({ status: "ok", value: { ok: true } });
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer k-secret");
      expect(JSON.stringify(result)).not.toContain("k-secret");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("merges the auth input with the options schema in one parameter", () => {
    const factory = createApp({
      id: "demo",
      description: "A demo app.",
      auth: apiKey(),
      options: z.object({ baseUrl: z.string().url().optional() }),
      http: ({ baseUrl }) => ({ baseUrl: baseUrl ?? "https://api.test" }),
      actions: { ping: ping() },
    });

    expect(factory({ apiKey: "k" }).allowedHosts).toContain("api.test");
    expect(factory({ apiKey: "k", baseUrl: "https://proxy.test/v1" }).allowedHosts).toContain(
      "proxy.test",
    );
  });

  it("refuses an app that both declares a scheme and signs by hand", () => {
    expect(() =>
      createApp({
        id: "demo",
        description: "A demo app.",
        auth: apiKey(),
        authorize: (request) => request,
        allowedHosts: () => ["api.test"],
        actions: { ping: ping() },
      }),
    ).toThrow(/both auth and authorize/);
  });
});
