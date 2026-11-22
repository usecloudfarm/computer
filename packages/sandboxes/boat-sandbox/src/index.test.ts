import { afterEach, describe, expect, it, vi } from "vitest";
import { Computer } from "@cloudfarm/core";
import { boat } from "./index.js";

const KEY = "boat_test_key";

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
  url.endsWith("/sandboxes")
    ? { sandbox: { id: "bx_1" } }
    : { exitCode: 0, stdout: "hi\n", stderr: "" };

afterEach(() => vi.unstubAllGlobals());

describe("boat", () => {
  it("requires an api key", () => {
    expect(() => boat({ apiKey: "" })).toThrow(/needs an apiKey/);
  });

  it("creates a machine, runs a command and reports the result", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    const result = await ws.exec("echo hi");

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "hi\n" });
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://boat.dev/api/v1/sandboxes");
    expect(String(spy.mock.calls[1]?.[0])).toBe("https://boat.dev/api/v1/sandboxes/bx_1/commands");
  });

  it("sends the key as a bearer token", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("echo hi");

    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("creates one machine for many commands", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("one");
    await ws.exec("two");

    // One create, two commands — a second machine would bill twice over.
    const creates = spy.mock.calls.filter((call) => String(call[0]).endsWith("/sandboxes"));
    expect(creates).toHaveLength(1);
  });

  it("turns a non-zero exit into a failed result rather than throwing", async () => {
    mockFetch((url) =>
      url.endsWith("/sandboxes")
        ? { sandbox: { id: "bx_1" } }
        : { exitCode: 2, stdout: "", stderr: "boom" },
    );
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    expect(await ws.exec("false")).toMatchObject({
      status: "failed",
      exitCode: 2,
      stderr: "boom",
    });
  });

  it("runs a command in a working directory by prefixing a cd", async () => {
    const spy = mockFetch(lifecycle);
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    await ws.exec("ls", { cwd: "/srv/my app" });

    const init = spy.mock.calls[1]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as { command: string };
    // Quoted, or a directory with a space would split into two arguments.
    expect(sent.command).toBe("cd '/srv/my app' && ls");
  });

  it("reports an HTTP failure with the status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no credits", { status: 402 })),
    );
    const ws = await new Computer({ provider: boat({ apiKey: KEY }) }).createWorkspace("u");

    await expect(ws.exec("echo hi")).rejects.toThrow(/402.*no credits/s);
  });
});
