import { describe, expect, it } from "vitest";
import { Computer, MemoryStorage, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
import wasmModule from "../../../rbash/vendor/rust_bash_bg.wasm";
import { rbashForWorkers } from "./workers.js";

/**
 * `curl` on workerd, which is the case that decided the design.
 *
 * An isolate cannot be blocked, so the usual sync-over-async trick —
 * `Atomics.wait` on a worker thread — is unavailable here. The shell instead
 * unwinds when it needs a response it does not have and is restarted once the
 * host has fetched it. These assertions are the proof that works where it has
 * to.
 */
const workspace = async (seed: Record<string, string> = {}) => {
  setTestDefaults({
    provider: rbashForWorkers(wasmModule as WebAssembly.Module, { network: true }),
  });
  return new Computer({ storage: new MemoryStorage({ seed }) }).createWorkspace("tester");
};

/** A host fetch that answers from a table, counting what it was asked for. */
function stubFetch() {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/next")) return new Response("/json", { status: 200 });
    if (url.endsWith("/json")) {
      return new Response('{"name":"cloudfarm","stars":42}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/boom")) return new Response("nope", { status: 500 });
    if (init?.method === "POST") return new Response(`got:${String(init.body)}`, { status: 201 });
    return new Response("hello from the host", { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("curl on workerd", () => {
  it("fetches, in an isolate that cannot be blocked", async () => {
    const net = stubFetch();
    const ws = await workspace();

    const result = await ws.exec("curl -s https://example.test/");

    expect(result.stdout).toBe("hello from the host");
    expect(result.exitCode).toBe(0);
    net.restore();
    resetDefaults();
  });

  it("carries a response into the next request", async () => {
    const net = stubFetch();
    const ws = await workspace();

    // The second URL is only known once the first has answered, so this can
    // only work if the run really does resume rather than being replayed
    // from a script the host pre-read.
    const result = await ws.exec(
      "p=$(curl -s https://example.test/next); curl -s https://example.test$p | jq -r .stars",
    );

    expect(result.stdout).toBe("42\n");
    expect(net.seen).toEqual(["GET https://example.test/next", "GET https://example.test/json"]);
    net.restore();
    resetDefaults();
  });

  it("issues each request exactly once, despite restarting the script", async () => {
    const net = stubFetch();
    const ws = await workspace();

    await ws.exec(
      "curl -s https://example.test/json > /data/a; " +
        "curl -s -X POST -d body https://example.test/post > /data/b; " +
        "curl -s https://example.test/ > /data/c",
    );

    // The run restarts once per request, so a replay that re-issued them
    // would show six here — and would have posted twice.
    expect(net.seen).toEqual([
      "GET https://example.test/json",
      "POST https://example.test/post",
      "GET https://example.test/",
    ]);
    net.restore();
    resetDefaults();
  });

  it("keeps the writes of the run that finished, and none from the restarts", async () => {
    const net = stubFetch();
    const ws = await workspace();

    await ws.exec(
      "echo one >> /data/log; curl -s https://example.test/ > /dev/null; echo two >> /data/log",
    );

    // `echo one` runs on every attempt; the filesystem is rolled back
    // between them, so it lands exactly once.
    expect(await ws.fs.readText("/log")).toBe("one\ntwo\n");
    net.restore();
    resetDefaults();
  });

  it("reports a failure as a non-zero exit rather than taking the script down", async () => {
    const net = stubFetch();
    const ws = await workspace();

    const result = await ws.exec('curl -sf https://example.test/boom; echo "still here"');

    expect(result.stdout).toContain("still here");
    expect(result.stderr).toMatch(/500/);
    net.restore();
    resetDefaults();
  });

  it("has no curl at all when network is off", async () => {
    setTestDefaults({ provider: rbashForWorkers(wasmModule as WebAssembly.Module) });
    const ws = await new Computer({ storage: new MemoryStorage() }).createWorkspace("t");

    const result = await ws.exec("curl https://example.test/");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/command not found/);
    resetDefaults();
  });
});
