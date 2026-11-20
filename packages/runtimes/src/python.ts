import { DEFAULT_LIMITS } from "@unsandbox/sandbox-core";
import type {
  RunEvent,
  RunOutcome,
  RunRequest,
  RuntimeAvailability,
  SandboxRuntime,
} from "@unsandbox/sandbox-core";
import { poolFor } from "./worker-pool.js";

/**
 * CPython, compiled to WebAssembly by Pyodide.
 *
 * This is the real CPython interpreter - not a reimplementation - so the
 * stdlib, C-level semantics and tracebacks are the genuine article.
 *
 * It lives in a warm worker for two reasons: the interpreter loads once
 * (~1s) and is reused, which is what makes it usable interactively, and
 * because Python executes synchronously, so only terminating the thread can
 * stop `while True: pass`. Each run gets a fresh globals dict, so imports
 * stay cached while user state does not leak between runs.
 */
export const pythonRuntime: SandboxRuntime = {
  id: "cpython",
  label: "CPython",
  language: "python",
  isolation: "wasm",
  description:
    "Real CPython 3.14 in WebAssembly via Pyodide. Full stdlib, warm interpreter, no host access.",
  defaultEntry: "/work/main.py",
  editorLanguage: "python",

  async available(): Promise<RuntimeAvailability> {
    try {
      // Resolving the package is enough; loading happens in the worker so the
      // availability probe never blocks the server for a second.
      const { version } = await import("pyodide");
      return {
        ok: true,
        detail: `Pyodide ${version ?? ""} (CPython on wasm32)`.replace("  ", " ").trim(),
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },

  async run(request: RunRequest, emit: (event: RunEvent) => void): Promise<RunOutcome> {
    const result = await poolFor("cpython").run(
      {
        code: request.code,
        files: request.files,
        entry: request.entryPath ?? pythonRuntime.defaultEntry,
        limits: { ...DEFAULT_LIMITS, ...request.limits },
      },
      emit,
    );
    return { files: result.files };
  },
};
