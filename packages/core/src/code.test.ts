import { describe, expect, it, vi } from "vitest";
import { buildPrelude, CapabilityBridge, finishResult, resolveLimits } from "./code.js";
import { Redactor } from "./redact.js";
import type { HostCallRequest } from "./schemas.js";

const bindings = {
  namespaces: new Map([
    ["slack", ["sendMessage", "listChannels"]],
    ["gmail", ["sendEmail"]],
    ["fs", ["read", "write"]],
  ]),
  functions: ["bash"],
};

function bridge(
  options: {
    invoke?: (ref: string, args: unknown) => Promise<unknown>;
    limits?: Partial<ReturnType<typeof resolveLimits>>;
  } = {},
) {
  const redactor = new Redactor();
  return new CapabilityBridge({
    invoke: (options.invoke ?? (async () => ({ ok: true }))) as never,
    limits: resolveLimits(options.limits),
    redactor,
  });
}

const request = (
  seq: number,
  capability = "slack.sendMessage",
  args: unknown = {},
): HostCallRequest => ({
  v: 1,
  seq,
  capability,
  args: args as never,
});

describe("buildPrelude", () => {
  it("binds one object per app with a method per capability", () => {
    const prelude = buildPrelude(bindings);

    expect(prelude).toContain("const slack = {");
    expect(prelude).toContain('sendMessage: (input) => __host("slack.sendMessage", input)');
    expect(prelude).toContain("const gmail = {");
  });

  it("binds the workspace filesystem and shell alongside the apps", () => {
    const prelude = buildPrelude(bindings);

    expect(prelude).toContain('read: (input) => __host("fs.read", input)');
    // bash has no member, so it binds as a plain function.
    expect(prelude).toContain('const bash = (input) => __host("bash", input);');
  });

  it("replaces fetch and require with explanatory throws", () => {
    const prelude = buildPrelude(bindings);

    expect(prelude).toContain("fetch is unavailable in code mode");
    expect(prelude).toContain("require is unavailable in code mode");
  });

  it("is deterministic", () => {
    expect(buildPrelude(bindings)).toBe(buildPrelude(bindings));
  });
});

describe("CapabilityBridge", () => {
  it("forwards a call and records it", async () => {
    const invoke = vi.fn(async () => ({ ts: "1" }));
    const host = bridge({ invoke });

    const response = await host.call(request(0), new AbortController().signal);

    expect(response).toMatchObject({ ok: true, value: { ts: "1" } });
    expect(invoke).toHaveBeenCalledWith("slack.sendMessage", {});
    expect(host.calls).toEqual([
      { capability: "slack.sendMessage", ok: true, durationMs: expect.any(Number) },
    ]);
  });

  it("never throws: a handler error becomes an error frame", async () => {
    const host = bridge({
      invoke: async () => {
        throw new Error("upstream exploded");
      },
    });

    const response = await host.call(request(0), new AbortController().signal);

    expect(response).toMatchObject({
      ok: false,
      error: { code: "internal", message: "upstream exploded" },
    });
    // The failed call is still recorded, so partial work is visible.
    expect(host.calls[0]).toMatchObject({ ok: false });
  });

  it("stops at the host call limit and reports which limit was hit", async () => {
    const host = bridge({ limits: { maxHostCalls: 2 } });
    const signal = new AbortController().signal;

    await host.call(request(0), signal);
    await host.call(request(1), signal);
    const third = await host.call(request(2), signal);

    expect(third).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect([...host.limitsHit]).toContain("maxHostCalls");
  });

  it("truncates an oversized single result rather than dropping it", async () => {
    const host = bridge({
      invoke: async () => ({ blob: "x".repeat(5000) }),
      limits: { maxResultBytes: 500 },
    });

    const response = await host.call(request(0), new AbortController().signal);

    expect(response).toMatchObject({ ok: true, truncated: true });
    expect([...host.limitsHit]).toContain("maxResultBytes");
  });

  it("rejects out-of-order frames", async () => {
    const host = bridge();
    const response = await host.call(request(7), new AbortController().signal);

    expect(response).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("refuses to run once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = await bridge().call(request(0), controller.signal);

    expect(response).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("redacts secrets from returned values", async () => {
    const redactor = new Redactor();
    redactor.add("top-secret-token");
    const host = new CapabilityBridge({
      invoke: (async () => ({ echoed: "top-secret-token" })) as never,
      limits: resolveLimits(),
      redactor,
    });

    const response = await host.call(request(0), new AbortController().signal);

    expect(response).toMatchObject({ ok: true, value: { echoed: "[redacted]" } });
  });

  it("caps log volume", async () => {
    const host = bridge({ limits: { maxLogBytes: 20 } });

    host.log("log", ["a".repeat(10)]);
    host.log("log", ["b".repeat(100)]);

    expect(host.logs).toBe("a".repeat(10));
    expect([...host.limitsHit]).toContain("maxLogBytes");
  });
});

describe("finishResult", () => {
  it("merges bridge limits with engine limits and sorts them", () => {
    const host = bridge({ limits: { maxHostCalls: 1 } });
    host.limitsHit.add("maxResultBytes");

    const result = finishResult({
      status: "timeout",
      bridge: host,
      durationMs: 5,
      redactor: new Redactor(),
      extraLimits: ["cpuTimeoutMs"],
    });

    expect(result.limitsHit).toEqual(["cpuTimeoutMs", "maxResultBytes"]);
    expect(result.status).toBe("timeout");
  });

  it("applies defaults for every unset limit", () => {
    expect(resolveLimits({ maxHostCalls: 3 })).toMatchObject({
      maxHostCalls: 3,
      timeoutMs: 15_000,
      cpuTimeoutMs: 5_000,
    });
  });
});
