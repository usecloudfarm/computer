import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";
import { agent37 } from "./index.js";

const KEY = "sk_live_test";

function mockFetch(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return new Response(JSON.stringify(handler(url, body)), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const lifecycle = (url: string) =>
  url.endsWith("/instances") ? { id: "ab12cd34ef" } : { exitCode: 0, stdout: "hi\n", stderr: "" };

afterEach(() => vi.unstubAllGlobals());

describe("agent37", () => {
  it("requires an api key", () => {
    expect(() => agent37({ apiKey: "" })).toThrow(/needs an apiKey/);
  });

  it("creates a machine, runs a command and reports the result", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    const result = await ws.exec("echo hi");

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "hi\n" });
    // Two planes: the control API creates, the machine itself execs.
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://api.agent37.com/v1/instances");
    expect(String(spy.mock.calls[1]?.[0])).toBe(
      "https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec",
    );
  });

  it("sends the key in Agent37's own header, not as a bearer token", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("echo hi");

    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Agent37-Key"]).toBe(KEY);
    expect(headers["authorization"]).toBeUndefined();
  });

  it("creates one machine for many commands", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("one");
    await ws.exec("two");

    // One create, two commands — a second machine would bill twice over.
    const creates = spy.mock.calls.filter((call) => String(call[0]).endsWith("/instances"));
    expect(creates).toHaveLength(1);
  });

  it("turns a non-zero exit into a failed result rather than throwing", async () => {
    mockFetch((url) =>
      url.endsWith("/instances")
        ? { id: "ab12cd34ef" }
        : { exitCode: 2, stdout: "", stderr: "boom" },
    );
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    expect(await ws.exec("false")).toMatchObject({
      status: "failed",
      exitCode: 2,
      stderr: "boom",
    });
  });

  it("runs a command in a working directory by prefixing a cd", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("ls", { cwd: "/srv/my app" });

    const init = spy.mock.calls[1]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { command: string };
    // Quoted, or a directory with a space would split into two arguments.
    expect(sent.command).toBe("cd '/srv/my app' && ls");
  });

  it("reports a timed-out command with a null exit code, not a zero", async () => {
    mockFetch((url) =>
      url.endsWith("/instances")
        ? { id: "ab12cd34ef" }
        : { exitCode: 0, stdout: "", stderr: "", timedOut: true },
    );
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    // Reporting 0 would read as success everywhere downstream.
    expect(await ws.exec("sleep 99")).toMatchObject({ status: "failed", exitCode: null });
  });

  it("reports an HTTP failure with the status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no credits", { status: 402 })),
    );
    const ws = await new Computer({ provider: agent37({ apiKey: KEY }) }).createWorkspace("u");

    await expect(ws.exec("echo hi")).rejects.toThrow(/402.*no credits/s);
  });
});
