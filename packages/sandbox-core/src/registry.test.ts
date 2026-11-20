import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistry, runWithGuards } from "./registry.js";
import type { RunEvent, SandboxRuntime } from "./types.js";

function fakeRuntime(overrides: Partial<SandboxRuntime> = {}): SandboxRuntime {
  return {
    id: "fake",
    label: "Fake",
    language: "javascript",
    isolation: "wasm",
    description: "test double",
    defaultEntry: "/work/main.js",
    editorLanguage: "javascript",
    available: async () => ({ ok: true }),
    run: async (request) => ({ files: request.files }),
    ...overrides,
  };
}

describe("RuntimeRegistry", () => {
  it("registers and looks up runtimes", () => {
    const registry = new RuntimeRegistry([fakeRuntime()]);

    expect(registry.get("fake").label).toBe("Fake");
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects duplicate ids and unknown lookups", () => {
    const registry = new RuntimeRegistry([fakeRuntime()]);

    expect(() => registry.register(fakeRuntime())).toThrow(/already registered/);
    expect(() => registry.get("nope")).toThrow(/Unknown runtime "nope". Known: fake/);
  });
});

describe("runWithGuards", () => {
  it("emits a terminal exit even when the runtime emits nothing", async () => {
    const events: RunEvent[] = [];

    await runWithGuards(fakeRuntime(), { code: "", files: {} }, (event) => events.push(event));

    expect(events).toEqual([{ type: "exit", code: 0, durationMs: expect.any(Number) }]);
  });

  it("turns a thrown error into error + exit 1", async () => {
    const events: RunEvent[] = [];
    const runtime = fakeRuntime({
      run: async () => {
        throw new Error("engine exploded");
      },
    });

    const outcome = await runWithGuards(runtime, { code: "", files: { "/a": "1" } }, (event) =>
      events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual(["error", "exit"]);
    expect(events[0]).toMatchObject({ message: "engine exploded" });
    // The workspace is handed back untouched so the client stays consistent.
    expect(outcome.files).toEqual({ "/a": "1" });
  });

  it("stops a runtime that never returns", async () => {
    const events: RunEvent[] = [];
    const runtime = fakeRuntime({ run: () => new Promise(() => {}) });

    await runWithGuards(runtime, { code: "", files: {}, limits: { timeoutMs: 20 } }, (event) =>
      events.push(event),
    );

    expect(events[0]).toMatchObject({ type: "error", message: /exceeded the 20ms time limit/ });
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 1 });
  });

  it("fills in default limits before calling the runtime", async () => {
    const run = vi.fn(async (request: Parameters<SandboxRuntime["run"]>[0]) => ({
      files: request.files,
    }));

    await runWithGuards(fakeRuntime({ run }), { code: "", files: {} }, () => {});

    expect(run.mock.calls[0]?.[0].limits).toEqual({
      timeoutMs: 10_000,
      memoryBytes: 128 * 1024 * 1024,
    });
  });

  it("ignores extra terminal events from a chatty runtime", async () => {
    const events: RunEvent[] = [];
    const runtime = fakeRuntime({
      run: async (request, emit) => {
        emit({ type: "exit", code: 0, durationMs: 1 });
        emit({ type: "exit", code: 7, durationMs: 2 });
        return { files: request.files };
      },
    });

    await runWithGuards(runtime, { code: "", files: {} }, (event) => events.push(event));

    expect(events).toEqual([{ type: "exit", code: 0, durationMs: 1 }]);
  });
});
