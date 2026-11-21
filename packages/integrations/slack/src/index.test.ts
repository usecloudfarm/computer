import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";
import { Slack, slack } from "./index.js";

/** Replaces global fetch so no test ever reaches the network. */
function mockFetch(handler: (request: Request) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(input, init)),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ok = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, ...body }), {
    headers: { "content-type": "application/json" },
  });

async function workspace() {
  const computer = new Computer({ apps: [slack({ apiKey: "xoxb-test-token-value-1234" })] });
  return computer.createWorkspace("u1");
}

afterEach(() => vi.unstubAllGlobals());

describe("Slack", () => {
  it("requires an api key", () => {
    expect(() => new Slack({ apiKey: "" })).toThrow(/needs an apiKey/);
  });

  it("exposes four capabilities with use cases for search", () => {
    const capabilities = slack({ apiKey: "x" }).capabilities();

    expect(capabilities.map((capability) => capability.name)).toEqual([
      "sendMessage",
      "listChannels",
      "searchMessages",
      "getThread",
    ]);
    for (const capability of capabilities) {
      expect(capability.useCases.length).toBeGreaterThan(0);
      expect(capability.example).toContain('run("slack.');
      // Code mode is synchronous; examples must not teach `await`.
      expect(capability.example).not.toContain("await");
    }
  });

  it("sends a message with the token applied by the host, not the handler", async () => {
    const seen: Request[] = [];
    mockFetch((request) => {
      seen.push(request);
      return ok({ ts: "1700000000.000100", channel: "C123" });
    });
    const ws = await workspace();

    const result = await ws.run("slack.sendMessage", { channel: "#general", text: "hi" });

    expect(result).toEqual({ ts: "1700000000.000100", channel: "C123" });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer xoxb-test-token-value-1234");
    expect(await seen[0]?.clone().json()).toEqual({ channel: "#general", text: "hi" });
  });

  it("maps Slack's 200-with-error into a thrown failure", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: "channel_not_found" })));
    const ws = await workspace();

    await expect(ws.run("slack.sendMessage", { channel: "#nope", text: "hi" })).rejects.toThrow(
      /channel_not_found/,
    );
  });

  it("validates arguments before any request is made", async () => {
    const spy = mockFetch(() => ok({}));
    const ws = await workspace();

    await expect(ws.run("slack.sendMessage", { channel: "#general" })).rejects.toThrow(
      /Invalid arguments/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("normalises the channel list and its cursor", async () => {
    mockFetch(() =>
      ok({
        channels: [{ id: "C1", name: "general", is_private: false }],
        response_metadata: { next_cursor: "page2" },
      }),
    );
    const ws = await workspace();

    expect(await ws.run("slack.listChannels", { limit: 1 })).toEqual({
      channels: [{ id: "C1", name: "general", isPrivate: false }],
      cursor: "page2",
    });
  });

  it("allows only Slack by default", () => {
    expect(slack({ apiKey: "x" }).allowedHosts).toEqual(["slack.com", "*.slack.com"]);
  });

  it("declares the host of a custom base url, since the host app chose it", () => {
    const proxied = slack({ apiKey: "x", baseUrl: "https://slack-proxy.internal/api" });

    expect(proxied.allowedHosts).toContain("slack-proxy.internal");
  });

  it("keeps the token out of anything the model can read", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ ok: false, error: "bad: xoxb-test-token-value-1234" })),
    );
    const computer = new Computer({
      apps: [slack({ apiKey: "xoxb-test-token-value-1234" })],
      secrets: ["xoxb-test-token-value-1234"],
    });
    const ws = await computer.createWorkspace("u1");

    const failure = await ws.run("slack.sendMessage", { channel: "#a", text: "b" }).catch((e) => e);

    expect(String(failure)).not.toContain("xoxb-test-token-value-1234");
    expect(String(failure)).toContain("redacted");
  });

  it("is discoverable by intent", async () => {
    const ws = await workspace();

    const { capabilities, types } = await ws.search("notify the team about a deploy");

    expect(capabilities[0]?.ref).toBe("slack.sendMessage");
    expect(types).toContain('declare function run(ref: "slack.sendMessage"');
    expect(types).toContain("no `await`");
  });
});
